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
import glob, hashlib, json, os, plistlib, re, secrets, shutil, stat, subprocess, sys, threading, time, traceback

MAX_LINES = 400
MAX_PLIST_BYTES = 1024 * 1024
MAX_SRC_BYTES = 2 * 1024 * 1024
MAX_FILES = 20000
MAX_BIN_BYTES = 200 * 1024 * 1024
MAX_MACHO = 40
try:  # test hook only: lowers the per-tool output cap so the truncation path can be exercised
    MAX_TOOL_BYTES = int(os.environ.get("EVIDENCE_TOOL_CAP_BYTES", "") or 96 * 1024 * 1024)
except ValueError:
    MAX_TOOL_BYTES = 96 * 1024 * 1024
LIMIT_HIT = []  # (kind, path) for walks that use the default sink; the app walk passes its own list
MACHO_MAGIC = {bytes.fromhex(h) for h in ("feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}
TOOL_TIMEOUT = 20
MAX_DEPTH = 24
CONFIRM_DEPTH = 3     # extra levels enumerated (names + magic only) inside a directory the main walk skipped
CONFIRM_FILES = 5000
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


def safe_walk(root, prune=None, hits=None):
    """Bounded os.walk: never follows symlinks, depth/file/time capped. Yields (dir, subdirs, files).
    Every limit hit is appended to `hits` as (kind, path); for depth, path is the skipped subdirectory."""
    hits = LIMIT_HIT if hits is None else hits
    n = 0
    base = root.rstrip(os.sep).count(os.sep)
    for d, ds, fs in os.walk(root, followlinks=False):
        if time.monotonic() > DEADLINE:
            hits.append(("time", d))
            return
        ds[:] = sorted(x for x in ds if not os.path.islink(os.path.join(d, x)) and not (prune and prune(d, x)))
        if d.count(os.sep) - base >= MAX_DEPTH:
            hits.extend(("depth", os.path.join(d, x)) for x in ds)
            ds[:] = []
        n += len(fs)
        if n > MAX_FILES:
            hits.append(("file count", d))
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
    """Run a tool on one file: list args, no shell, wall-clock timeout (kill), output sliced WHILE reading and the process
    killed at the cap. -> (text, error or None, lines). Truncation and timeout are errors: never evidence of absence."""
    exe = shutil.which(tool)
    if not exe:
        return None, "tool not found", 0
    try:
        proc = subprocess.Popen([exe] + args + [f], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as e:
        return None, "error " + esc(e, 60), 0
    timed_out = []

    def _kill():
        timed_out.append(1)
        try:
            proc.kill()
        except OSError:
            pass
    timer = threading.Timer(TOOL_TIMEOUT, _kill)
    timer.start()
    chunks, size, truncated = [], 0, False
    try:
        while True:
            c = proc.stdout.read(65536)
            if not c:
                break
            size += len(c)
            chunks.append(c)
            if size > MAX_TOOL_BYTES:
                truncated = True
                proc.kill()
                break
    except OSError:
        pass
    finally:
        timer.cancel()
        try:
            proc.stdout.close()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    if timed_out:
        return None, "timeout", 0
    if truncated:
        return None, "truncated at the %d byte output cap" % MAX_TOOL_BYTES, 0
    if proc.returncode != 0:
        return None, "exit %d" % proc.returncode, 0
    data = b"".join(chunks)
    return data.decode("utf-8", "replace"), None, data.count(b"\n")


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
    """-> ({family: [escaped names]}, notes, ok, nm_lines, strings_lines). ok = BOTH tools ran to completion untruncated."""
    found = {b[0]: {} for b in BIN_FAMILIES}
    notes = []
    nm_out, nm_err, nm_n = run_tool("nm", f, ["-u"])
    st_out, st_err, st_n = run_tool("strings", f, ["-a"])
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
    return {k: list(v) for k, v in found.items()}, notes, (nm_err is None and st_err is None), nm_n, st_n


def is_macho(p):
    if not regular(p, MAX_BIN_BYTES):
        return False
    try:
        with open(p, "rb") as fh:
            return fh.read(4) in MACHO_MAGIC
    except OSError:
        return False


def macho_files(app):
    """Every regular, non-symlink file under the .app whose first 4 bytes are a Mach-O / fat magic.
    -> (macho paths, .dylib-named non-Mach-O paths, limit hits [(kind, path)])."""
    out, bad_dylib, lim = [], [], []
    for d, _, fs in safe_walk(app, hits=lim):
        for f in sorted(fs):
            p = os.path.join(d, f)
            if is_macho(p):
                out.append(p)
            elif f.endswith(".dylib") and regular(p, MAX_BIN_BYTES):
                bad_dylib.append(p)
    return out, bad_dylib, lim


def confirm_skipped(dirs):
    """Bounded look INSIDE directories the main walk skipped for depth: file names + Mach-O magic, at most CONFIRM_DEPTH more
    levels. -> (mach-o paths found, confirmed) where confirmed is False if THIS walk also hit any limit."""
    found, n, ok = [], 0, True
    for root in dirs:
        if os.path.islink(root) or not os.path.isdir(root):
            continue
        base = root.rstrip(os.sep).count(os.sep)
        for d, ds, fs in os.walk(root, followlinks=False):
            if time.monotonic() > DEADLINE:
                return found, False
            ds[:] = sorted(x for x in ds if not os.path.islink(os.path.join(d, x)))
            if d.count(os.sep) - base >= CONFIRM_DEPTH and ds:
                ok = False
                ds[:] = []
            n += len(fs)
            if n > CONFIRM_FILES:
                return found, False
            found += [os.path.join(d, f) for f in sorted(fs) if is_macho(os.path.join(d, f))]
    return found, ok


def codey(rel_path):
    """True if a path under the .app could plausibly hold code: Frameworks/, PlugIns/, or a *.dylib/*.framework/*.appex segment."""
    segs = rel_path.split(os.sep)
    return any(s in ("Frameworks", "PlugIns") or s.endswith((".dylib", ".framework", ".appex")) for s in segs)


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
    begin("a", 110)
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
    begin("c", 130)
    w("### (c) Built binaries: imported symbols and strings vs the app manifest (Debug simulator build)")
    w("Method: EVERY regular non-symlink file under the built .app is checked for a Mach-O / fat magic; each Mach-O (main executable, "
      "*.debug.dylib, __preview.dylib, other dylibs, frameworks, appex) gets `nm -u` (imported symbols) and `strings -a` (no shell, %d s timeout, "
      "output sliced while reading). A symbol import means the binary REFERENCES the API, not why or whether it runs: a human maps each hit "
      "to a purpose. System-framework internals are out of scope. This is the Debug simulator build, not the Release archive." % TOOL_TIMEOUT)
    comps = []  # (label, kind, path, size, app)
    reasons = []  # reasons coverage is incomplete
    notes_cov = []  # non-blocking notes (a limit was hit but confirmed harmless)
    for a in apps[:3]:
        try:
            info, _ = parse(os.path.join(a, "Info.plist"))
            exe = (info or {}).get("CFBundleExecutable")
            exe = exe if isinstance(exe, str) and exe and "/" not in exe else os.path.basename(a)[:-4]
            mains = os.path.join(a, exe)
            files, bad, lim = macho_files(a)
            hard = sorted({k for k, _ in lim if k != "depth"})
            if hard:
                reasons.append("app walk hit its %s limit" % " and ".join(hard))
            skipped = sorted({pth for k, pth in lim if k == "depth"})
            if skipped:
                shown = ", ".join("`%s`" % esc(os.path.relpath(x, a), 80) for x in skipped[:5]) + (" (+%d more)" % (len(skipped) - 5) if len(skipped) > 5 else "")
                hot = [x for x in skipped if codey(os.path.relpath(x, a))]
                if hot:
                    reasons.append("depth limit (%d) hit under code-bearing paths: %s" % (MAX_DEPTH, ", ".join("`%s`" % esc(os.path.relpath(x, a), 80) for x in hot[:5])))
                else:
                    extra, confirmed = confirm_skipped(skipped)
                    for x in extra:
                        if x not in files:
                            files.append(x)
                    if extra:
                        reasons.append("Mach-O found inside depth-skipped dirs (reported and scanned, walk still incomplete): %s"
                                       % ", ".join("`%s`" % esc(os.path.relpath(x, a), 80) for x in extra[:5]))
                    elif not confirmed:
                        reasons.append("depth limit (%d) hit at %s and the confirmation walk also hit a limit" % (MAX_DEPTH, shown))
                    else:
                        notes_cov.append("depth limit (%d) hit only in resource dirs: %s; their file names were enumerated %d more levels and none has a Mach-O magic, so coverage is not reduced"
                                         % (MAX_DEPTH, shown, CONFIRM_DEPTH))
            if mains not in files:
                reasons.append("main executable `%s` is missing or not a Mach-O" % esc(exe, 60))
            if not any(x.endswith(".debug.dylib") for x in files) and mains in files and os.lstat(mains).st_size < 256 * 1024:
                reasons.append("the main executable is launcher-sized but no *.debug.dylib was found (the app code may live elsewhere)")
            for b in bad[:5]:
                reasons.append("`%s` has a .dylib name but no Mach-O magic" % rel(b))
            if len(files) > MAX_MACHO:
                reasons.append("%d Mach-O files found, only the first %d scanned" % (len(files), MAX_MACHO))
            for fp in files[:MAX_MACHO]:
                r_ = os.path.relpath(fp, a)
                base = os.path.basename(fp)
                if fp == mains:
                    label, kind = ("App" if not comps else os.path.basename(a)), "executable"
                elif ".framework/" in r_ and r_.split("/")[-2] == base + ".framework":
                    label, kind = base + ".framework", "framework"
                elif base.endswith(".dylib"):
                    label, kind = base, "dylib"
                else:
                    label, kind = r_, "other Mach-O (e.g. appex)"
                while any(c[0] == label for c in comps):
                    label += "#"
                comps.append((label, kind, fp, os.lstat(fp).st_size, a))
        except Exception as e:
            reasons.append("component discovery failed: " + esc(e, 100))
    if not apps:
        reasons.append("no built .app found")
    results = {}
    for cname, kind, cpath, size, _a in comps:
        if time.monotonic() > DEADLINE:
            reasons.append("time budget (150 s) exhausted before `%s`" % esc(cname))
            break
        try:
            found, notes, ok, nmn, stn = scan_binary(cpath)
        except Exception as e:
            reasons.append("scan of `%s` failed: %s" % (esc(cname), esc(e, 80)))
            continue
        results[cname] = (found, ok, notes, nmn, stn)
        if not ok:
            reasons.append("`%s`: %s" % (esc(cname), esc("; ".join(notes) or "tool failure", 120)))
    complete = not reasons and bool(results) and len(results) == len(comps)
    w("#### COVERAGE: " + ("COMPLETE - every Mach-O below ran both tools to completion" if complete else
      "INCOMPLETE - no family below may be read as absent where it says UNKNOWN"))
    for rs in reasons[:8]:
        w("- COVERAGE INCOMPLETE: " + rs)
    if len(reasons) > 8:
        w("- ... %d more reasons" % (len(reasons) - 8))
    for nt in notes_cov[:3]:
        w("- NOTE: " + nt)
    w("| Mach-O (relative to .app) | Size | Kind | nm / strings | nm lines / strings lines |")
    for cname, kind, cpath, size, a in comps:
        r_ = results.get(cname)
        w("| %s | %d | %s | %s | %s |" % (esc(os.path.relpath(cpath, a), 90), size, esc(kind, 40),
          "not run" if not r_ else ("both OK" if r_[1] else "FAILED"),
          "-" if not r_ else "%d / %d" % (r_[3], r_[4])))
    if not comps:
        w("_no Mach-O files found_")
    w()
    w("Per binary (symbol names are evidence of reference only; no purpose is claimed here):")
    for cname, kind, cpath, size, a in comps:
        r_ = results.get(cname)
        if not r_:
            continue
        found, ok = r_[0], r_[1]
        w("- `%s`%s" % (esc(cname), "" if ok else "  [TOOL FAILURE: unmatched families are UNKNOWN]"))
        for name, _, _, _ in BIN_FAMILIES:
            w("  - %s: %s" % (name, ("PRESENT: " + ", ".join(found[name])) if found[name] else ("ABSENT" if ok else "UNKNOWN")))
    w()
    w("Roll-up (declared reason from the app manifest; ABSENT only when coverage is COMPLETE):")
    cols = [c[0] for c in comps if c[0] in results]
    w("| Family | Declared | " + " | ".join(esc(c, 40) for c in cols) + " | Verdict |")
    for name, cat, _, _ in BIN_FAMILIES:
        decl = cat in declared
        cells, present = [], []
        for c in cols:
            found, ok = results[c][0], results[c][1]
            if found[name]:
                cells.append("PRESENT(%d)" % len(found[name])); present.append(c)
            else:
                cells.append("ABSENT" if ok else "UNKNOWN")
        d_ = "DECLARED" if decl else "NOT-DECLARED"
        if present:
            verdict = d_ + "+PRESENT-in-" + ",".join(esc(c, 40) for c in present)
        elif complete:
            verdict = d_ + ("+ABSENT-everywhere-scanned" if decl else "+ABSENT")
        else:
            verdict = d_ + "+UNKNOWN"
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
