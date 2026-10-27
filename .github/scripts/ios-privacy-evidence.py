#!/usr/bin/env python3
"""READ-ONLY privacy evidence for the unsigned iOS job (jc-privacy #32039). Writes markdown to $GITHUB_STEP_SUMMARY and
the identical report to stdout between markers. Never edits a file, makes no network call, never fails the job
(always exits 0): output is evidence, not a gate.
Part (a): every PrivacyInfo.xcprivacy in built products and resolved SwiftPM checkouts (path, sha256, declared types).
Part (b): file:line hits for the required-reason API families vs the app manifest's declared reasons.
Part (c): imported symbols (nm -u) and strings of the built App.app executables vs the manifest, plus SwiftPM pin coverage.
Hostile-input rules (sgt-b1 #32089): every value and path is escaped before printing (control chars, newlines and
< > & ` | [ ] are neutralised); every report line is indented so none can start with '::'; the stdout block sits under a
random-token ::stop-commands::; only regular, non-symlink, size-capped files are opened (no FIFO/device hang); walks
are bounded in depth, file count and time; one bad file never aborts the report."""
import glob, hashlib, json, os, plistlib, re, secrets, shutil, stat, subprocess, sys, time, traceback

MAX_LINES = 400
MAX_PLIST_BYTES = 1024 * 1024
MAX_SRC_BYTES = 2 * 1024 * 1024
MAX_FILES = 20000
MAX_BIN_BYTES = 300 * 1024 * 1024
MAX_TOOL_BYTES = 30 * 1024 * 1024
TOOL_TIMEOUT = 20
MAX_DEPTH = 12
DEADLINE = time.monotonic() + 150
BEGIN = "=== IOS-PRIVACY-EVIDENCE BEGIN ==="
END = "=== IOS-PRIVACY-EVIDENCE END ==="

_SUBST = {"&": "&amp;", "<": "&lt;", ">": "&gt;", "`": "&#96;", "|": "&#124;", "[": "&#91;", "]": "&#93;"}


def esc(v, limit=300):
    """Printable, single-line, markdown/HTML-inert text for ANY value or path."""
    s = v if isinstance(v, str) else repr(v)
    s = "".join("?" if (ord(c) < 32 or ord(c) in (127, 0x85, 0x2028, 0x2029) or 0x80 <= ord(c) < 0xA0) else _SUBST.get(c, c) for c in s)
    return s[:limit] + ("..." if len(s) > limit else "")


def regular(p, cap):
    """True only for a real regular file (not a symlink, FIFO, device) within the size cap."""
    try:
        st = os.lstat(p)
        return stat.S_ISREG(st.st_mode) and st.st_size <= cap
    except OSError:
        return False


def safe_walk(root, prune=None):
    """Bounded os.walk: never follows symlinks, depth/file/time capped. Yields (dir, subdirs, files)."""
    n = 0
    base = root.rstrip(os.sep).count(os.sep)
    for d, ds, fs in os.walk(root, followlinks=False):
        if time.monotonic() > DEADLINE:
            return
        ds[:] = sorted(x for x in ds if not os.path.islink(os.path.join(d, x)) and not (prune and prune(d, x)))
        if d.count(os.sep) - base >= MAX_DEPTH:
            ds[:] = []
        n += len(fs)
        if n > MAX_FILES:
            return
        yield d, ds, fs


def find_manifests(roots):
    hits = set()
    for r in roots:
        if r and os.path.isdir(r) and not os.path.islink(r):
            for d, _, fs in safe_walk(r):
                if "PrivacyInfo.xcprivacy" in fs:
                    p = os.path.join(d, "PrivacyInfo.xcprivacy")
                    if regular(p, MAX_PLIST_BYTES):
                        hits.add(p)
    return sorted(hits)


def sha(p):
    try:
        with open(p, "rb") as fh:
            return hashlib.sha256(fh.read(MAX_PLIST_BYTES + 1)).hexdigest()
    except OSError as e:
        return "unreadable:" + esc(e, 60)


def parse(p):
    """-> (dict, None) or (None, error text). Never raises."""
    if not regular(p, MAX_PLIST_BYTES):
        return None, "not a regular file within the 1 MB cap (symlink, FIFO, device or too large)"
    try:
        with open(p, "rb") as fh:
            d = plistlib.load(fh)
    except Exception as e:
        return None, "parse error: " + esc(e, 120)
    if not isinstance(d, dict):
        return None, "plist root is %s, not a dict" % type(d).__name__
    return d, None


def dicts(d, key):
    v = d.get(key)
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def strs(v):
    return [esc(x, 80) for x in v] if isinstance(v, list) else []


def describe(p):
    d, err = parse(p)
    if err:
        return esc(err)
    ct = [esc(x.get("NSPrivacyCollectedDataType"), 80) for x in dicts(d, "NSPrivacyCollectedDataTypes")]
    api = ["%s:%s" % (esc(str(x.get("NSPrivacyAccessedAPIType", "?")).replace("NSPrivacyAccessedAPICategory", ""), 60),
                      ",".join(strs(x.get("NSPrivacyAccessedAPITypeReasons")))) for x in dicts(d, "NSPrivacyAccessedAPITypes")]
    return "; ".join(["NSPrivacyTracking=%s" % esc(d.get("NSPrivacyTracking"), 20),
                      "tracking domains=%s" % (strs(d.get("NSPrivacyTrackingDomains")) or "none"),
                      "collected=%s" % (ct or "none"), "accessed APIs=%s" % (api or "none")])


_SKIP_EXACT = re.compile(r"^(tests?|__tests__|\.build|Pods|xcuserdata)$", re.I)
_SKIP_TESTS_SUFFIX = re.compile(r"^\w*Tests?$")  # whole segment, capital T: AppTests, FooTest; never Latest/Contests/attest


def skip_dir(name):
    return bool(_SKIP_EXACT.match(name) or _SKIP_TESTS_SUFFIX.match(name))


def discover(roots):
    """Find built .app bundles (Build/Products/<cfg>/X.app) and SourcePackages/checkouts dirs, bounded and symlink-safe."""
    apps, checkouts = set(), set()
    for r in roots:
        if not (r and os.path.isdir(r) and not os.path.islink(r)):
            continue
        for d, ds, _ in safe_walk(r):
            for x in list(ds):
                full = os.path.join(d, x)
                if x.endswith(".app") and os.path.basename(os.path.dirname(os.path.dirname(full))) == "Products":
                    apps.add(full)
                if x == "checkouts" and os.path.basename(d) == "SourcePackages":
                    checkouts.add(full)
            ds[:] = [x for x in ds if not x.endswith(".app") and x != "checkouts"]
    return sorted(apps), sorted(checkouts)


def run_tool(tool, f, args):
    """Run an absolute-path tool on one file: list args, no shell, timeout, output cap. -> (text, None) or (None, reason)."""
    exe = shutil.which(tool)
    if not exe:
        return None, "tool not found"
    try:
        r = subprocess.run([exe] + args + [f], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=TOOL_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError as e:
        return None, "error " + esc(e, 60)
    if r.returncode != 0:
        return None, "exit %d" % r.returncode
    return r.stdout[:MAX_TOOL_BYTES].decode("utf-8", "replace"), None


# (family, manifest category, regex on one `nm -u` symbol, regex over `strings -a` text). A hit means "referenced", not "called".
BIN_FAMILIES = [
    ("UserDefaults", "NSPrivacyAccessedAPICategoryUserDefaults",
     re.compile(r"UserDefaults"), re.compile(r"NSUserDefaults|standardUserDefaults|UserDefaults")),
    ("File timestamp", "NSPrivacyAccessedAPICategoryFileTimestamp",
     re.compile(r"^_?(?:stat|fstat|lstat|getattrlist|fgetattrlist|getattrlistbulk)(?:\$\w+)?$|NSFileCreationDate|NSFileModificationDate|NSURLContentModificationDateKey|NSURLCreationDateKey"),
     re.compile(r"NSFileCreationDate|NSFileModificationDate|NSURLContentModificationDateKey|NSURLCreationDateKey|\bcreationDate\b|\bmodificationDate\b|\bf?getattrlist(?:bulk)?\b")),
    ("System boot time", "NSPrivacyAccessedAPICategorySystemBootTime",
     re.compile(r"^_?(?:mach_absolute_time|mach_continuous_time|clock_gettime|clock_gettime_nsec_np|sysctl|sysctlbyname)$|systemUptime"),
     re.compile(r"systemUptime|mach_absolute_time|mach_continuous_time|CLOCK_MONOTONIC_RAW|CLOCK_UPTIME_RAW|kern\.boottime|\bsysctlbyname\b")),
    ("Disk space", "NSPrivacyAccessedAPICategoryDiskSpace",
     re.compile(r"^_?(?:statfs|fstatfs|statvfs|fstatvfs)(?:\$\w+)?$|NSFileSystemFreeSize|NSFileSystemSize|NSURLVolume(?:Available|Total)Capacity"),
     re.compile(r"NSFileSystemFreeSize|NSFileSystemSize|NSURLVolume(?:Available|Total)Capacity\w*|volumeAvailableCapacity\w*|\bf?statfs\b|\bf?statvfs\b")),
    ("Active keyboards", "NSPrivacyAccessedAPICategoryActiveKeyboards",
     re.compile(r"activeInputModes"), re.compile(r"activeInputModes")),
]


_NM_LINE = re.compile(r"^\s*(?:[0-9a-fA-F]+\s+)?[A-Za-z]\s+(.*)$")  # [addr] <type letter> <symbol>


def scan_binary(f):
    """-> ({family: [escaped names]}, notes). Never raises."""
    found = {b[0]: {} for b in BIN_FAMILIES}
    notes = []
    nm_out, nm_err = run_tool("nm", f, ["-u"])
    st_out, st_err = run_tool("strings", f, ["-a"])
    if nm_err:
        notes.append("nm: " + nm_err)
    if st_err:
        notes.append("strings: " + st_err)
    if nm_out:
        for line in nm_out.splitlines():
            m = _NM_LINE.match(line)
            tok = m.group(1).strip() if m else line.strip()
            if not tok:
                continue
            for name, _, nrx, _ in BIN_FAMILIES:
                if len(found[name]) < 40 and nrx.search(tok):
                    found[name][esc(tok, 120)] = 1
    if st_out:
        for name, _, _, srx in BIN_FAMILIES:
            for m in srx.finditer(st_out):
                if len(found[name]) >= 40:
                    break
                found[name][esc(m.group(0), 80)] = 1
    return {k: list(v) for k, v in found.items()}, notes, (nm_err is None or st_err is None)


def main():
    HOME = os.path.expanduser("~")
    ROOT = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
    DD = [os.environ.get("DERIVED_DATA", ""), os.path.join(HOME, "Library/Developer/Xcode/DerivedData")]
    head = []
    secs = []  # [name, line budget, lines]: one noisy section can never push another out of the 400-line cap

    def begin(name, budget):
        secs.append([name, budget, []])

    def w(s=""):
        (secs[-1][2] if secs else head).append(s)

    def rel(p):
        return esc(os.path.relpath(p, ROOT) if p.startswith(ROOT) else p)

    def table(title, paths, base=None):
        w("### " + title)
        if not paths:
            w("_none found_")
        if len(paths) > 15:
            w("... %d more manifests not listed (cap 15 per section)" % (len(paths) - 15))
        for p in paths[:15]:
            try:
                w("- `%s`  sha256 `%s`" % (esc(os.path.relpath(p, base) if base else p), sha(p)))
                w("  - " + describe(p))
            except Exception as e:
                w("  - entry skipped: " + esc(e, 100))
        w()

    w("## READ-ONLY privacy evidence (jc-privacy #32039) - non-blocking, not a gate")
    w("Generated by .github/scripts/ios-privacy-evidence.py after the simulator compile. Nothing here edits a manifest.")
    w("All values and paths below are escaped; a character shown as ? was a control character.")
    w()
    begin("a", 120)
    w("### (a) PrivacyInfo.xcprivacy inventory")
    w()
    apps, checkouts = discover(DD + [os.path.join(ROOT, "mobile/ios")])
    w("Built .app bundles found: %s" % (", ".join("`%s`" % esc(a) for a in apps) or "none (derived data not located)"))
    w()
    table("Inside the built simulator .app (incl. embedded frameworks)", find_manifests(apps))
    table("SwiftPM resolved checkouts", find_manifests(checkouts))
    table("Source tree and node_modules (plugin packages)", find_manifests([os.path.join(ROOT, "mobile/node_modules"), os.path.join(ROOT, "mobile/ios")]), ROOT)

    FAMILIES = [
        ("UserDefaults", "NSPrivacyAccessedAPICategoryUserDefaults", "CA92.1", r"\b(NS)?UserDefaults\b"),
        ("File timestamp", "NSPrivacyAccessedAPICategoryFileTimestamp", "C617.1",
         r"\b(creationDate|modificationDate|fileModificationDate|fileCreationDate|NSFileCreationDate|NSFileModificationDate|"
         r"contentModificationDate|creationDateKey|contentModificationDateKey|contentAccessDateKey|f?l?stat|getattrlist|fgetattrlist|getattrlistbulk)\b"),
        ("System boot time", "NSPrivacyAccessedAPICategorySystemBootTime", "35F9.1",
         r"\b(systemUptime|mach_absolute_time|clock_gettime_nsec_np|kern\.boottime)\b"),
        ("Disk space", "NSPrivacyAccessedAPICategoryDiskSpace", "E174.1",
         r"\b(volumeAvailableCapacity\w*|volumeTotalCapacity\w*|NSFileSystemFreeSize|NSFileSystemSize|systemFreeSize|statfs|fstatfs|statvfs|fstatvfs)\b"),
        ("Active keyboards", "NSPrivacyAccessedAPICategoryActiveKeyboards", "54BD.1", r"\bactiveInputModes\b"),
    ]
    SRC = re.compile(r"\.(swift|m|mm|h|c|cpp)$")
    roots = [os.path.join(ROOT, "mobile/ios/App/App")]
    roots += sorted(glob.glob(os.path.join(ROOT, "mobile/node_modules/*/ios")) + glob.glob(os.path.join(ROOT, "mobile/node_modules/@*/*/ios")))
    roots += checkouts
    hits = {f[0]: [] for f in FAMILIES}
    scanned = 0
    for r in roots:
        if not os.path.isdir(r) or os.path.islink(r):
            continue
        for d, _, fs in safe_walk(r, prune=lambda _d, x: skip_dir(x)):
            for f in sorted(fs):
                p = os.path.join(d, f)
                if not SRC.search(f) or not regular(p, MAX_SRC_BYTES):
                    continue
                scanned += 1
                try:
                    with open(p, encoding="utf-8", errors="replace") as fh:
                        lines = fh.read().splitlines()
                except OSError:
                    continue
                for i, line in enumerate(lines, 1):
                    if line.lstrip().startswith("//"):
                        continue
                    for name, _, _, rx in FAMILIES:
                        if re.search(rx, line):
                            hits[name].append("%s:%d: %s" % (rel(p), i, esc(line.strip(), 110)))

    APP_MANIFEST = os.path.join(ROOT, "mobile/ios/App/App/PrivacyInfo.xcprivacy")
    app, aerr = parse(APP_MANIFEST) if os.path.lexists(APP_MANIFEST) else ({}, None)
    app = app or {}
    declared = {}
    for x in dicts(app, "NSPrivacyAccessedAPITypes"):
        declared[str(x.get("NSPrivacyAccessedAPIType"))] = strs(x.get("NSPrivacyAccessedAPITypeReasons"))
    begin("b", 80)
    w("### (b) Required-reason API usage vs the app manifest")
    w("Scanned %d native source files (app Swift/ObjC, plugin ios dirs under mobile/node_modules, SwiftPM checkouts; test directories excluded). "
      "Regex line matches, comments skipped: a hit is a lead to read, not proof of a call." % scanned)
    w("Source roots: " + ", ".join("`%s`" % rel(r) for r in roots))
    if aerr:
        w("App manifest could not be read: " + esc(aerr))
    w("App manifest declares: %s" % (", ".join("%s=%s" % (esc(k.replace("NSPrivacyAccessedAPICategory", ""), 60), "/".join(v)) for k, v in declared.items()) or "nothing"))
    w()
    for name, cat, reason, _ in FAMILIES:
        used = bool(hits[name]); decl = cat in declared
        status = "DECLARED" if used and decl else "NOT DECLARED but USED" if used else "UNUSED (declared anyway: %s)" % "/".join(declared[cat]) if decl else "UNUSED"
        w("#### %s (expected reason %s): %s%s" % (name, reason, status, " - %d hits" % len(hits[name]) if used else ""))
        for h in hits[name][:10]:
            w("- `%s`" % h)
        if len(hits[name]) > 10:
            w("- ... %d more" % (len(hits[name]) - 10))
        w()
    # ---- (c) built binaries ----
    begin("c", 110)
    w("### (c) Built binaries: imported symbols and strings vs the app manifest (Debug simulator build)")
    w("Method: `nm -u` (imported symbols) and `strings -a` on the App.app main executable and each embedded framework executable "
      "(no shell, %d s timeout per call). A symbol import means the binary REFERENCES the API, not why or whether it runs: a human "
      "maps each hit to a purpose. System-framework internals are out of scope. This is the Debug simulator build, not the Release archive." % TOOL_TIMEOUT)
    comps = []  # (component name, path)
    for a in apps[:3]:
        try:
            info, _ = parse(os.path.join(a, "Info.plist"))
            exe = (info or {}).get("CFBundleExecutable")
            exe = exe if isinstance(exe, str) and exe and "/" not in exe else os.path.basename(a)[:-4]
            comps.append(("App" if len(comps) == 0 else os.path.basename(a), os.path.join(a, exe)))
            fw = os.path.join(a, "Frameworks")
            if os.path.isdir(fw) and not os.path.islink(fw):
                for e in sorted(os.listdir(fw))[:8]:
                    if e.endswith(".framework") and not os.path.islink(os.path.join(fw, e)):
                        comps.append((e, os.path.join(fw, e, e[:-len(".framework")])))
        except Exception as e:
            w("- component discovery skipped: " + esc(e, 100))
    results = {}
    if not comps:
        w("No built .app found, so no binary was scanned.")
    for cname, cpath in comps:
        if time.monotonic() > DEADLINE:
            w("- time budget (150 s) exhausted: remaining binaries not scanned, starting at `%s`" % esc(cname))
            break
        if not regular(cpath, MAX_BIN_BYTES):
            w("- `%s`: executable not found or not a regular file at `%s`" % (esc(cname), rel(cpath)))
            continue
        try:
            found, notes, ran = scan_binary(cpath)
        except Exception as e:
            w("- `%s`: scan failed: %s" % (esc(cname), esc(e, 100)))
            continue
        results[cname] = (found, ran)
        w("- `%s` (`%s`)%s" % (esc(cname), rel(cpath), ("  [" + "; ".join(notes) + "]") if notes else ""))
        for name, _, _, _ in BIN_FAMILIES:
            w("  - %s: %s" % (name, ("PRESENT: " + ", ".join(found[name])) if found[name] else ("ABSENT" if ran else "n/a (no tool output)")))
    w()
    w("Roll-up (declared reason from the app manifest; verdict covers ONLY the binaries scanned above):")
    cols = [c for c, _ in comps if c in results]
    w("| Family | Declared | " + " | ".join(esc(c, 40) for c in cols) + " | Verdict |")
    for name, cat, _, _ in BIN_FAMILIES:
        decl = cat in declared
        cells, present = [], []
        for c in cols:
            found, ran = results[c]
            if found[name]:
                cells.append("PRESENT(%d)" % len(found[name])); present.append(c)
            else:
                cells.append("ABSENT" if ran else "n/a")
        if not cols:
            verdict = "NO BINARY SCANNED"
        elif present:
            verdict = ("DECLARED+PRESENT-in-" if decl else "NOT-DECLARED+PRESENT-in-") + ",".join(esc(c, 40) for c in present)
        else:
            verdict = "DECLARED+ABSENT-everywhere-scanned" if decl else "NOT-DECLARED+ABSENT"
        w("| %s | %s | %s | %s |" % (name, esc("/".join(declared[cat]) if decl else "none", 40), " | ".join(cells), verdict))
    w()

    # ---- (c2) resolved SwiftPM dependency coverage ----
    begin("d", 60)
    w("### (c2) Resolved SwiftPM dependency coverage")
    skipd = {"checkouts", "Build", "Index.noindex", "ModuleCache.noindex", "node_modules"}
    searched = [os.path.join(ROOT, "mobile/ios")] + [r for r in DD if r]
    resolved, spm_manifests = [], []
    for r in searched:
        if os.path.isdir(r) and not os.path.islink(r):
            for d, _, fs in safe_walk(r, prune=lambda _d, x: x in skipd):
                for f in fs:
                    fp = os.path.join(d, f)
                    if f == "Package.resolved" and regular(fp, MAX_PLIST_BYTES):
                        resolved.append(fp)
                    elif f == "Package.swift" and r.startswith(ROOT) and regular(fp, MAX_PLIST_BYTES):
                        spm_manifests.append(fp)
    w("Searched for Package.resolved / Package.swift under: " + ", ".join("`%s`" % rel(s) for s in searched))
    w("SourcePackages/checkouts directories found: %s" % (", ".join("`%s`" % rel(c) for c in checkouts) or "NONE (candidates were the derived-data roots above; the next run should check the Xcode log for -clonedSourcePackagesDirPath)"))
    for mp in spm_manifests[:4]:
        try:
            with open(mp, encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
            w("- SPM manifest `%s` sha256 `%s`" % (rel(mp), sha(mp)))
            for m in list(re.finditer(r"\.package\(([^)]*)\)", txt))[:8]:
                spec = " ".join(m.group(1).split())
                pm = re.search(r'path:\s*"([^"]+)"', spec)
                extra = ""
                if pm:
                    tgt = os.path.realpath(os.path.join(os.path.dirname(mp), pm.group(1)))
                    if tgt.startswith(os.path.realpath(ROOT)) and os.path.isdir(tgt):
                        extra = " ; PrivacyInfo.xcprivacy in path package: %d" % len(find_manifests([tgt]))
                    else:
                        extra = " ; path package not found inside the workspace"
                w("  - `.package(%s)`%s" % (esc(spec, 160), esc(extra, 100)))
        except Exception as e:
            w("- SPM manifest skipped: " + esc(e, 100))
    if not resolved:
        w("No Package.resolved found (the project may use only local path packages).")
    for rp in resolved[:3]:
        try:
            with open(rp, encoding="utf-8", errors="replace") as fh:
                data = json.load(fh)
            pins = data.get("pins") if isinstance(data, dict) else None
            if pins is None and isinstance(data, dict) and isinstance(data.get("object"), dict):
                pins = data["object"].get("pins")
            pins = [x for x in pins if isinstance(x, dict)] if isinstance(pins, list) else []
            w("- `%s`: %d pinned packages" % (rel(rp), len(pins)))
            for pin in pins[:12]:
                ident = str(pin.get("identity") or pin.get("package") or "?")
                loc = str(pin.get("location") or pin.get("repositoryURL") or "")
                state = pin.get("state") if isinstance(pin.get("state"), dict) else {}
                ver = str(state.get("version") or state.get("branch") or str(state.get("revision") or "?")[:12])
                names = {ident.lower(), os.path.basename(loc).lower().replace(".git", "")}
                found_in = []
                for c in checkouts:
                    try:
                        for e in sorted(os.listdir(c)):
                            if e.lower() in names:
                                found_in += find_manifests([os.path.join(c, e)])
                    except OSError:
                        pass
                w("  - `%s` %s: %s" % (esc(ident, 60), esc(ver, 40),
                  ("PrivacyInfo.xcprivacy in checkout: %d (%s)" % (len(found_in), ", ".join(esc(os.path.basename(os.path.dirname(x)), 40) for x in found_in[:3]))) if checkouts else "checkout not available on this runner"))
        except Exception as e:
            w("- Package.resolved skipped: " + esc(e, 100))
    w()

    lines = list(head)
    for _, budget, ls in secs:
        lines += ls[:budget]
        if len(ls) > budget:
            lines.append("... %d more lines in this section truncated (section cap %d)" % (len(ls) - budget, budget))
    return "\n".join(lines) + "\n"


def emit():
    try:
        text = main()
    except BaseException:
        text = "## READ-ONLY privacy evidence: SCRIPT EXCEPTION (non-blocking)\n" + "\n".join(
            "    " + esc(l, 400) for l in traceback.format_exc().splitlines()) + "\n"
    lines = text.rstrip("\n").split("\n")
    if len(lines) > MAX_LINES:
        lines = lines[:MAX_LINES] + ["... %d more lines truncated (cap %d)" % (len(lines) - MAX_LINES, MAX_LINES)]
    text = "".join("  " + l + "\n" for l in lines)  # indent: no report line can ever start with '::'
    token = secrets.token_hex(16)  # random per run; the content can never contain it
    print("::stop-commands::" + token)
    print(BEGIN)
    sys.stdout.write(text)
    print(END)
    print("::" + token + "::")
    sys.stdout.flush()
    dest = os.environ.get("GITHUB_STEP_SUMMARY")
    if dest:
        try:
            with open(dest, "a") as fh:
                fh.write(text)
        except OSError as e:
            print("  summary write failed: " + esc(e, 100))


emit()
