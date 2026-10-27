#!/usr/bin/env python3
"""Behavioural test for ios-privacy-evidence.py on a HOSTILE temp tree (sgt-b1 #32089). Run: python3 -I <this file> [script].
No network, no secrets. Asserts: exit 0 within seconds (a FIFO must not hang it), no stdout line starts with '::' except the
random-token stop/resume pair that wraps the block, no raw markup in the summary, the good manifest and a Latest/ source hit
are listed, and a FooTests/ source hit is not."""
import os, plistlib, re, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "ios-privacy-evidence.py")
T = tempfile.mkdtemp(prefix="evtest-", dir=os.environ.get("TMPDIR") or None)
ROOT, HOME = os.path.join(T, "ws"), os.path.join(T, "home")
os.makedirs(HOME)
fails = []


def mk(rel, data=b""):
    p = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(data if isinstance(data, bytes) else data.encode())
    return p


def manifest(reason, ctype="NSPrivacyCollectedDataTypeUserID"):
    return plistlib.dumps({"NSPrivacyTracking": False, "NSPrivacyCollectedDataTypes": [{"NSPrivacyCollectedDataType": ctype}],
                           "NSPrivacyAccessedAPITypes": [{"NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                                                          "NSPrivacyAccessedAPITypeReasons": [reason]}]})


app_manifest = plistlib.loads(manifest("CA92.1"))
app_manifest["NSPrivacyAccessedAPITypes"].append({"NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryActiveKeyboards",
                                                  "NSPrivacyAccessedAPITypeReasons": ["54BD.1"]})
mk("mobile/ios/App/App/PrivacyInfo.xcprivacy", plistlib.dumps(app_manifest))

# Fake built .app + stub nm/strings (absolute shebang, printf builtin only: no recursion, no real binaries touched).
APPDIR = os.path.join(HOME, "Library/Developer/Xcode/DerivedData/Proj-x/Build/Products/Debug-iphonesimulator/App.app")
MH64, FAT = bytes.fromhex("cffaedfe"), bytes.fromhex("cafebabe")
for rel_, data in (("Info.plist", plistlib.dumps({"CFBundleExecutable": "App"})),
                   ("App", bytes.fromhex("feedfacf") + b"\0" * 12),            # launcher: no symbols of its own
                   ("App.debug.dylib", MH64 + b"\0" * 12),                       # the real app code (Debug layout)
                   ("Frameworks/Capacitor.framework/Capacitor", FAT + b"\0" * 12),
                   ("Frameworks/Cordova.framework/Cordova", MH64 + b"\0" * 12),
                   ("notes.txt", b"UserDefaults mach_absolute_time but not a Mach-O")):
    fp = os.path.join(APPDIR, rel_)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    open(fp, "wb").write(data)
STUBS = os.path.join(T, "stubs")
FAILSTUBS = os.path.join(T, "failstubs")
os.makedirs(STUBS)
os.makedirs(FAILSTUBS)
def stub(name, body, d=STUBS):
    sp = os.path.join(d, name)
    open(sp, "w").write("#!/bin/bash\nf=\"${@: -1}\"\ncase \"$f\" in\n" + body + "esac\nexit 0\n")
    os.chmod(sp, 0o755)
NM = """*/App.app/App.debug.dylib) printf '%s\\n' '                 U _OBJC_CLASS_$_NSUserDefaults::error::pwn<img src=x>' '                 U _stat' '                 U _printf' ;;
*/Capacitor.framework/Capacitor) printf '%s\\n' '                 U _stat' '                 U _OBJC_CLASS_$_NSUserDefaults' ;;
*/Cordova.framework/Cordova) printf '%s\\n' '                 U _statfs' ;;
*/App.app/App) printf '%s\\n' '                 U _printf' ;;
"""
STR = """*/App.app/App.debug.dylib) printf '%s\\n' 'systemUptime' '::error::injected line'; for i in {1..40}; do printf 'filler line number %s\\n' $i; done ;;
*/Capacitor.framework/Capacitor) printf '%s\\n' 'NSFileModificationDate' ;;
*/App.app/App) printf '%s\\n' 'launcher' ;;
"""
stub("nm", NM)
stub("strings", STR)
stub("nm", "*/Capacitor.framework/Capacitor) exit 3 ;;\n" + NM, FAILSTUBS)  # nm fails on one binary
stub("strings", STR, FAILSTUBS)
EMPTY = os.path.join(T, "emptybin")
os.makedirs(EMPTY)
mk("mobile/ios/App/App/A.swift", "let d = UserDefaults.standard\n")
mk("mobile/node_modules/good/PrivacyInfo.xcprivacy", manifest("GOODREASON"))
mk("mobile/node_modules/evil/PrivacyInfo.xcprivacy",
   manifest("::error::pwn <img src=x onerror=alert(1)> `|` [a](http://x)", "::stop-commands::abc"))
mk("mobile/node_modules/nl\n::error::boom/PrivacyInfo.xcprivacy", manifest("NEWLINEPATH"))
mk("mobile/node_modules/arr/PrivacyInfo.xcprivacy", plistlib.dumps([1, 2]))
mk("mobile/node_modules/bad/PrivacyInfo.xcprivacy", b"not a plist")
os.makedirs(os.path.join(ROOT, "mobile/node_modules/loop"))
os.symlink("../loop", os.path.join(ROOT, "mobile/node_modules/loop/self"))
os.makedirs(os.path.join(ROOT, "mobile/node_modules/selfsym"))
os.symlink("PrivacyInfo.xcprivacy", os.path.join(ROOT, "mobile/node_modules/selfsym/PrivacyInfo.xcprivacy"))
os.makedirs(os.path.join(ROOT, "mobile/node_modules/fifo"))
os.mkfifo(os.path.join(ROOT, "mobile/node_modules/fifo/PrivacyInfo.xcprivacy"))
mk("mobile/node_modules/@cap/p/ios/Latest/B.swift", "let t = ProcessInfo.processInfo.systemUptime\n")
mk("mobile/node_modules/@cap/p/ios/Contests/D.swift", "let u = volumeAvailableCapacityKey\n")
mk("mobile/node_modules/@cap/p/ios/FooTests/C.swift", "var s = statfs()\n")
summary = os.path.join(T, "summary.md")

t0 = time.monotonic()
try:
    r = subprocess.run([sys.executable, "-I", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=30,
                       env={"PATH": STUBS + ":/usr/bin:/bin", "HOME": HOME, "GITHUB_WORKSPACE": ROOT, "GITHUB_STEP_SUMMARY": summary})
except subprocess.TimeoutExpired:
    print("FAIL script hung (FIFO/symlink not handled)"); sys.exit(1)
dt = time.monotonic() - t0
lines = r.stdout.split("\n")
if lines and lines[-1] == "":
    lines.pop()
sm = open(summary).read() if os.path.exists(summary) else ""


def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        fails.append(name)


check("exit code 0", r.returncode == 0)
check("finishes within 10 s", dt < 10)
colon = [i for i, l in enumerate(lines) if l.startswith("::")]
tok = re.match(r"^::stop-commands::([0-9a-f]{32})$", lines[0]) if lines else None
check("only the random-token stop/resume lines start with '::' (first and last)",
      bool(tok) and colon == [0, len(lines) - 1] and lines[-1] == "::%s::" % tok.group(1))
check("markers present", "=== IOS-PRIVACY-EVIDENCE BEGIN ===" in lines and "=== IOS-PRIVACY-EVIDENCE END ===" in lines)
check("summary has no raw markup characters from values", "<img" not in sm and "<" not in sm and "onerror=alert(1)>" not in sm and "[a](" not in sm)
check("summary has no line starting with '::'", not any(l.startswith("::") for l in sm.split("\n")))
check("no traceback (array-root/symlink/FIFO handled per file)", "SCRIPT EXCEPTION" not in r.stdout)
check("good manifest is listed", "GOODREASON" in r.stdout and "GOODREASON" in sm)
check("array-root manifest reported, not fatal", "not a dict" in r.stdout)
check("garbage manifest reported, not fatal", "parse error" in r.stdout)
check("Latest/ source is scanned (boot time hit)", "Latest/B.swift" in r.stdout)
check("Contests/ source is scanned (disk space hit)", "Contests/D.swift" in r.stdout)
check("FooTests/ source is skipped", "FooTests" not in r.stdout)
def row(fam):
    return next((l for l in lines if l.startswith("  | " + fam + " |")), "")
check("(c) debug dylib discovered by magic bytes (and the .txt decoy is not)", "App.debug.dylib" in r.stdout and "notes.txt" not in r.stdout)
check("(c) coverage table comes before the roll-up and is COMPLETE", "COVERAGE: COMPLETE" in r.stdout and "| App.debug.dylib |" in r.stdout and r.stdout.index("COVERAGE:") < r.stdout.index("Roll-up"))
check("(c) fat (cafebabe) framework is covered", "Capacitor.framework/Capacitor" in r.stdout)
check("(c) nm/strings line counts printed", re.search(r"App\.debug\.dylib \| \d+ \| dylib \| both OK \| 3 / 4\d", r.stdout) is not None)
check("(c) UserDefaults: DECLARED+PRESENT in App.debug.dylib and Capacitor", "DECLARED+PRESENT-in-App.debug.dylib,Capacitor.framework" in row("UserDefaults") and "NOT-DECLARED" not in row("UserDefaults"))
check("(c) File timestamp: NOT-DECLARED+PRESENT (stat) in debug dylib and Capacitor", "NOT-DECLARED+PRESENT-in-App.debug.dylib,Capacitor.framework" in row("File timestamp"))
check("(c) System boot time: NOT-DECLARED+PRESENT in debug dylib (strings only)", "NOT-DECLARED+PRESENT-in-App.debug.dylib" in row("System boot time"))
check("(c) Disk space: NOT-DECLARED+PRESENT in Cordova only", "NOT-DECLARED+PRESENT-in-Cordova.framework" in row("Disk space"))
check("(c) Active keyboards: DECLARED+ABSENT-everywhere-scanned (coverage complete)", "DECLARED+ABSENT-everywhere-scanned" in row("Active keyboards"))
check("(c) per-binary ABSENT is printed", "Active keyboards: ABSENT" in r.stdout)
check("(c) hostile symbol name is escaped, not echoed raw", "NSUserDefaults::error::pwn" in r.stdout and "<img" not in r.stdout and "<img" not in sm)
check("(c) hostile strings line never becomes output", "injected line" not in r.stdout)

def run_variant(path, extra=None):
    env = {"PATH": path, "HOME": HOME, "GITHUB_WORKSPACE": ROOT}
    env.update(extra or {})
    return subprocess.run([sys.executable, "-I", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60, env=env)
def vrow(res, fam):
    return next((l for l in res.stdout.split("\n") if l.startswith("  | " + fam + " |")), "")

# No nm/strings at all: exit 0, every unmatched family UNKNOWN, never ABSENT.
r2 = run_variant(EMPTY)
check("(c) missing nm/strings: exit 0, 'tool not found', UNKNOWN, never ABSENT", r2.returncode == 0 and "tool not found" in r2.stdout
      and "DECLARED+UNKNOWN" in vrow(r2, "Active keyboards") and "ABSENT" not in vrow(r2, "Active keyboards") and "COVERAGE: INCOMPLETE" in r2.stdout and "SCRIPT EXCEPTION" not in r2.stdout)
check("(c) missing tools: output stays within the 400-line cap", len(r2.stdout.split("\n")) <= 410 and len(lines) <= 410)

# nm fails on one binary: that binary UNKNOWN, roll-up UNKNOWN (not ABSENT); PRESENT hits elsewhere still reported.
r3 = run_variant(FAILSTUBS + ":/usr/bin:/bin")
check("(c) tool failure on one binary => roll-up DECLARED+UNKNOWN, not ABSENT", "DECLARED+UNKNOWN" in vrow(r3, "Active keyboards")
      and "ABSENT-everywhere" not in r3.stdout and "COVERAGE INCOMPLETE" in r3.stdout and "TOOL FAILURE" in r3.stdout and r3.returncode == 0)
check("(c) tool failure: PRESENT evidence from the other binaries is kept", "PRESENT-in-App.debug.dylib" in vrow(r3, "UserDefaults"))

# Output cap hit (truncation): that binary UNKNOWN, never ABSENT.
r4 = run_variant(STUBS + ":/usr/bin:/bin", {"EVIDENCE_TOOL_CAP_BYTES": "200"})
check("(c) truncated tool output => UNKNOWN, never ABSENT", r4.returncode == 0 and "truncated" in r4.stdout
      and "DECLARED+UNKNOWN" in vrow(r4, "Active keyboards") and "ABSENT-everywhere" not in r4.stdout)

check("app UserDefaults use is DECLARED", "UserDefaults (expected reason CA92.1): DECLARED" in r.stdout)
import shutil
shutil.rmtree(T, ignore_errors=True)
print("---")
print("ALL PASS" if not fails else "FAILURES: %d" % len(fails))
sys.exit(1 if fails else 0)
