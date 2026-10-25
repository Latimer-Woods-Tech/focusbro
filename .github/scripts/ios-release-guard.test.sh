#!/usr/bin/env bash
# Cloud-only FAKE harness for ios-release-guard.sh and the ios-release.yml structure (jc-security #30297/#30314).
# Uses fake gcloud/xcodebuild stubs and fake key files only: no WIF, no secrets, no signing, no upload.
# Proof of rejection (Standing Law 1): mutated copies of the guard must make the matching case FAIL to reject.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/ios-release-guard.sh"
WF="$HERE/../workflows/ios-release.yml"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
STUBS="$T/stubs"; HOME_DIR="$T/home"; WORK="$T/work"; CALLS="$T/calls"; OUT="$T/out"; MARK="$WORK/x"
mkdir -p "$STUBS" "$HOME_DIR/.appstoreconnect/private_keys" "$WORK"
: > "$CALLS"
# Stubs use only the printf builtin and an absolute-path-free redirect: no bare command names, so no recursion.
for s in gcloud xcodebuild; do
  printf '#!/bin/bash\nprintf "%%s %%s\\n" "%s" "$*" >> "%s"\nexit 0\n' "$s" "$CALLS" > "$STUBS/$s"
  chmod +x "$STUBS/$s"
done
echo FAKE > "$HOME_DIR/.appstoreconnect/private_keys/AuthKey_FAKE.p8"
SHA40=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
UP40=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
BAD40=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
FAILS=0
ok()  { echo "PASS $1"; }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }

# run_guard SCRIPT [VAR=VALUE ...]: valid signed baseline, overridden by the args. rc in RC.
run_guard() {
  local script="$1"; shift; : > "$OUT"; rm -f "$MARK"; : > "$CALLS"
  set +e
  (cd "$WORK" && /usr/bin/env -i PATH="$STUBS:/usr/bin:/bin" HOME="$HOME_DIR" GITHUB_OUTPUT="$OUT" \
     EVENT_NAME=workflow_dispatch MODE=signed REF=refs/heads/main SHA=$SHA40 EXPECTED_SHA=$SHA40 \
     VERSION_INPUT=1.2.3 SKIP_UPLOAD_INPUT=true PKG_VERSION=0.9.0 "$@" bash "$script" >"$T/stdout" 2>&1)
  RC=$?; set -e
}
reject() {
  local n="$1"; shift; run_guard "$GUARD" "$@"
  if [ "$RC" -ne 0 ] && [ ! -s "$CALLS" ] && [ ! -e "$MARK" ] && grep -q '^::error::' "$T/stdout"; then ok "reject $n"; else bad "reject $n (rc=$RC)"; fi
}
accept() { # NAME EXPECTED_VERSION EXPECTED_UPLOAD [VAR=VALUE ...]
  local n="$1" v="$2" u="$3"; shift 3; run_guard "$GUARD" "$@"
  if [ "$RC" -eq 0 ] && grep -qx "VERSION_NAME=$v" "$OUT" && grep -qx "UPLOAD=$u" "$OUT" && [ ! -s "$CALLS" ] && [ ! -e "$MARK" ]; then ok "accept $n"; else bad "accept $n (rc=$RC)"; fi
}

reject "event pull_request" EVENT_NAME=pull_request
reject "event push" EVENT_NAME=push
reject "mode unsigned with fake keys present" MODE=unsigned
reject "mode empty" MODE=
reject "mode Signed" MODE=Signed
reject "ref feature branch" REF=refs/heads/feature
reject "ref tag" REF=refs/tags/v1.0.0
reject "sha wrong" EXPECTED_SHA=$BAD40
reject "sha short" EXPECTED_SHA=aaaaaaa SHA=aaaaaaa
reject "sha uppercase" EXPECTED_SHA=$UP40 SHA=$UP40
reject "sha empty" EXPECTED_SHA=
reject "version injection" 'VERSION_INPUT=1.0; touch x'
reject "version double dot" VERSION_INPUT=1..2
reject "version five parts" VERSION_INPUT=1.0.0.0.0
reject "version command substitution" 'VERSION_INPUT=$(touch x)'
reject "version backtick" 'VERSION_INPUT=`touch x`'
reject "version blank and no package version" VERSION_INPUT= PKG_VERSION=
reject "version bad package version" VERSION_INPUT= PKG_VERSION=1.0-beta
accept "valid signed, upload off by default" 1.2.3 false
accept "valid signed, skip_upload=false" 1.2.3 true SKIP_UPLOAD_INPUT=false
accept "skip_upload=False stays off" 1.2.3 false SKIP_UPLOAD_INPUT=False
accept "skip_upload blank stays off" 1.2.3 false SKIP_UPLOAD_INPUT=
accept "version defaults to package version" 0.9.0 false VERSION_INPUT=

# Proof of rejection: delete one check at a time; the matching rejection MUST disappear (mutant accepts).
mutate() { # NAME SED_PATTERN [VAR=VALUE ...]
  local n="$1" pat="$2" m="$T/mutant-$1.sh"; shift 2
  sed "/$pat/d" "$GUARD" > "$m"
  if cmp -s "$GUARD" "$m"; then bad "mutation $n (pattern matched nothing)"; return; fi
  bash -n "$m" || { bad "mutation $n (mutant does not parse)"; return; }
  run_guard "$m" "$@"
  if [ "$RC" -eq 0 ]; then ok "mutation $n is caught (case no longer rejects)"; else bad "mutation $n NOT caught (case still rejects, rc=$RC)"; fi
}
mutate no-event 'EVENT_NAME:-' EVENT_NAME=pull_request
mutate no-mode 'MODE:-' MODE=unsigned
mutate no-ref 'REF:-' REF=refs/heads/feature
mutate no-sha-format 'EXPECTED_SHA:-}" =~' EXPECTED_SHA=$UP40 SHA=$UP40
mutate no-sha-equality 'EXPECTED_SHA:-}" = ' EXPECTED_SHA=$BAD40
mutate no-version-regex '\$V" =~' 'VERSION_INPUT=1.0; touch x'

# Workflow structure assertions (PyYAML).
set +e
python3 - "$WF" > "$T/py" 2>&1 <<'PY'
import sys, json, yaml
d = yaml.safe_load(open(sys.argv[1]))
res = []
def chk(name, cond): res.append((name, bool(cond)))
on = d.get(True, d.get("on"))
jobs = d["jobs"]
def perms(j): return jobs[j].get("permissions") or {}
top = d.get("permissions") or {}
u = jobs["unsigned"]; s = jobs["signed"]
utext = json.dumps(u)
gtext = json.dumps(jobs["guard-tests"])
chk("on has no push trigger", "push" not in on)
chk("on has no tag trigger", "tags" not in json.dumps(on))
chk("on has pull_request and workflow_dispatch", "pull_request" in on and "workflow_dispatch" in on)
chk("mode default is unsigned", on["workflow_dispatch"]["inputs"]["mode"]["default"] == "unsigned")
chk("unsigned grants no id-token", "id-token" not in perms("unsigned") and "id-token" not in top)
chk("unsigned uses no google-github-actions", "google-github-actions" not in utext)
chk("unsigned never mentions gcloud", "gcloud" not in utext)
chk("unsigned never mentions secrets.", "secrets." not in utext)
chk("signed is the ONLY id-token: write job", [j for j in jobs if perms(j).get("id-token") == "write"] == ["signed"])
chk("guard-tests has only contents: read", perms("guard-tests") == {"contents": "read"})
chk("guard-tests uses no secrets or cloud auth", "secrets." not in gtext and "google-github-actions" not in gtext)
cond = s.get("if", "")
chk("signed if requires mode == signed", "inputs.mode == 'signed'" in cond)
chk("signed if requires main ref", "github.ref == 'refs/heads/main'" in cond)
st = s["steps"]
chk("signed step 0 is checkout", "actions/checkout" in st[0].get("uses", ""))
chk("signed step 1 runs the guard script", "ios-release-guard.sh" in st[1].get("run", ""))
def idx(pred):
    for i, x in enumerate(st):
        if pred(x): return i
    return 99
ci = idx(lambda x: "npm ci" in x.get("run", ""))
au = idx(lambda x: x.get("uses", "").startswith("google-github-actions/"))
chk("signed npm ci precedes first google-github-actions step", ci < au < 99)
for n, o in res: print(("PASS " if o else "FAIL ") + "workflow: " + n)
sys.exit(0 if all(o for _, o in res) else 1)
PY
PYRC=$?; set -e
cat "$T/py"
if [ "$PYRC" -ne 0 ]; then FAILS=$((FAILS+1)); fi

echo "---"
if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES: $FAILS"; exit 1; fi
