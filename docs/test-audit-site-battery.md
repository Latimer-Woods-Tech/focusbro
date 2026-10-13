---
last_updated: "2026-10-13"
owner: focusbro
status: active
---

# Test audit for the Site Quality Battery (R-17)

**Requirement (Factory `docs/planning/site-quality-battery-plan-2026-10-13.md`, R-17).** Delete only tests that are provably useless. Each deletion needs mutation evidence or a named duplicate. A test that fails against a broken target is kept. Deletions also need leader review.

**Verdict.** None of the 178 unit files or 11 e2e specs is a deletion candidate. Every unit file failed against at least one broken target, recorded below. 24 files contain cases that can be **consolidated** (R1–R4); consolidation preserves every assertion's coverage and comes in a later PR. **This PR deletes nothing.**

Generated: 2026-10-13 against `feat/site-battery-staging` at `db6b04f`. Unit suite: 178 files / 2487 tests green; e2e: 86 tests in 11 specs green.

## Method

Each file gets the first evidence that applies, in this order:

1. **Sampled mutation sweep.** Every source module in `api/src` (except the generated `html.js`) got up to 6 single-site operator mutants (`===`↔`!==`, `&&`↔`||`, `>=`→`<`, `<=`→`>`, `return true`↔`return false`), spread evenly over the file. Each mutant ran against `vitest related <module>`. **209 mutants: 144 killed, 65 survived, 0 timeouts.** 113 test files killed at least one.
2. **Import-guided per-file pass** for the 57 files with no sweep kill. Mutants went inside the functions the file imports, the file ran alone, and the pass stopped at the first kill. 31 killed.
3. **Anchor-guided pass** for the 26 files still without a kill: mutants near the routes and identifiers the test names in the Worker sources. 7 killed.
4. **Source-level pass** for the last 19. Most of these read built artifacts (`html.js` from `public/index.html`, `sw-source.js` from `public/sw.js`), so the mutant went into the source and the artifact was rebuilt before the run. Anchored operator mutants in `public/index.html` killed 2. The other 17 each got a **named mutant**: a realistic defect in what the test guards, such as the replay hole the test header names, a `/health` that touches D1, or the native app showing the medication card. All 17 were killed. (A first named mutant for `sound-catalog`, which only renamed a `SOURCES.md` label, survived. That is expected, because the test traces files, not labels. A manifest drift then killed it.)
5. **Static guards.** Tests of config and workflow files (`wrangler.toml`, `deploy.yml`, schema mirrors) have no `src` mutant. Their evidence is their in-file proof-of-rejection cases. For the four new files in this PR, the evidence is a red run before the code existed.

All mutation ran on throwaway copies of the repo, and every mutant was restored. A sampled operator sweep is evidence *for* keeping a file, never proof that a file is useless. A file with no kill would have needed a named mutant before any deletion, which is why steps 2–4 exist.

## Consolidation candidates (replace a case, keep the coverage)

**R1. The design-law scanner's own rejection case, repeated in 10 files.** `account-keeping-since`, `best-day`, `best-week`, `kept-total-landmark`, `per-word-kept-since`, `personal-record`, `power-day`, `power-hours`, `showed-up-days` and `typical-day` each carry *"the design-LAW scanner can reject shame — it is not a vacuous guard"*. Each one calls `scanDesignLaw` with a shame sentence. Mutant `design-law-scanner-vacuous` (`scanDesignLaw` returns `[]`) is killed by `design-law.test.js` and by these cases alike, so they test the scanner, not their own surface. **Replace:** move the 10 sentences into one table in `design-law.test.js`, then drop the 10 copies. Each file's own "every line is design-LAW clean" case stays.

**R2. The rotation contract, repeated in 4 files.** `checkin-prompt-rotation`, `escalation-rotation`, `reschedule-confirm-rotation` and `return-nudge-rotation` share titled cases: deterministic seed, safe negative/string seeds, an absent seed gives variant 0, and every variant obeys the design law. They test four **different** copy functions (`checkinPromptCopy`, `escalationCopy`, `smsRescheduledCopy`, `returnNudgeCopy`), so these are not duplicates. **Replace:** one table-driven contract test over the four functions. Each file keeps its surface-specific cases (hype markers, discriminators).

**R3. One reply family per file (9 files).** `avoidance-procrastination-miss`, `let-you-down-selfblame-miss`, `decline-onit-dropped-ball-miss`, `circumstantial-miss-lifegotinway`, `soft-negative-done-streak`, `soft-negative-hedge-reply`, `soft-no-reply`, `wishful-not-done-streak` and `reschedule-circumstantial-miss` have the same shape: a phrase list routed through `detectCheckinReply`. Targeted mutants show these are **not** duplicates:

| Mutant (in `accountability.js`) | Killed by | Survived in |
|---|---|---|
| drop the `let … down` alternation from `SHAME_MISS` | `let-you-down-selfblame-miss` only | `avoidance-…`, `decline-onit-…`, `accountability.test.js` |
| drop `dropp?(ed\|ing)? the ball` | `let-you-down-…`, `avoidance-…`, `decline-onit-…` | `accountability.test.js` |
| break `procrastinat…` in `AVOIDANCE_MISS` | `avoidance-procrastination-miss` only | the other three |

**Replace:** fold them into one `parse-when-table`-style reply table that keeps **every** phrase. Deleting any single file would let its family regress silently, as the first and third rows show.

**R4. `soundscape-ritual.test.js` asserts source text.** Mutant: `startPomodoro` no longer calls `soundscapeOnFocusStart()`. It is killed by this file **and** by the e2e smoke test *"the soundscape follows the focus block"*. For this behaviour, the text-shape assertions duplicate a behavioural browser test. **Replace candidate only:** keep the file until the e2e smoke is a required check on `main` (FBQ-25), because today only the unit suite reliably gates a PR.

Four more files are text-shape tests: `shell-kept-words`, `word-handoff-autocomplete`, `me-headline-total` and `native-hides-med-reminder`. Forty anchored operator mutants each survived them, because they grep the shell for exact source text. A behavioural named mutant killed each one, so they stay **keep**. A future rewrite should run the code rather than grep it.

## Coverage gaps the sweep exposed (not deletions)

Survivors cluster in `me.js` (6/6 survived) and `guides/scripts.js` (6/6). Both are client scripts held in template strings, so the unit suite reads them as text and only the e2e specs execute them. Next come `billing.js` (4/6), which is dormant behind `BILLING_ENABLED`, and `account-recovery.js` (4/6). These are candidates for new tests, not findings against existing ones.

## E2E specs (`api/e2e/`)

The per-PR run serves `html.js` through `e2e/serve.mjs`. "Remote" means the spec can run against a deployed host via `BASE_URL` (see `e2e/target.mjs`). Only `smoke.spec.js` was actually run that way.

| Spec | Tests | Class | Remote | Evidence |
|---|---|---|---|---|
| `smoke.spec.js` | 13 | keep | 10 yes · 3 `@local-fixture` | 13/13 local; 10/10 against `wrangler dev --env staging` (local D1/KV, the real `focusbro-audio` bucket read remotely); kills the R4 wiring mutant above |
| `home-promise.spec.js` | 3 | keep · replace case | no (its "default" case assumes the `serve.mjs` toolkit default) | Its case *"default: the toolkit is still on the home page"* repeats the `#quickWordForm` / `#pomoCard` visibility checks of smoke test 1. Its header ("flag off by default") describes `serve.mjs`, **not production**, which sets `HOME_PROMISE_FIRST=1`. Replace: rename it as the `?home=toolkit` variant. |
| `a11y.spec.js` | 28 | keep | no (smoke-server hooks) | header: each check failed on `main` before the FBQ-22 fix (authored proof of rejection; not re-run here) |
| `account-delete.spec.js` | 5 | keep | no (`smoke_session` cookie on the smoke server) | Play user-data policy; deletion itself proven in vitest `account-delete.test.js` |
| `coach-card.spec.js` | 2 | keep | not run remotely (stubs its API calls) | FBQ-10 R4, axe zero serious/critical while the card shows |
| `fbq23-polish.spec.js` | 5 | keep | not run remotely (stubs its API calls) | FBQ-23 defects 1, 3, 4 (CLS, network idle, console 401) |
| `fbq23b-home.spec.js` | 7 | keep | no (needs the smoke server's byte-exact beacon) | header: the two live-probe defects #419's stubs hid |
| `mobile-layout.spec.js` | 7 | keep | not run remotely | header: the 465 px overflow tree fails these |
| `pro.spec.js` | 7 | keep | no (`?fixture=buy`) | website-only Pro rule (Google Play) |
| `sw-shell-offline.spec.js` | 5 | keep | no (own server, imports the Worker) | FBQ-04b |
| `sw-update.spec.js` | 4 | keep | no (own server, imports the Worker) | FBQ-04a |

`measure-sounds.mjs` and `measure-swell.mjs` are manual measurement tools, not tests. `serve.mjs` is the smoke server and `fixtures/` holds its fonts and the v1 service worker. All of these stay.

**E2E evidence limits.** Apart from the R4 mutant, the e2e specs were not mutation-tested here, because a browser run per mutant is too slow for this pass. Their "keep" rests on their authored proof-of-rejection headers and a green 86/86 run. None of them is proposed for deletion, so R-17 asks nothing more of them.

## Finding for the staging smoke

Before this PR, the smoke ran only against `serve.mjs`, which serves the **toolkit** home by default. Production serves the **promise** home (`HOME_PROMISE_FIRST=1`). Three smoke tests, including the headline *"loads, leads with accountability, and preserves the toolkit"* and the soundscape ritual, therefore asserted a home that production does not serve by default. They now name `?home=toolkit` explicitly. On the promise home, the `/?tool=sounds` deep-link that guides send readers to does not show the Pomodoro start button. That is a product question, not a test defect: should a sounds deep-link land on the toolkit? It is recorded here so it is not lost.

## Unit files (`api/src/__tests__/`)

154 keep · 24 keep with a consolidation note (R1–R4) · 0 replace · 0 delete.

| File | Class | Evidence |
|---|---|---|
| `account-delete.test.js` | keep | sweep: killed 5 of 209 sampled mutants (4 only it killed) |
| `account-keeping-since.test.js` | keep · replace case | sweep: killed 2 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `account-link-discoverable.test.js` | keep | named mutant killed: public/index.html: header account link removed |
| `account-recovery.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `accountability.test.js` | keep | targeted mutant killed: `accountability.js:118 !==→===` |
| `activation-gate.test.js` | keep | sweep: killed 1 of 209 sampled mutants (1 only it killed) |
| `audio-route.test.js` | keep | sweep: killed 5 of 209 sampled mutants (5 only it killed) |
| `avoidance-procrastination-miss.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `best-day.test.js` | keep · replace case | sweep: killed 3 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `best-week.test.js` | keep · replace case | sweep: killed 3 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `billing-webhook-standard.test.js` | keep | sweep: killed 2 of 209 sampled mutants (2 only it killed) |
| `breathing-modal.test.js` | keep | named mutant killed: public/index.html:5291 ===→!== |
| `checkin-answer-binds-occurrence.test.js` | keep | sweep: killed 5 of 209 sampled mutants |
| `checkin-claim-lease.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `checkin-held-rows-out-of-batch.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `checkin-night-guard.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `checkin-notification-actions.test.js` | keep | sweep: killed 4 of 209 sampled mutants |
| `checkin-open-occurrence-unique.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `checkin-prompt-rotation.test.js` | keep · replace case | sweep: killed 1 of 209 sampled mutants · R2: shared variant-contract cases |
| `checkin-reply.test.js` | keep | sweep: killed 5 of 209 sampled mutants (1 only it killed) |
| `checkin-resolve-current-occurrence.test.js` | keep | targeted mutant killed: `accountability.js:4232 &&→||` |
| `checkin-unreachable-answerable.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `checkins-cron.test.js` | keep | sweep: killed 5 of 209 sampled mutants (1 only it killed) |
| `circumstantial-miss-lifegotinway.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `coach-checkin-delivery.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `coach-client-engaged.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `coach-client-note.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `coach-client-unlink.test.js` | keep | sweep: killed 6 of 209 sampled mutants |
| `coach-client-weekly.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `coach-detail-next-checkin-waiting.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `coach-onboarding.test.js` | keep | sweep: killed 9 of 209 sampled mutants (5 only it killed) |
| `coach-operator-roster.test.js` | keep | sweep: killed 8 of 209 sampled mutants (4 only it killed) |
| `coach-personal-best.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `coach-return-opener.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `coach-roster-engaged.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `coach-roster-next-checkin.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `coach-roster-order.test.js` | keep | sweep: killed 2 of 209 sampled mutants (1 only it killed) |
| `coach-tables-migration.test.js` | keep | sweep: killed 6 of 209 sampled mutants |
| `coach-voice-ladder.test.js` | keep | targeted mutant killed: `checkins-cron.js:817 ||→&&` |
| `coach.test.js` | keep | sweep: killed 4 of 209 sampled mutants (2 only it killed) |
| `config-honesty.test.js` | keep | named mutant killed: config.js: a config.api block nothing reads |
| `consent.test.js` | keep | sweep: killed 3 of 209 sampled mutants (1 only it killed) |
| `content-view-beacon.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `create-when-text.test.js` | keep | targeted mutant killed: `accountability.js:99 ===→!==` |
| `cron-health.test.js` | keep | targeted mutant killed: `checkins-cron.js:1051 &&→||` |
| `cron-tick-budget.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `db-init-once.test.js` | keep | named mutant killed: index.js: /health touches D1 |
| `decline-onit-dropped-ball-miss.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `default-persona.test.js` | keep | targeted mutant killed: `accountability.js:1102 ===→!==` |
| `deploy-concurrency.test.js` | keep | static guard on deploy.yml concurrency (FBQ incident #408/#409); no src mutant applies |
| `deploy-staging.test.js` | keep | NEW (this PR): red before the staging job existed; 8 rejection cases |
| `design-law.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `detail-next-checkin-waiting.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `detail.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `edit.test.js` | keep | targeted mutant killed: `accountability.js:4847 !==→===` |
| `escalation-hold.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `escalation-lateness.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `escalation-night-guard.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `escalation-reply-resolves-push-row.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `escalation-rotation.test.js` | keep · replace case | sweep: killed 1 of 209 sampled mutants · R2: shared variant-contract cases |
| `escalation-sent-marker.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `escalation.test.js` | keep | targeted mutant killed: `consent.js:96 ||→&&` |
| `event-integrity.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `events.test.js` | keep | sweep: killed 4 of 209 sampled mutants (2 only it killed) |
| `fbq01b-unrecorded-answer-event.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `fbq17b-bad-timezone-reply.test.js` | keep | targeted mutant killed: `accountability.js:99 ===→!==` |
| `fbq19-settled-edges.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `fbq21-native-pro-framing-and-policy.test.js` | keep | sweep: killed 2 of 209 sampled mutants (1 only it killed) |
| `fbq23-manifest-and-probe.test.js` | keep | targeted mutant killed: `index.js:1640 ===→!==` |
| `features.test.js` | keep | sweep: killed 3 of 209 sampled mutants (2 only it killed) |
| `follow-through.test.js` | keep | sweep: killed 9 of 209 sampled mutants (6 only it killed) |
| `founder-identity.test.js` | keep | sweep: killed 1 of 209 sampled mutants (1 only it killed) |
| `growth-link.test.js` | keep | targeted mutant killed: `../../scripts/growth-link.mjs:15 ||→&&` |
| `guest-first-word.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `guides-breath.test.js` | keep | sweep: killed 10 of 209 sampled mutants (7 only it killed) |
| `guides-caffeine.test.js` | keep | sweep: killed 7 of 209 sampled mutants (4 only it killed) |
| `guides-deeplink.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `guides-evidence.test.js` | keep | sweep: killed 5 of 209 sampled mutants (1 only it killed) |
| `guides-served-by-worker.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `health-schema-version.test.js` | keep | sweep: killed 1 of 209 sampled mutants (1 only it killed) |
| `heartbeat.test.js` | keep | targeted mutant killed: `checkins-cron.js:1051 &&→||` |
| `home-promise.test.js` | keep | sweep: killed 2 of 209 sampled mutants (1 only it killed) |
| `homecoming.test.js` | keep | targeted mutant killed: `accountability.js:3586 ||→&&` |
| `input-limits.test.js` | keep | sweep: killed 3 of 209 sampled mutants (2 only it killed) |
| `internal-cron-key.test.js` | keep | targeted mutant killed: `index.js:2628 ===→!==` |
| `jwt-secret-fallback.test.js` | keep | targeted mutant killed: `index.js:162 ||→&&` |
| `kept-log.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `kept-total-landmark.test.js` | keep · replace case | sweep: killed 1 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `later-parks-delivered-pending.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `let-you-down-selfblame-miss.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `login-limit.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `me-headline-total.test.js` | keep | named mutant killed: me.js: /me/ headline shows the resetting streak, not the total · text-shape: 40 anchored operator mutants survived; a behavioural named mutant killed it |
| `me-kept-time.test.js` | keep | named mutant killed: me.js: fmtWhen no longer marks the SQLite datetime UTC |
| `me-list-kept-word.test.js` | keep | targeted mutant killed: `me.js:1259 <→<=` |
| `me.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `middleware.test.js` | keep | sweep: killed 2 of 209 sampled mutants (2 only it killed) |
| `momentum.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `mutable-reads-no-store.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `native-bridge.test.js` | keep | sweep: killed 4 of 209 sampled mutants (4 only it killed) |
| `native-hides-med-reminder.test.js` | keep | named mutant killed: public/index.html: native app shows the medication reminder (CSS rule dropped) · text-shape: 40 anchored operator mutants survived; a behavioural named mutant killed it |
| `next-checkin-list.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `no-ads.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `no-resetting-counter.test.js` | keep | sweep: killed 4 of 209 sampled mutants (2 only it killed) |
| `noise-loop-seam.test.js` | keep | named mutant killed: public/index.html: no crossfade at the loop seam (the old tick) |
| `parse-when-table.test.js` | keep | targeted mutant killed: `accountability.js:468 ===→!==` |
| `password-hashing.test.js` | keep | targeted mutant killed: `index.js:889 !==→===` |
| `password-reset-replay.test.js` | keep | named mutant killed: account-recovery.js: drop `AND consumed_at IS NULL` from confirmPasswordReset (the mutant its header names) |
| `pause-resume.test.js` | keep | named mutant killed: accountability.js: pause leaves the rhythm active |
| `per-word-kept-since.test.js` | keep · replace case | sweep: killed 1 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `personal-record.test.js` | keep · replace case | sweep: killed 1 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `phone-verification.test.js` | keep | sweep: killed 8 of 209 sampled mutants (3 only it killed) |
| `play-listing-kit.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `power-day.test.js` | keep · replace case | sweep: killed 4 of 209 sampled mutants (1 only it killed) · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `power-hours.test.js` | keep · replace case | sweep: killed 4 of 209 sampled mutants (1 only it killed) · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `pro-gating.test.js` | keep | sweep: killed 5 of 209 sampled mutants (1 only it killed) |
| `pro-refund-and-promo.test.js` | keep | sweep: killed 4 of 209 sampled mutants (2 only it killed) |
| `pro-worker-flow.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `push-hardening.test.js` | keep | sweep: killed 6 of 209 sampled mutants (4 only it killed) |
| `push-routes.test.js` | keep | sweep: killed 3 of 209 sampled mutants (2 only it killed) |
| `real-d1-foreign-keys.test.js` | keep | guards the test harness itself; header: every case fails with FK enforcement off |
| `release.test.js` | keep | named mutant killed: accountability.js: release leaves the word active |
| `report.test.js` | keep | sweep: killed 4 of 209 sampled mutants (2 only it killed) |
| `reschedule-circumstantial-miss.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `reschedule-confirm-rotation.test.js` | keep · replace case | sweep: killed 1 of 209 sampled mutants · R2: shared variant-contract cases |
| `reschedule-midnight-ambiguous.test.js` | keep | targeted mutant killed: `accountability.js:685 ||→&&` |
| `reschedule-noon-composes.test.js` | keep | targeted mutant killed: `accountability.js:514 &&→||` |
| `reschedule-when-ish.test.js` | keep | targeted mutant killed: `accountability.js:881 &&→||` |
| `reschedule-when-text.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `resume-cancels-stale-occurrence.test.js` | keep | targeted mutant killed: `accountability.js:4766 !==→===` |
| `retention-honesty.test.js` | keep | targeted mutant killed: `events.js:449 >→>=` |
| `retention-purge.test.js` | keep | sweep: killed 3 of 209 sampled mutants (3 only it killed) |
| `return-nudge-hold.test.js` | keep | sweep: killed 2 of 209 sampled mutants (1 only it killed) |
| `return-nudge-rotation.test.js` | keep · replace case | sweep: killed 1 of 209 sampled mutants · R2: shared variant-contract cases |
| `return-nudge-starvation.test.js` | keep | targeted mutant killed: `checkins-cron.js:1257 ||→&&` |
| `return-nudge.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `room.test.js` | keep | sweep: killed 3 of 209 sampled mutants (3 only it killed) |
| `route-auth-login-session.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `route-auth-register-recovery.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `route-coach-links.test.js` | keep | targeted mutant killed: `coach.js:57 ===→!==` |
| `route-consent.test.js` | keep | sweep: killed 2 of 209 sampled mutants |
| `route-static-pages.test.js` | keep | targeted mutant killed: `index.js:726 <→<=` |
| `route-sync-and-commitment-read.test.js` | keep | sweep: killed 4 of 209 sampled mutants |
| `schema-parity.test.js` | keep | static parity of schema.sql / migrations / runtime DDL; a dropped column in any one fails it |
| `service-worker.test.js` | keep | named mutant killed: public/sw.js: a syntax error in the served service worker |
| `session-refresh.test.js` | keep | sweep: killed 3 of 209 sampled mutants |
| `shell-copy-law.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `shell-kept-words.test.js` | keep | named mutant killed: public/index.html: stats card never loads the kept-word ledger · text-shape: 40 anchored operator mutants survived; a behavioural named mutant killed it |
| `showed-up-days.test.js` | keep · replace case | sweep: killed 3 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `silent-miss-return.test.js` | keep | targeted mutant killed: `accountability.js:3472 ||→&&` |
| `silent-miss-text-return.test.js` | keep | targeted mutant killed: `accountability.js:3473 ||→&&` |
| `smoke-target.test.js` | keep | NEW (this PR): red before e2e/target.mjs existed; rejection cases for bad BASE_URL and untagged fixture readers |
| `snooze-duration.test.js` | keep | targeted mutant killed: `accountability.js:2623 ===→!==` |
| `snooze-rearm-current-occurrence.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `snooze.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `soft-negative-done-streak.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `soft-negative-hedge-reply.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `soft-no-reply.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `sound-catalog.test.js` | keep | named mutant killed: audio/manifest.json: a rebuilt recording whose manifest no longer matches the served SOUND_FILES |
| `soundscape-distinctness.test.js` | keep | named mutant killed: public/index.html: loops play from the file edge |
| `soundscape-ritual.test.js` | keep · replace case | named mutant killed: public/index.html: a focus block no longer brings the mix back · R4: text-shape; its wiring mutant is also killed by the e2e smoke |
| `soundscape-share.test.js` | keep | named mutant killed: public/index.html:4719 ===→!== |
| `staging-env.test.js` | keep | NEW (this PR): red before env.staging existed; 13 rejection cases; failed live with prod ids copied in |
| `staging-noindex.test.js` | keep | NEW (this PR): 12 cases red before isStagingEnv existed; production cases are the rejection half |
| `sw-shell-signout.test.js` | keep | sweep: killed 7 of 209 sampled mutants (6 only it killed) |
| `sw-source.test.js` | keep | named mutant killed: public/sw.js: public/sw.js edited without rebuilding sw-source.js |
| `sw-versioned-network-first.test.js` | keep | sweep: killed 2 of 209 sampled mutants (2 only it killed) |
| `sync-events.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `sync-route-validation.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `sync-validation.test.js` | keep | sweep: killed 4 of 209 sampled mutants (2 only it killed) |
| `two-way-checkins.test.js` | keep | sweep: killed 4 of 209 sampled mutants (1 only it killed) |
| `typical-day.test.js` | keep · replace case | sweep: killed 3 of 209 sampled mutants · R1: its "design-law scanner can reject shame" case duplicates design-law.test.js |
| `visual-identity.test.js` | keep | sweep: killed 1 of 209 sampled mutants (1 only it killed) |
| `webpush.test.js` | keep | sweep: killed 2 of 209 sampled mutants (2 only it killed) |
| `wishful-not-done-streak.test.js` | keep · replace case | targeted mutant killed: `accountability.js:2964 &&→||` · R3: one reply family per file |
| `word-handoff-autocomplete.test.js` | keep | named mutant killed: me.js: a stale word handoff never expires · text-shape: 40 anchored operator mutants survived; a behavioural named mutant killed it |
| `word-offered.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `worker-routing.test.js` | keep | sweep: killed 1 of 209 sampled mutants |
| `wrangler-isolation.test.js` | keep | static guard; 5 in-file proof-of-rejection cases; failed live in this PR when prod ids were copied into staging |
