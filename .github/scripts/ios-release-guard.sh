#!/usr/bin/env bash
# iOS signed-job guard (jc-security #30297/#30314). Runs BEFORE any credential step.
# Inputs come ONLY from env vars, never from interpolated shell text:
#   EVENT_NAME MODE REF SHA EXPECTED_SHA VERSION_INPUT SKIP_UPLOAD_INPUT PKG_VERSION
# Writes VERSION_NAME and UPLOAD to $GITHUB_OUTPUT (stdout if unset). Any violation: ::error:: + non-zero exit.
# Each check is ONE line on purpose: ios-release-guard.test.sh deletes them one at a time (proof of rejection).
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

[ "${EVENT_NAME:-}" = "workflow_dispatch" ] || fail "signed run requires a manual workflow_dispatch"
[ "${MODE:-}" = "signed" ] || fail "mode must be exactly signed"
[ "${REF:-}" = "refs/heads/main" ] || fail "signed run is allowed on refs/heads/main only"
[[ "${EXPECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "expected_sha must be 40 lowercase hex characters"
[ "${EXPECTED_SHA:-}" = "${SHA:-}" ] || fail "expected_sha must equal the commit this run is on"

V="${VERSION_INPUT:-}"
if [ -z "$V" ]; then V="${PKG_VERSION:-}"; fi
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version must be exactly x.y.z (got a non-matching value)"

UPLOAD=false
if [ "${SKIP_UPLOAD_INPUT:-}" = "false" ]; then UPLOAD=true; fi

{
  echo "VERSION_NAME=$V"
  echo "UPLOAD=$UPLOAD"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
