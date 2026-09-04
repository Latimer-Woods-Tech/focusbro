---
last_updated: "2026-07-26"
owner: focusbro
status: ratified
---

# FocusBro Execution Plan

This is the engineering execution companion to
[`BREAKOUT_PLAN.md`](./BREAKOUT_PLAN.md). The breakout plan owns product strategy
and learning gates. This plan owns sequencing, acceptance tests, rollout safety,
and the work required to run those experiments responsibly.

## Outcome

Move FocusBro from a strong prototype to a trustworthy founding-cohort product,
then scale only what produces retained accountability.

The order is:

```text
Contain avoidable risk
        ↓
Harden identity, delivery, and data
        ↓
Run the founding cohort
        ↓
Improve the measured bottleneck
        ↓
Earn referrals, voice, billing, and coaches
```

No stage is completed by merging code alone. It is completed by its acceptance
gate, including production verification where specified.

## Operating constraints

- Keep every PR reviewable and independently deployable; target fewer than 300
  changed lines and never exceed the repository's 500-line budget without an
  explicit exception.
- Use expand → migrate → contract for auth and schema changes.
- Never combine an auth migration, database migration, and UI redesign in one PR.
- Preserve legacy users through versioned, on-login migration paths.
- Default risky dormant surfaces to unavailable, not partially configured.
- Treat a webhook as accepted only after it is verified and durably recorded.
- Roll out high-risk changes to founder accounts first.
- Do not start broad distribution while the Trust Gate is red.
- Do not answer weak retention by adding tools, voice, billing, or gamification.

## Launch states

| State | Allowed | Required condition |
|---|---|---|
| Red | Founder dogfood only | Current state until containment items C1–C4 are live |
| Amber | Up to 25 observed founding users | Containment complete; core production canary green |
| Cohort | Recruit 50–100 users | Trust Gate complete; delivery ≥95% in the observed group |
| Growth | Scale winning organic creatives | Activation and retention gates in `BREAKOUT_PLAN.md` pass |
| Revenue | Voice/billing experiments | Retention gate passes and billing is rebuilt |

## Stage 0 — Contain risk

Target: 1–3 days. These are small, reversible PRs and should land before
recruiting beyond founder dogfood.

| ID | PR-sized action | Acceptance test | Rollback |
|---|---|---|---|
| C1 | Production-gate checkout, portal, webhook, and tier billing routes. Return 404 while `BILLING_ENABLED` is absent. Do not delete the historical module yet. | All four production routes are unavailable; existing accountability routes and `/health` remain 200. | Revert the route gate only after the rebuilt billing acceptance suite passes. |
| C2 | Remove `/debug-routes`, `/debug-api`, `/api/test`, and `/api/gallery/test` from production. Keep equivalent assertions in tests. | All four return 404 in production; `/health` still returns the public minimum. | Restore only behind an explicit non-production environment guard. |
| C3 | Make Telnyx inbound verification fail closed. Missing public key, timestamp, signature, or invalid signature must never reach message processing. | Signed fixture succeeds; unsigned/invalid/missing-config fixtures fail; live unsigned probe is rejected. | Roll back only by disabling inbound SMS entirely, never by accepting unsigned input. |
| C4 | Add immediate response headers: HSTS, `X-Content-Type-Options`, frame denial, strict referrer policy, and a minimal permissions policy. Start CSP in report-only mode because inline scripts currently prevent a strict policy. Fix the primary CTA contrast failure. | Headers are present on `/`, `/me/`, `/coach/`, and API responses; mobile accessibility remains ≥0.95 with no primary-CTA contrast failure. | Remove only the incompatible directive, not the complete header middleware. |
| C5 | Make CI truthful: remove `continue-on-error` from dependency installation and real docs checks; either fix or delete a check that cannot pass. | A deliberately broken install/docs fixture makes CI red; normal main is green. | Revert the faulty check, not strict failure behavior. |
| C6 | Replace the stale deploy title probe with a hard canary: retrying `curl --fail` for `/health`, expected build SHA, homepage accountability marker, and one expected unauthorized API response. | A stale build, 5xx, missing marker, or wrong auth status fails deployment. | Redeploy the last known good Worker; do not weaken the canary. |

### Containment gate

Amber cohort access is allowed only when:

- C1–C4 are live and verified;
- deploy canary is hard-failing correctly;
- production `/health` reports a fresh cron heartbeat;
- root and API dependency audits have no high or critical findings;
- no known secret is committed in the current tree.

## Stage 1 — Identity and session hardening

Target: 4–7 days across several PRs. Write a short ADR before choosing the final
session shape. The practical default is Workers-native, versioned password
hashing plus revocable server-side sessions; adopting the shared auth package is
preferred only if it supports this migration without a framework rewrite.

| ID | Sequence | Acceptance test |
|---|---|---|
| A1 | Add a versioned password format using Web Crypto PBKDF2 with a unique random salt and a cost calibrated to the Worker CPU budget. Continue verifying legacy 64-character SHA-256 hashes only for migration. After a successful legacy login, immediately replace the stored value. | New registrations never store a raw SHA-256 digest; legacy fixture logs in once and becomes versioned; wrong-password and timing-safe comparison tests pass. |
| A2 | Close the refresh flaw immediately: enforce expiration and a short refresh grace window, require the exact active server session, reject malformed claims, and rotate the session credential. | Arbitrarily old, revoked, inactive-user, wrong-session, and replayed refresh tokens all return 401. |
| A3 | Add server-side logout, logout-all, and session revocation. Store only a hash of the revocable credential. Add device/session timestamps without storing the full bearer token. | Logout invalidates the credential from another browser; database inspection finds no usable bearer token. |
| A4 | Migrate browser auth from long-lived `localStorage` bearer tokens to `HttpOnly; Secure; SameSite=Lax` cookies. Use a short overlap window that accepts the legacy bearer token, exchanges it once, then removes it. | Auth works after reload; JavaScript cannot read the session; CSRF tests cover all state-changing routes; legacy user migration is seamless. |
| A5 | Add account recovery and email verification, preferably a one-time magic link. Rate-limit by normalized account plus network signal without locking an entire NAT population. | Expired/replayed links fail; recovery revokes old sessions; successful login does not consume the failed-attempt budget. |
| A6 | After inline scripts are extracted in Stage 3, enforce CSP rather than report-only mode. | No CSP violations occur on critical journeys; a test inline script is blocked. **2026-09-04:** enforced on the surfaces that already run no inline script — `/guides/*`, `/follow-through-index.html`, `/api/public/*` — with the same policy string report-only on `/` and the signed-in pages until the extraction lands (`cspModeFor` in `api/src/index.js`; the deploy workflow reads both live headers). The three live report-only blockers were allowlisted from observation: `style-src 'unsafe-inline'` (the shell's own `<style>` and AdSense auto-ad style attributes; script-src stays strict), the ad-traffic-quality hosts in `script-src`/`img-src`, and the zone-injected Cloudflare insights beacon. |

### Stage 1 execution record

As of 2026-07-25, A1–A5 are implemented, tested, deployed, and verified at the
production build SHA recorded below. A6 remains intentionally sequenced after
Stage 3; enforcing the current report-only policy before extracting inline
scripts would break the product.

| Item | Delivery record | Production evidence |
|---|---|---|
| A1 | PRs #176 and #191 | Versioned PBKDF2 new-write, legacy dual-read/upgrade, and a live Worker-runtime cost canary |
| A2 | PR #177 | Strict refresh grace, active-session lookup, rotation, and replay rejection |
| A3 | PRs #179–#180 | Hash-only credentials, logout, logout-all, and server revocation |
| A4 | PRs #181–#184 | Secure cookie sessions, CSRF enforcement, one-time bearer exchange, and no credential-bearing auth JSON |
| A5 | PRs #185–#190 | Hashed single-use action tokens, reset/session revocation, email verification, normalized account/network limits, failed-login-only budgets, and Resend delivery |

The Stage 1 gate is green at build
`5efeea66c0792ee025805b93fba4328b3ecf09a9`: 780 unit tests, the Playwright
critical-journey smoke test, deployment canary, and live auth probes pass.
Transactional email uses the GCP-managed `RESEND_API_KEY` with the verified
`support@latwoodtech.com` sender.

The final synthetic production journey proved:

1. registration creates a 100,000-iteration PBKDF2 hash that the Workers
   runtime can execute;
2. the verification message reaches a real Gmail inbox, confirmation succeeds,
   session state becomes verified, and replay returns 400;
3. the reset message reaches the inbox, confirmation changes the password and
   revokes the pre-reset cookie, while replay returns 400;
4. the new password logs in without a bearer token in JSON;
5. a deliberately expired reset row returns 400; and
6. the disposable user, sessions, tokens, cookies, and temporary credentials
are removed after the test.

### Managed compatibility debt

The legacy password and bearer-session readers remain intentionally enabled for
existing-user migration, not as a new authentication path. A read-only
production D1 inspection on 2026-07-26 found one legacy session credential and
one legacy SHA-256 password hash. Do not remove either compatibility branch
until both counts are zero; doing so now would strand a real user. Recheck the
counts before every auth-retirement proposal and record the result with its PR.

### Identity rollout

1. Deploy password dual-read/new-write.
2. Verify founder and synthetic legacy accounts.
3. Deploy revocable sessions while retaining bearer exchange.
4. Move the UI to cookies.
5. Observe auth errors for 48 hours.
6. Remove legacy token issuance, then legacy token acceptance in a later PR.

Never force-reset all cohort passwords merely to simplify the migration.

## Stage 2 — Durable schema, webhooks, and sync

Target: 5–8 days. This stage may overlap with the observed 25-user group after
the containment gate, but must finish before the 50–100-person cohort.

### Database migrations

| ID | Action | Acceptance test |
|---|---|---|
| D1 | Inventory the deployed schema and create immutable numbered D1 migrations. Establish one canonical definition for fresh databases and explicit rollback comments. | A blank local D1 reaches the expected schema using migrations only; production drift report is empty. |
| D2 | Deploy the migration baseline while runtime initialization still exists as a compatibility guard. Record schema version in health/operator diagnostics. | Staging and production migration dry runs pass; existing data counts remain unchanged. |
| D3 | Remove all `CREATE`, index, and `ALTER` work from fetch and scheduled handlers. Fail deployment on migration failure rather than serving a partial schema. | Cold `/health` performs no DDL; fetch and cron tests pass against migrated D1; p95 cold latency does not regress. |
| D4 | Reconcile `subscriptions` and `stripe_subscriptions`. Keep neither active billing contract until Stage 5 selects the canonical schema. | Fresh schema has one documented future billing model; dormant routes remain unavailable. |

### D1 migration execution record

As of 2026-07-26, D1–D3 are complete at production build
`b0281efaaf149ad70b21d8ee329fc47b133a1b62`.

- PR #196 introduced the immutable `0000` production-compatible baseline,
  configured Wrangler migration discovery, documented the operating workflow,
  and made CI apply the complete migration chain to an empty local D1.
- The existing production schema was inventoried before its empty migration
  ledger was baselined. Its three exact applied filenames now match the
  repository, no remote migrations remain pending, and the pre/post real-user
  count was unchanged.
- PR #197 removed runtime initialization from fetch and cron, adds the expected
  `schema_version` to `/health`, and makes deploy apply reviewed D1 migrations
  before publishing the Worker. A cold health test proves no D1 access or DDL.

D4 is complete: `subscriptions` is the single documented future billing
contract in both the migration baseline and compatibility schema;
`stripe_subscriptions` is no longer created for fresh databases. The legacy
billing implementation remains gated behind an absent `BILLING_ENABLED` flag
until Stage 5 rebuilds it against this contract with its own acceptance suite.

PR #216 completed the previously unrepresented sync persistence contract at
production build `ae08411c4e8cdc71ed55ac07fe6131deb6b2e7eb`: migration `0006`
adds `sync_logs.data_size` and the `devices` table used by the sync lifecycle.
PR #217 makes the empty-D1 CI integration step query those fields, plus sync
snapshot revisions, after every full migration chain. This prevents the
runtime/migration drift that exposed the gap.

### Webhook durability

| ID | Action | Acceptance test |
|---|---|---|
| W1 | Add a webhook inbox keyed by provider event ID with received, processing, completed, and failed states. Verify signature before insertion; deduplicate before side effects. | Duplicate and reordered Telnyx fixtures cause one state transition and at most one reply. |
| W2 | Process STOP synchronously after durable receipt; return 2xx only after durable acceptance. Return 4xx for invalid signatures and 5xx for retryable processing failures. | A transient D1/send failure is retried; STOP is never silently lost; failed rows are visible to operations. |
| W3 | Add oldest-unprocessed age, failed-event count, and replay tooling. Add a queue only when D1 inbox throughput proves insufficient. | An intentionally failed fixture appears in health/metrics and can be safely replayed once. |

### Sync boundaries

| ID | Action | Acceptance test |
|---|---|---|
| S1 | ✅ Shipped: 1 MiB byte limit, pre-parse content-length gate, and structural snapshot validation. | Oversized and malformed bodies return 413/400 without D1 or KV writes. |
| S2 | ✅ Shipped: revision IDs and per-user idempotency keys prevent duplicate retries; stale bases return a recoverable 409. | Duplicate upload creates one revision; stale revision returns 409 with recovery metadata. |
| S3 | ✅ Shipped: 60 validated uploads/hour, 10 MiB/account cap, 30-snapshot retention, and synced-data deletion from D1 and KV. | Quota and retention tests pass; deletion removes user snapshots from D1 and KV. |

## Stage 3 — Risk-weighted quality and maintainability

Target: 4–7 days, delivered incrementally.

### Stage 3 execution record

As of 2026-07-26, the highest-risk sync and browser contracts have additional
coverage and are production-verified:

- PR #216 added lifecycle tests for device registration/deactivation, sync
  audit logging, restoration, and offline-queue merging. The API suite is at
  812 tests, with `sync.js` at 89.69% line coverage.
- PR #217 extends the fresh-D1 CI integration probe to the exact sync tables
  and columns used by those lifecycle paths.
- PR #218 expands the mobile Playwright suite from the acquisition handoff to
  the first accountability journey: tagged founder challenge → account
  creation → prefilled first word → attributed commitment request.

The remaining Stage 3 work is deliberately still open: real auth-lifecycle D1
integration, response/reschedule browser coverage, mobile keyboard and
accessibility checks, push-boundary tests, Lighthouse regression protection,
and the static-asset/module split. These should remain independently
reviewable PRs rather than one broad refactor.

### Tests and CI

1. Add real-D1 integration coverage for fresh migrations and the auth lifecycle.
2. Add signed Telnyx fixtures covering duplicates, STOP, retry, and replay.
3. Keep billing gated; add Stripe fixtures only during the Stage 5 rebuild.
4. Expand Playwright to:
   - landing → registration/login → commitment;
   - commitment → response → reschedule;
   - logout/recovery;
   - mobile keyboard and accessibility;
   - push permission UX with delivery mocked at the boundary.
5. Eliminate all lint warnings and enforce `--max-warnings 0`.
6. Ratchet coverage by risk and module, not test count. Require at least 80% line
   coverage for auth, consent/webhooks, commitments, and migrations before cohort
   scale; do not chase generated HTML coverage.
7. Add Lighthouse best-practices and SEO categories. Raise performance gradually
   from the measured baseline; use the median of three mobile runs and fail on a
   sustained regression rather than one noisy run.
8. Update the Workers compatibility date in a dedicated PR with dry-run, tests,
   staging verification, and production canary.

### Code shape

Keep one Worker initially, but divide ownership:

```text
worker entry
├── response/security middleware
├── auth routes and session service
├── accountability routes
├── consent and webhook routes
├── sync routes
├── operator/metrics routes
└── static asset routing
```

Move the 234 KB homepage and static pages to Workers Assets. Split the acquisition
shell, authenticated accountability app, and wellness toolkit into browser
modules. Load toolkit code only when requested. Do not introduce React, Hono, or
separate services merely to accomplish this.

Acceptance:

- the Worker entry is composition rather than business logic;
- critical routes have one shared auth path and one response/header path;
- root transfer and main-thread work improve without breaking deep links;
- the acquisition page remains immediately usable on a low-end mobile profile.

## Stage 4 — Run the learning plan

This is operating work, not a software phase. Begin the observed group after the
Containment Gate and the full cohort after the Trust Gate.

### Trust Gate

- versioned password migration and revocable sessions are live;
- Telnyx fails closed and webhook replay is proven;
- DDL is absent from runtime request/cron paths;
- critical Playwright journeys are green;
- deployment identifies and verifies the exact release;
- delivery success is at least 95%;
- no P0/P1 security issue from this plan remains open.

### Founding-cohort protocol

1. Publish the five founder demonstrations in `DISTRIBUTION.md`.
2. Observe ten people without coaching the interface.
3. Record friction categories, never private task content.
4. Review the scorecard after every 20 qualified visits.
5. Change one bottleneck per experiment.
6. Recruit 50–100 only after delivery and activation clear their gates.
7. Interview retained and quiet users after D1; repeat after D7.

Add behavioral cohort dimensions before the full cohort:

- challenge/task category;
- time-to-start bucket;
- check-in delay bucket;
- push versus text;
- ally versus hype;
- recurring versus one-time;
- first outcome;
- creative and acquisition source.

Do not store raw task text in analytics. Use a user-selected or derived coarse
category with an explicit unknown value.

### Decision tree

| Signal | Response |
|---|---|
| Landing activation <10% after 20 qualified visits | Rewrite the hook/CTA; do not change the accountability mechanic yet. |
| Activation 10–25% | Test promise clarity and reduce auth/consent friction. |
| Activation >25%, delivery <95% | Stop promotion and fix delivery. |
| Delivery ≥95%, response <50% | Test timing, channel, and response affordance. |
| Response healthy, D1 <30% | Improve next-word bridge, recurring rhythm, and one-tap quiet-user feedback. |
| D1 healthy, D7 <15% | Improve task sizing, weekly proof, and return cadence. |
| D1/D7 pass | Unlock the smallest referral experiment. |

**Measured 2026-09-04 (D1 ledger, not a dashboard):** 928 recorded visits,
at most four registration attempts, two accounts, zero commitments — landing
activation effectively 0%. The hook already collected the word on the homepage;
the wall was the email-and-password door on `/me/` in front of the first word.
Response taken (R-312): the door moved, not the mechanic — a guest account is
created on the first word, push is asked for on the same gesture, the account
is claimed later. Push had also never been subscribed by any code path
(`push_subscriptions` empty), so even a registered word would have been
delivered to nothing; the same slice wires it. Next read: the funnel events
`guest_started` → `commitment_created` → `push_permission` after real visits.

For quiet-user learning, ask one optional one-tap question: task too large,
wrong time, wrong channel, wrong tone, or reminders not wanted. One response is
enough; do not create a survey funnel.

## Stage 5 — Earned expansion

These remain locked until the retention gate passes.

### Referrals

Ship one specific-word challenge link, activated-referral attribution, and a
permissioned kept-word artifact. Pass only if:

- at least 15% of activated users share or invite;
- at least 20% of invitees create a commitment;
- referred-user retention is no worse than creator-acquired retention;
- five users explicitly permit outcome-story use.

### Voice

Test one fixed, consented, frequency-capped call intervention. Compare push,
push→text, and push→text→call. Voice earns expansion only if its incremental
retention or task-start lift justifies cost and annoyance.

### Billing

Rebuild rather than re-enable the dormant module:

- use the approved Workers Stripe wrapper and Checkout Sessions;
- use Customer Portal for subscription management;
- include stable idempotency keys on mutations;
- verify the raw webhook body once;
- record event IDs before processing;
- return retryable failures correctly;
- use one canonical subscription schema;
- cover duplicate and out-of-order events;
- release behind `BILLING_ENABLED` to founder/test accounts first.

Payments stay unavailable until a real test-mode subscription completes checkout,
webhook entitlement, portal management, cancellation, retry, and reconciliation.

### Coaches

Pilot five ADHD coaches with three to ten consented clients each. Build only the
weekly artifact, invitations, cadence ceiling, between-session note, and simple
billing needed by that cohort.

## Execution board

Create one issue per row and maintain these fields:

- ID and stage;
- owner: agent, founder, or time/external;
- dependency IDs;
- risk: low, medium, high;
- acceptance command/probe;
- rollout cohort;
- rollback action;
- production evidence;
- state: queued, active, deployed, verified, or blocked.

Recommended first PR order:

1. C1 billing gate.
2. C2 production debug removal.
3. C3 Telnyx fail-closed.
4. C4 security headers and contrast.
5. C5 strict CI.
6. C6 release-aware deploy canary.
7. A1 versioned password migration.
8. A2 refresh/session validation.
9. A3 revocation and logout.
10. D1–D3 numbered migrations and runtime-DDL removal.
11. W1–W3 webhook inbox, retry, and replay.
12. A4 cookie migration.
13. S1–S3 sync boundaries.
14. Stage 3 critical journeys and modularization.

High-risk PRs should not run concurrently against the same auth, schema, or
Worker-entry files. Documentation, test fixtures, and independent UI corrections
may run in parallel.

## Definition of done

An item is done only when:

1. its acceptance tests pass locally and in CI;
2. generated HTML is rebuilt when its source changes;
3. migrations are dry-run before production application;
4. the deployed branded-domain behavior is verified with `curl` or a real browser;
5. monitoring shows no regression during the stated observation window;
6. evidence is linked from the issue/PR;
7. the execution board and relevant plan status are updated.

“CI green,” “code complete,” and “deployed” are intermediate states, not done.
