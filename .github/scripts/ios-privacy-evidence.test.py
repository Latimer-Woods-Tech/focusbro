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


mk("mobile/ios/App/App/PrivacyInfo.xcprivacy", manifest("CA92.1"))
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
                       env={"PATH": "/usr/bin:/bin", "HOME": HOME, "GITHUB_WORKSPACE": ROOT, "GITHUB_STEP_SUMMARY": summary})
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
check("app UserDefaults use is DECLARED", "UserDefaults (expected reason CA92.1): DECLARED" in r.stdout)
import shutil
shutil.rmtree(T, ignore_errors=True)
print("---")
print("ALL PASS" if not fails else "FAILURES: %d" % len(fails))
sys.exit(1 if fails else 0)
