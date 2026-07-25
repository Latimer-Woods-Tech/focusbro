---
last_updated: "2026-07-25"
---

# ADR-0002: Use hashed, revocable Worker-native sessions

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** Founder and implementation agent

## Context

FocusBro currently issues 30-day signed bearer tokens and stores the complete
bearer value in D1. A2 bound new tokens to a server session, constrained refresh
to a five-minute grace window, and made rotation replay-safe. Three risks remain:

1. a D1 read exposes immediately usable bearer credentials;
2. signature verification alone cannot make logout or administrative revocation
   take effect immediately; and
3. browser `localStorage` exposes the bearer to any successful script injection.

The app is a single Cloudflare Worker backed by D1 and a vanilla browser client.
Replacing the whole identity stack before the first cohort would create more
migration risk than it removes. A4 already owns the separate browser move to
`HttpOnly` cookies.

## Decision

Use a Workers-native, server-revocable session with a staged browser migration:

1. Keep the signed credential during the compatibility window. Every newly
   issued credential carries a session ID (`sid`) and unique token ID (`jti`).
2. Store only `SHA-256(credential)` in `sessions.token_hash`. This is safe for a
   high-entropy credential and supports indexed exact lookup; password hashing
   rules do not apply. The legacy `token` column remains temporarily for
   dual-read migration but receives no new bearer values.
3. Require both cryptographic validation and an exact active D1 session for
   every authenticated request. Validate the user, session ID, credential hash,
   revocation state, and expiry. Signature validity alone is insufficient.
4. Rotate the credential hash with compare-and-swap on refresh. The old hash is
   invalid immediately, including when two refresh requests race.
5. Implement current-session logout and logout-all as server-side revocation.
   Record `last_activity` and `revoked_at`; never log or return a stored bearer.
6. Support existing sessions without a forced sign-in: look up the exact legacy
   `token` only during the migration window, enforce its active session, and
   replace it with a hash on successful refresh. Remove legacy reads only after
   the observed cohort has crossed the migration window.
7. In A4, transport the same revocable credential in an
   `HttpOnly; Secure; SameSite=Lax` cookie and shorten access lifetime. Cookie
   transport is deliberately separate from the server-session decision.

## Consequences

- **Positive:** logout, logout-all, rotation, and administrative revocation take
  effect immediately across browsers; a database leak contains no usable new
  bearer credentials.
- **Positive:** rollout is incremental and does not force-reset passwords or
  sign out every existing cohort member.
- **Cost:** authenticated requests add one indexed D1 read until a safe
  cache/revocation design is proven. Correct revocation wins over premature
  read optimization.
- **Cost:** the legacy bearer column must remain until migration telemetry shows
  it is unused, so dual-read logic needs an explicit removal task.
- **Risk accepted:** `localStorage` exposure remains until A4. A3 reduces server
  credential risk but does not claim to solve browser script compromise.

## Verification

- New session rows contain a hash and no usable bearer token.
- A token from a logged-out session fails from another browser.
- Logout-all invalidates every session owned by the user.
- Revoked, expired, wrong-session, stale-hash, and replayed credentials return
  401.
- A legacy fixture remains usable, refreshes once, and becomes hash-only.
