---
last_updated: "2026-10-05"
owner: focusbro
status: active
---

# FocusBro QA Remediation Plan — 2026-10

**Source:** a five-lane QA sweep of production run against `76ddb9e`, then re-checked on `7368b81` (2026-10-05). The five lanes:
- full-suite and mutation testing
- local end-to-end with a real SQLite D1
- live browser, accessibility, Lighthouse and Cloud Run vantage
- live API contract, security probing and a bounded load ramp
- semantic code review

The raw lane reports are attached to the tracking issue, [#391](https://github.com/Latimer-Woods-Tech/focusbro/issues/391), as evidence. This document holds the
**requirements** for each defect, the **engineering rules** every fix follows, and the **order**
the fixes land in.

**Verdict at `7368b81`:** not ship-shape for opening the closed test.
- **Solid:** the platform. That covers security posture, performance, test stability, account deletion and authorization.
- **Broken:** the core promise ("I said I'd do it → I did it") for users without web push, and several silent failure modes in the delivery engine and the caching layer behind it.

## 1. Engineering rules (Definition of Done for every item)

1. **Test that fails first.**
   - Every fix lands with a test that fails on `main` and passes on the branch, in the same PR (Standing Law 1, proof-of-rejection).
   - Use a real SQLite D1 (`helpers/real-d1.js`) wherever the defect involves SQL. A mock cannot prove a query.
2. **One item per PR, small.**
   - Target under 300 changed lines; the repository budget is 500.
   - No stacked PRs: sequence by merge, not by base branch.
   - At most 3 open PRs (ADR-0002).
3. **Migrations are additive and idempotent.**
   - Use `CREATE … IF NOT EXISTS` and nullable `ADD COLUMN`. Never drop or rename in the same release that stops using a column.
   - Run the `schema-parity` test.
   - Reverting the code must leave the schema valid.
4. **Risky client behaviour ships behind a kill switch.**
   - The service worker especially: it must carry a self-unregister path and be verified on a real browser before rollout.
5. **Verification is a product read, not CI.**
   - After merge, `deploy.yml` must succeed.
   - `curl https://focusbro.net/health` must return 200 with the new `build_sha` and `schema_in_step: true`.
   - The defect's own probe must be re-run against prod, and for writes there must be a D1 read-back. CI green is "compiled", not "works".
6. **Silent failures get a signal.**
   - Any path that today swallows a failure (a cron stage `catch`, a 200 that recorded nothing) must emit a counted event or `/health` field when it fires.
7. **Rollback is pre-declared.**
   - Each PR body states its rollback: `git revert` plus redeploy, a flag flip, or a migration that is safe to leave in place.
8. **Design law holds.**
   - New copy must pass `design-law.js` and `shell-copy-law.test.js`.
   - No resetting counters and no opacity-dimmed text.

## 2. Requirements register

Severity scale:
- **P0** blocks opening the closed test.
- **P1** must be fixed before scaling distribution.
- **P2** is a real defect with a bounded blast radius.
- **P3** is hygiene.

Source lanes:
- `R` code review
- `F` local end-to-end
- `S` suite
- `L` live browser
- `A` live API

### WS1 — Core loop correctness

**FBQ-01 · P0 · An unreachable check-in cannot be answered** (R P0-1)
- **Defect:**
  - With no active push subscription, the cron parks the due row as `skipped / no_subscription` (`checkins-cron.js` `deliverPush`).
  - The answer query only resolves rows that are `sent`, `deferred` or `awaiting_time`, or `pending` and due (`accountability.js` `resolveCheckinOutcome`).
  - The result is HTTP 200 "Got this one already" with nothing written. This affects every Android-app user and every web user who declined push. The native "I did it" button (#389) treats the 200 as success.
- **Requirements:**
  - R1. A due check-in that was skipped because no channel could reach the person (`no_subscription`, `push_not_configured`, `text_is_pro_*`) can be answered "kept" or "reschedule" from `/me/`, the native notification and the list fallback.
  - R2. A `skipped` row that aged out (`stale`) or was settled stays unanswerable. The double-answer guard is unchanged.
  - R3. When a request writes nothing, the response says so in a machine-readable field (`recorded: false`). The native bridge opens the word on `recorded: false` instead of reporting success.
  - R4. The answer credits exactly one occurrence. Snooze must not pull tomorrow's pending row into today.
- **Acceptance:**
  - A real-D1 test. A word with no subscription goes through a cron tick, then "I did it": the response is 200 with `recorded: true`, the row is `kept`, and `total_kept` is 1.
  - The same test on a `stale` skipped row writes nothing.
  - Prod: create a guest word, let it tick, answer it, read back the row.

**FBQ-02 · P1 · An answer binds to the exact occurrence it was offered for** (R P1-5, F3)
- **Defect:** the reply ticket (72 h) and the native button resolve the word's *soonest due* row, not the signed check-in. A stale notification credits today or tomorrow; `outcome=missed` through a ticket resets the streak.
- **Requirements:**
  - R1. The ticket route resolves only `claim.checkinId`, only while that row is open, and only with `kept`.
  - R2. The native notification carries the `checkin_id` it was scheduled for, and the answer resolves that row.
  - R3. An answer for a settled or other occurrence writes nothing and returns `recorded: false`.
- **Acceptance:** real-D1 tests for yesterday's ticket on today, a replayed ticket, and `missed` through a ticket. All must write nothing and leave `current_streak` unchanged.

**FBQ-03 · P1 · Mutable reads are never served stale** (F F1, R P2-5)
- **Defect:**
  - The commitments, streak, kept-log and word-detail endpoints send `Cache-Control: private, max-age=300` with no `Vary`.
  - After "I did it", the card still offers the button, and a rescheduled word is missing for up to 5 minutes.
  - After logout, the native bridge can re-sync the previous user's reminders from the cache.
- **Requirements:**
  - R1. Every authenticated read whose data changes from user action is `Cache-Control: no-store`.
  - R2. The client fetches for those reads also use `cache: 'no-store'` (defence in depth).
  - R3. Static and public responses keep their caching.
- **Acceptance:**
  - A routing test asserts `no-store` on each listed endpoint.
  - A browser test answers a word and sees the card settle without a reload delay.

**FBQ-04 · P1 · The service worker serves the current deploy** (R P1-1, R P2-6, L P2-3)
- **Defect:**
  - The cache name `focusbro-v1` is constant and every non-API GET is cache-first, so deploys never reach browsers that registered the worker.
  - Authenticated `/api/*` GETs are cached.
  - Sign-out clears neither the caches nor the push subscription.
  - The worker is only registered on the push path, so the "offline" claim is false.
- **Requirements:**
  - R1. The cache name derives from `BUILD_SHA`. `activate` deletes every other cache. Use `skipWaiting` plus `clients.claim`.
  - R2. Navigations and same-origin scripts are network-first with a cache fallback. Never cache `/api/*`.
  - R3. Sign-out calls a worker message that clears caches, then `pushSubscription.unsubscribe()` plus server deactivation.
  - R4. A kill switch: `/sw.js` served with `?off=1`, or a flag, unregisters itself.
  - R5. Decide whether offline is a promise. **Default:** register the worker on the shell so the shell and `/me/` load offline from the last good copy. Otherwise remove any offline claim from copy and the manifest.
- **Acceptance:**
  - Playwright installs the worker at build A, the server switches to build B, a reload serves B.
  - Offline reload of `/` works.
  - After sign-out, `caches.keys()` is empty of authenticated data.
  - Prod: a browser that ran the old worker picks up the new build within one reload.

### WS2 — Delivery engine (cron)

All of these touch `checkins-cron.js`. They land **serially** in the order shown to avoid conflicts.

**FBQ-05 · P1 · Claim rows before sending** (F F2, R P2-4)
- **Defect:**
  - The delivery `UPDATE` is unconditional, so a user's answer during send is overwritten back to `sent`, and a second "I did it" double-credits.
  - Overlapping ticks, or `run-checkins` racing the cron, can double-send.
- **Requirements:**
  - R1. Claim with `UPDATE … SET status='sending', lease_until=? WHERE id=? AND status='pending'` and proceed only if `changes=1`.
  - R2. The final update is conditional on `status='sending'`.
  - R3. An expired lease returns to `pending`.
  - R4. A unique index on `(commitment_id, scheduled_for)` stops a duplicate next occurrence (additive migration).
- **Acceptance:**
  - A test with two concurrent ticks sees one send.
  - An answer during send survives, and `total_kept` is 1 after a double tap.

**FBQ-06 · P1 · Held-back rows do not occupy the batch** (R P1-2, F F5)
- **Requirements:**
  - R1. A row held for quiet hours or the night guard gets `next_attempt_at`, and the scan filters `next_attempt_at IS NULL OR <= now`.
  - R2. No per-tick query cost for held rows.
- **Acceptance:** 105 held text rows plus 1 due push row: the push is sent on the first tick.

**FBQ-07 · P1 · Return nudges reach newly dormant users; the query is bounded** (R P1-3, F F4/F6)
- **Requirements:**
  - R1. Exclude already-nudged users in SQL. Move the latch to D1, or anti-join on `return_nudge_sent`.
  - R2. Compare times in one format; normalise the latch to `datetime()` format.
  - R3. The candidate query is linear, not quadratic, in events per user. It needs an index on `analytics_events(user_id, created_at)` and must finish in under 1 s at 10k events per user.
- **Acceptance:**
  - 60 latched users plus 1 fresh dormant user: the fresh one is nudged.
  - The timing test passes.

**FBQ-08 · P1 · Push sending is bounded and hardened** (R P1-8, R P2-12)
- **Requirements:**
  - R1. Subscribe only accepts endpoints on known push-service hosts (FCM, Mozilla autopush, WNS, Apple), with length limits.
  - R2. At most 5 active subscriptions per user; the oldest is deactivated.
  - R3. `sendWebPush` uses `AbortSignal.timeout(5000)`.
  - R4. Send `Urgency: high`, with a TTL aligned to the staleness window.
  - R5. 400 and 403 deactivate the subscription, the same as 404 and 410.
- **Acceptance:** tests for a rejected foreign host, the 6th subscription, and a hung endpoint (the tick completes).

**FBQ-09 · P2 · A cron tick stays inside platform limits and reports partial work** (F breaking points)
- **Defect:**
  - The worst-case tick makes about 1,154 D1 calls, over the 1,000-per-invocation cap.
  - The late stages fail inside `catch` while the heartbeat stamps OK.
- **Requirements:**
  - R1. A per-tick subrequest budget, with stages yielding when it is spent.
  - R2. Use `DB.batch` for the per-row multi-statement writes.
  - R3. `/health.cron` reports the stages skipped or failed in the last tick.
  - R4. Batch-write the multi-statement user writes too: create, resolve, reschedule, edit and release.
- **Acceptance:**
  - A worst-case fixture tick stays under 900 calls.
  - A forced stage failure shows on `/health`.

### WS3 — Coach and SMS

**FBQ-10 · P1 · Coach tables exist in prod; a client can leave a coach** (R P1-4)
- **Defect:**
  - `operators`, `operator_clients`, `coach_operators` and `coach_checkin_config` are created only by `initializeDatabase`, which nothing calls. No migration creates them.
  - No client route withdraws from an active coach link, which contradicts the privacy policy.
- **Requirements:**
  - R1. Migration `0009` with the four `CREATE TABLE IF NOT EXISTS` statements, byte-matching the runtime definitions.
  - R2. Bump `D1_SCHEMA_VERSION`.
  - R3. `schema-parity` covers the four tables.
  - R4. `DELETE /api/coach/link` (client side) ends the link and stops coach visibility.
  - R5. Remove the dead `initializeDatabase` table definitions once the migration is the source.
- **Acceptance:**
  - `/health` shows `schema_applied` = 0009.
  - Prod `sqlite_master` lists the four tables, read through the deploy migration step's output.
  - A test covers a client leaving: the coach detail returns 404.

**FBQ-11 · P1 · Replies to the escalation text are answered** (R P1-6)
- **Requirement:** the inbound SMS handler also matches open `push` rows with `escalated_at IS NOT NULL` for the sender's user.
- **Acceptance:** a real-D1 test where a "DONE" reply to an escalated push row resolves it kept.

**FBQ-12 · P1 · Texts go only to verified, unique numbers** (R P1-10)
- **Requirements:**
  - R1. A phone number is granted only after a one-time code sent to it is confirmed.
  - R2. A verified number is unique across accounts.
  - R3. Inbound STOP revokes every account holding that number.
  - R4. Until R1 ships, an unverified number does not receive texts. **Default ruling:** unverified numbers fall back to push.
- **Acceptance:**
  - A test where A cannot receive texts at B's unverified number.
  - A test where STOP revokes every match.

### WS4 — Security hardening

**FBQ-13 · P1 · The login limit stops guessing** (R P1-7, F F10)
- **Requirements:**
  - R1. When an account is limited, return 429 before password verification, including for the correct password.
  - R2. Add an IP-wide limit across accounts.
  - R3. Make limiter increments atomic. Concurrent requests must not bypass the guest and login limits (40 concurrent creates all succeeded).
- **Trade-off:** R1 lets an attacker lock a known account for the window. Mitigate with a short window plus the per-IP key; password reset is unaffected.
- **Acceptance:**
  - The correct password while limited returns 429.
  - 40 concurrent guest creates give at most 10 successes.

**FBQ-14 · P1 · Founder privilege is bound to identity, not a registrable email** (R P2-10, demonstrated live on 2026-10-05)
- **Defect:** founder metrics and Telnyx webhook replay trust `FOUNDER_EMAIL`, which is public, without checking `email_verified_at`. On 2026-10-05 the QA probe could register that address in prod.
- **Requirements:**
  - R1. Founder access requires a pinned founder `user_id` (a secret) **and** a verified email.
  - R2. Constant-time comparison of `CRON_TRIGGER_KEY`.
- **Acceptance:** a test where an unverified account with the founder email gets 401 on `/api/internal/metrics` and on the replay route.

**FBQ-15 · P1 · Client events cannot forge public or founder metrics** (R P1-9)
- **Requirements:**
  - R1. `/sync/events` accepts only an allowlist of client-originated types. Server-only types are rejected: `commitment_kept`, `checkin_delivered`, `return_nudge_sent` and `acquisition_*`.
  - R2. Clamp `at` to the range now − 7 d … now + 5 min.
  - R3. Rate-limit the `/api/acquisition/*` endpoints.
  - R4. A missing Origin header on a cookie-authenticated mutation is rejected (S P2).
- **Acceptance:** tests for each rejected type and for the clamp.

**FBQ-16 · P1 · Preview builds cannot touch production data** (R P3, elevated)
- **Defect:** the preview KV id equals prod, and preview URLs run with the prod D1 and KV bindings.
- **Requirements:**
  - R1. Preview environments bind separate D1 and KV resources, or preview URLs are disabled.
  - R2. A config test fails if any non-production env shares a production resource id.
- **Acceptance:** the test, plus `wrangler.toml` reviewed.

**FBQ-17 · P2 · Input and abuse limits** (A P2-1, F F8/F9/F12/F13, R P3)
- **Requirements:**
  - R1. Rate-limit `POST /api/room/heartbeat` and validate `client_id`.
  - R2. Return 400 (not 500) for out-of-range `start_at` and for malformed audio paths.
  - R3. Validate the IANA time zone and cap it at 64 characters.
  - R4. Cap active commitments per user (default 50).
  - R5. A password minimum that rejects all-digit passwords shorter than 12 characters.
  - R6. Generate ids with `crypto.randomUUID`.
  - R7. `/auth/*` requires `application/json` (login CSRF).
  - R8. Paginate `/api/commitments`.
  - Accepted, documented risk: the register 409 existence oracle, behind a 10-per-15-minute throttle.

### WS5 — Product correctness

**FBQ-18 · P2 · The free-text time parser never schedules a surprise night or near-instant nudge** (R P2-1)
- **Requirements:**
  - R1. An unknown unit after a number returns null, which re-asks the person.
  - R2. A bare `h` or `h:mm` with h ≤ 12 resolves to the next daytime instance, the same rule already used for "tomorrow 3".
  - R3. Never resolve into 00:00–06:00 without an explicit "am".
  - R4. A non-existent spring-forward time resolves forward (02:30 becomes 03:30).
- **Acceptance:** a table test with every case from the review (`5:30`, `4:15`, `3`, `12`, `in 2 months`, `in 5 years`, `in 10 secs`) plus the DST case.

**FBQ-19 · P2 · Settled-state edges are honest** (R P2-2/P2-3, F F7, R P3)
- **Requirements:**
  - R1. A stranded one-shot that is auto-closed on return is labelled as closed, not "Moved — still on", or it gets a real successor.
  - R2. "Try again" on a missed one-shot creates a new word.
  - R3. "I did it" on a future one-shot either records it or says plainly that it is not due yet.
  - R4. `release` does not overwrite `kept`.
  - R5. Free users' skipped text rows still appear in the list.

**FBQ-20 · P2 · No resetting counters anywhere** (R P2-7, R P3)
- **Requirement:** remove "current run" and "in a row" from the report, `/me/report`, the coach card and the streak copy, replacing them with only-climbing totals. Remove `opacity` dimming on text (`.pending`, `.saved-mix-del`).
- **Acceptance:** extend the design-law scan to `report.js` and the coach views.

**FBQ-21 · P2 · Policy and money truth**
- **Requirements:**
  - R1. The privacy policy states what a coach sees (word titles, schedules, time zone, cues) and that a coach's voice and opener shape messages (R P2-8).
  - R2. When `data-native-app` is set server-side, the app shows no Pro framing (R P2-13, Play policy). **Default:** hide it.
  - R3. Reconcile-by-read also reads refunds and disputes and revokes Pro on a full refund (R P2-9).
  - R4. `no_payment_required` counts as paid (100%-off promo).
  - R5. Saved mixes are Pro-gated on the server.

### WS6 — Accessibility and front end (L)

**FBQ-22 · P1 · Keyboard and screen-reader users can operate the app**
- **Requirements:**
  - R1. A visible `:focus-visible` ring on every interactive element; remove the overriding `outline:none` rules.
  - R2. The eleven tool modals get `role="dialog"`, `aria-modal`, a label, focus moved in, focus trapped, focus restored, and Esc closes.
  - R3. A `<main>` landmark that the skip link targets.
  - R4. Footer link contrast of at least 3:1 against the surrounding text, plus an underline.
  - R5. Honour reduced motion for `timeBarFill` and `fidgetSpinner`.
  - R6. Tap targets of at least 44 px.
  - R7. No overflow at 320 px.
- **Acceptance:** axe on the crawl set reports zero serious or critical violations, plus a Playwright keyboard walk through each modal.

**FBQ-23 · P2 · Front-end polish and monitorability**
- **Requirements:**
  - R1. `/me/` CLS below 0.1.
  - R2. The manifest shortcuts use `?tool=pomodoro` and `?tool=breathing`.
  - R3. The page reaches network idle: the anonymous `/auth/session` probe and the keepalive visit beacon must not hold the network. Use `sendBeacon`. This makes Cloud Run browser-agent screenshots and audits work.
  - R4. No console 401 on an anonymous first visit; the session probe answers 200 `{authenticated:false}`.

### WS7 — Quality system

**FBQ-24 · P1 · The test suite can catch the security regressions it currently cannot** (S)
- **Requirements:**
  - R1. Add tests that kill the surviving mutants:
    - a forged JWT signature
    - a wrong `x-cron-key` on `run-checkins` and `seed-dogfood`
    - a replayed password-reset token against a real D1
    - a missing Origin header
  - R2. Add route tests for `/auth/register`, the consent routes, `/sync/*`, the coach invitation and client routes, and `GET /api/commitments/:id`.
  - R3. Delete or rewrite `auth.test.js` and `validation.test.js`. They import nothing from `src/`.
  - R4. Fix the isolation dependency in `checkin-notification-actions.test.js`.
  - R5. Ratchet the coverage floor to within 3 points of actual.
  - R6. Bring `api/TESTING.md` up to date.

**FBQ-25 · P1 · `main` is protected**
- **Requirement:** branch protection requires the `test.yml` checks and the Playwright smoke test on `main`. Today nothing is required, so a red PR can merge.

**FBQ-26 · P3 · Data hygiene and dependencies**
- **Requirements:**
  - R1. Purge expired sessions, auth tokens and `analytics_events` older than the retention period in `RETENTION.md`.
  - R2. Account deletion also removes `return_nudge_sent` events keyed in `event_data`.
  - R3. Remove the dead `deferred` status, or start writing it.
  - R4. Consolidate the open dependabot bumps into one PR (wrangler, undici, sharp, brace-expansion).
  - R5. Bring the dormant `billing.js` webhook up to standard before `BILLING_ENABLED` is ever set: read the body once and use a constant-time signature compare.

## 3. Order of work

| Wave | Goal | Items (merge order) | Exit gate |
|---|---|---|---|
| 0 | Rails | this plan · tracking issue · FBQ-26 R4 (deps) | Queue ≤ 3; plan merged |
| 1 | Core loop works for everyone | FBQ-01 → FBQ-03 → FBQ-02 → FBQ-10 (migration) · FBQ-24 R1 in parallel | Prod: guest word answered with no push, row `kept`; `/me/` settles at once; schema 0009 |
| 2 | Clients get fixes | FBQ-04 (flagged) → FBQ-25 | Old-worker browser picks up the new build; required checks on |
| 3 | Delivery engine survives scale | FBQ-05 → FBQ-06 → FBQ-07 → FBQ-08 → FBQ-09 | Fixture ticks: one send under a race; no starvation; under 900 calls |
| 4 | Security | FBQ-14 → FBQ-13 → FBQ-15 → FBQ-16 → FBQ-17 | Each probe re-run live shows the rejection |
| 5 | Coach and SMS | FBQ-11 → FBQ-12 → FBQ-10 R4/R5 | SMS reply resolves; unverified number not texted |
| 6 | Product truth | FBQ-18 → FBQ-19 → FBQ-20 → FBQ-21 | Parser table green; design-law scan covers report and coach |
| 7 | Accessibility and polish | FBQ-22 → FBQ-23 | axe zero serious; Cloud Run audit 200 |
| — | Continuous | FBQ-24 R2–R6, FBQ-26 | Coverage ratchet raised |

**Gate to open the closed test (12 testers × 14 days):** Waves 1–2 complete and verified in prod.
**Gate to scale distribution:** Waves 3–5 complete.

## 4. Default rulings needing founder veto

These are the defaults the work proceeds on. Each is a veto window, not a request.

- **FBQ-04 R5:** offline becomes a real promise. The worker is registered on the shell.
- **FBQ-12 R4:** unverified phone numbers get push, not texts, until codes ship.
- **FBQ-13:** a limited account is locked for the window even with the right password.
- **FBQ-21 R2:** no Pro framing in the native app.
- **FBQ-21 R3:** a full refund revokes Pro.
