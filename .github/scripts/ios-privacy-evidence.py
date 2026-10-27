#!/usr/bin/env python3
"""READ-ONLY privacy evidence for the unsigned iOS job (jc-privacy #32039). Writes markdown to $GITHUB_STEP_SUMMARY and
the identical report to stdout between markers. Never edits a file, makes no network call, never fails the job
(always exits 0): output is evidence, not a gate.
Part (a): every PrivacyInfo.xcprivacy in built products and resolved SwiftPM checkouts (path, sha256, declared types).
Part (b): file:line hits for the required-reason API families vs the app manifest's declared reasons.
Hostile-input rules (sgt-b1 #32089): every value and path is escaped before printing (control chars, newlines and
< > & ` | [ ] are neutralised); every report line is indented so none can start with '::'; the stdout block sits under a
random-token ::stop-commands::; only regular, non-symlink, size-capped files are opened (no FIFO/device hang); walks
are bounded in depth, file count and time; one bad file never aborts the report."""
import glob, hashlib, os, plistlib, re, secrets, stat, sys, time, traceback

MAX_LINES = 400
MAX_PLIST_BYTES = 1024 * 1024
MAX_SRC_BYTES = 2 * 1024 * 1024
MAX_FILES = 20000
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


def main():
    HOME = os.path.expanduser("~")
    ROOT = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
    DD = [os.environ.get("DERIVED_DATA", ""), os.path.join(HOME, "Library/Developer/Xcode/DerivedData")]
    out = []

    def w(s=""):
        out.append(s)

    def rel(p):
        return esc(os.path.relpath(p, ROOT) if p.startswith(ROOT) else p)

    def table(title, paths, base=None):
        w("### " + title)
        if not paths:
            w("_none found_")
        if len(paths) > 40:
            w("... %d more manifests not listed (cap 40 per section)" % (len(paths) - 40))
        for p in paths[:40]:
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
        for h in hits[name][:60]:
            w("- `%s`" % h)
        if len(hits[name]) > 60:
            w("- ... %d more" % (len(hits[name]) - 60))
        w()
    return "\n".join(out) + "\n"


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
