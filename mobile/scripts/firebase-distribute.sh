#!/usr/bin/env bash
# Distribute an APK to testers through Firebase App Distribution — the estate's
# tester front door (Play's internal-tester list is console-only; see Factory
# docs/runbooks/play-store-operations.md §5).
#
#   mobile/scripts/firebase-distribute.sh <apk> <release-notes> <email>[,<email>...]
#
# Auth: an access token for factory-sa@factory-495015 — in CI the WIF identity
# (`gcloud auth print-access-token`), locally impersonation. Override with
# $FIREBASE_TOKEN. Every call sends x-goog-user-project (without it the API
# 403s SERVICE_DISABLED naming a foreign project — reads like a disabled API).
#
# Uses the project NUMBER (891842778224): the API answers the project ID with
# 400 INVALID_ARGUMENT. Every HTTP status is printed and any non-2xx FAILS the
# run — a past session parsed a 400 body as "zero testers".
set -euo pipefail

APK="$1"; NOTES="$2"; EMAILS="$3"
PROJECT_NUMBER="${FIREBASE_PROJECT_NUMBER:-891842778224}"
APP_ID="${FIREBASE_APP_ID:-1:891842778224:android:be1f87f7a29fa1d836d0b5}"
API=https://firebaseappdistribution.googleapis.com
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [ -z "${FIREBASE_TOKEN:-}" ]; then
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    FIREBASE_TOKEN="$(gcloud auth print-access-token)"
  else
    FIREBASE_TOKEN="$(gcloud auth print-access-token \
      --impersonate-service-account=factory-sa@factory-495015.iam.gserviceaccount.com \
      --scopes=https://www.googleapis.com/auth/cloud-platform 2>/dev/null)"
  fi
fi
H=(-H "Authorization: Bearer $FIREBASE_TOKEN" -H "x-goog-user-project: factory-495015")

call() { # call <label> <curl args...>; prints status, fails on non-2xx, body in $TMP/body
  local label="$1"; shift
  local code
  code=$(curl -sS -o "$TMP/body" -w '%{http_code}' "${H[@]}" "$@")
  echo "$label → HTTP $code"
  if [ "${code:0:1}" != "2" ]; then head -c 600 "$TMP/body"; echo; exit 1; fi
}
json() { python3 -c "import json,sys;d=json.load(open('$TMP/body'));print($1)"; }

APP="projects/$PROJECT_NUMBER/apps/$APP_ID"

# 1. Upload (long-running operation).
call "upload $(basename "$APK") ($(wc -c < "$APK") bytes)" -X POST \
  -H "X-Goog-Upload-Protocol: raw" -H "X-Goog-Upload-File-Name: $(basename "$APK")" \
  -H "Content-Type: application/octet-stream" --data-binary "@$APK" \
  "$API/upload/v1/$APP/releases:upload"
OP=$(json "d['name']")
echo "operation: $OP"

# 2. Poll until the release exists.
RELEASE=""
for i in $(seq 1 30); do
  call "poll operation ($i)" "$API/v1/$OP"
  if [ "$(json "d.get('done', False)")" = "True" ]; then
    if [ "$(json "'error' in d")" = "True" ]; then json "d['error']"; exit 1; fi
    echo "result: $(json "d['response'].get('result')")"
    RELEASE=$(json "d['response']['release']['name']")
    echo "release: $RELEASE (displayVersion $(json "d['response']['release'].get('displayVersion')") build $(json "d['response']['release'].get('buildVersion')"))"
    break
  fi
  sleep 5
done
[ -n "$RELEASE" ] || { echo "release never finished processing"; exit 1; }

# 3. Release notes (what the tester reads in the invite).
NOTES_JSON=$(python3 -c 'import json,sys;print(json.dumps({"releaseNotes":{"text":sys.argv[1]}}))' "$NOTES")
call "set release notes" -X PATCH -H "Content-Type: application/json" \
  --data "$NOTES_JSON" "$API/v1/$RELEASE?updateMask=release_notes.text"

# 4. Distribute to the named testers (Firebase creates missing testers and emails the invite).
EMAILS_JSON=$(python3 -c 'import json,sys;print(json.dumps({"testerEmails":[e.strip() for e in sys.argv[1].split(",") if e.strip()]}))' "$EMAILS")
call "distribute" -X POST -H "Content-Type: application/json" --data "$EMAILS_JSON" "$API/v1/$RELEASE:distribute"

# 5. Read back: the testers on the project, with lastActivityTime (an invite
#    stamps it too — only a LATER timestamp proves the build was picked up).
call "read back testers" "$API/v1/projects/$PROJECT_NUMBER/testers?pageSize=100"
python3 - "$TMP/body" "$EMAILS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
want = {e.strip().lower() for e in sys.argv[2].split(",") if e.strip()}
testers = d.get("testers", [])
print(f"project testers: {len(testers)}")
for t in testers:
    email = t["name"].split("/")[-1].lower()
    if email in want:
        print(f"  {email}: lastActivityTime={t.get('lastActivityTime')}")
missing = want - {t["name"].split("/")[-1].lower() for t in testers}
if missing:
    print(f"NOT registered as testers: {sorted(missing)}"); sys.exit(1)
PY
echo "distributed: $RELEASE"
