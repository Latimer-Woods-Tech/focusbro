# FocusBro Improvement Plan

> Generated 2026-07-11, after the foundation session (PRs #26–#30: security, delivery, timer-first UX, perf/a11y — all live-verified). This plan turns the post-session assessment into sequenced, acceptance-tested work.

## North Star & binding constraint

FocusBro is now a **solid foundation** — secure (JWT rotated), delivering (push channel live, HEAD/HTTPS/`/me/` fixed), calm-first (timer-first), and faster (fonts trimmed, entry page cached). The binding constraint is **no longer the tools**. It is:

> **Prove the accountability loop retains, make it visible as coach-proof, then invest in voice.**

Everything sequences off that. Technical debt is paid down opportunistically to keep the foundation clean, but it never precedes loop-proof work in priority.

**Legend** — Autonomy: 🤖 autonomous · 🧑 needs founder decision · 🤝 coordinate with the agent active in the accountability core · ⛔ externally gated. Size: S (<½ day) · M (1–2 days) · L (multi-day).

---

## Critical path (the one sequence that matters)

```
Phase 0  Clean the foundation (parallel, autonomous)  ──┐
                                                         ├─► keeps everything else safe & fast
Phase 1  INSTRUMENT the loop (retention + kept-word) ───┘
                     │  (you can't prove or sell what you don't measure)
                     ▼
Phase 2  Coach-proof artifact: weekly report + export/share + return nudge + guide→tool
                     │  (turns private stats into something a user/coach can SEE)
                     ▼
Phase 3  Activate the ADHD-coach operator channel  (gate: ≥5 real coach-visible reports)
                     │
                     ▼
Phase 4  Voice moat (Phase B) — thin wire-up once @lwt/voice-agent publishes
```

Voice is last on the *value* path on purpose: it is expensive, engine-gated, and its entire justification ("a call retains where a swipe fails") is unmeasured until Phase 1 exists.

---

## Workstream 1 — Prove & sell the accountability loop (Tier 1, top value)

| ID | Item | Why | Acceptance / verification | Size | Autonomy |
|----|------|-----|---------------------------|------|----------|
| L1 | **Retention instrumentation** — first-party events (D1/D7 return, session start/complete, commitment created/kept/missed→reschedule, kept-word rate). Use `@latimer-woods-tech/analytics` (first-party + PostHog) rather than hand-rolling. | The voice thesis is unmeasured; the coach pitch needs numbers. | Events land in the analytics store; a query returns D1/D7 return + kept-word rate for the founder dogfood cohort. Verify by driving the flow and reading the events back. | M | 🤝 (touches the core the other agent works in) |
| L2 | **Weekly report V0** — per-user weekly summary: blocks, interruptions captured, energy trend, sleep notes, kept-word streak, "next tiny adjustment." No shame, kept-word-only framing. | The **keystone**: turns local stats into coach-visible proof; activates the coach GTM. | `/me/` (or `/me/report`) renders a weekly report from real data; "Copy report" + "Share with coach" (mailto/download) work. First 5 reports generated from real users. | M | 🤝 |
| L3 | **Return trigger via push** — a gentle, opt-in daily/weekly return nudge now that the push channel is live (P0 fixed it). No shame; ally tone. | Return triggers are weak; retention needs a habit bridge. | A scheduled push nudge is delivered to a real subscription and links back to the block/commitment. Verify end-to-end (subscribe → cron → received). | S–M | 🤝 |
| L4 | **Guide → tool deep-links** — every guide ends with one action that opens the matching tool state (start 25-min block, open breathing/grounding, enable break reminder) via hash/query route. | Cheapest reader→user conversion; 17 guides currently link only to other guides. | Each guide's CTA opens the app in the intended state; add structured data + OG image. Verify by clicking through from a deployed guide. | M | 🤖 (guides + a small app URL handler; low collision) |
| L5 | **Coach GTM activation** — once L2 yields ≥5 real coach-visible reports, wire the `docs/growth/templates/adhd-coaches.md` outreach to a live product surface (coach dashboard already skeletoned in `coach.js`). | The actual revenue: coaches keep the client, product automates the check-ins. | 5 coach-visible reports exist; first coach invited against the live consent-gated roster. | M | 🧑🤝 (founder sends; coordinate) |

---

## Workstream 2 — Reliability & correctness (Tier 2)

| ID | Item | Why | Acceptance / verification | Size | Autonomy |
|----|------|-----|---------------------------|------|----------|
| R1 | **Fix `initializeDatabase()` hot path** — it runs **17 `CREATE TABLE IF NOT EXISTS` per request** (`index.js:2442`) and per cron tick (`:2458`). Guard it (run once via a KV/edge flag or an in-memory `let ready`), or move DDL to real migrations. | ~17 D1 round-trips on every page load / API call = latency + cost. | Cold request issues DDL once; subsequent requests skip it. Verify with a query-count/log check; `/health` + `/me/` still 200. | S | 🤖 |
| R2 | **Verify the push channel end-to-end in prod** — drive `GET /vapid/public-key` → `POST /notifications/subscribe` (real browser subscription) → trigger `POST /api/internal/run-checkins` → confirm a push is actually received. | P0 mounted the routes + set VAPID but no real round-trip has been observed. | A real subscription receives a check-in push. Document the recipe in the runbook. | S | 🤖 |
| R3 | **Browser/smoke tier in CI** — Playwright smoke: home renders, timer starts, `/me/` loads, ⌘K opens, no console errors. | No browser test exists → JS behavior changes ship unverified (hit this during perf). | CI runs a smoke job on PR; a deliberately broken handler fails it. | M | 🤖 |
| R4 | **CI quality gates** — add `eslint` + a coverage floor to `test.yml` (neither runs today). Start at the current baseline, ratchet up. | Silent quality regression. | PR fails on lint error or coverage drop below floor. | S | 🤖 |

---

## Workstream 3 — Technical debt & platform alignment (Tier 3)

| ID | Item | Why | Acceptance / verification | Size | Autonomy |
|----|------|-----|---------------------------|------|----------|
| D1 | **CI Lighthouse harness** — automate the mobile Lighthouse run (LHCI or scheduled) so perf work is measurable and regressions are caught. Enabler for D2. | Perf changes currently need manual local runs (noisy). | A CI job posts perf/a11y scores per PR (or nightly). | M | 🤖 |
| D2 | **Deeper perf: split the inline-JS monolith** — lazy-load the 15 `public/components/views/*.js` modules; defer non-critical init (gallery, audio) to idle. Caps Lighthouse ~76 today (main-thread work). | The last real perf lever; the 212KB inline JS parses/executes upfront. | Lighthouse mobile ≥85 with the timer still working (verified via D1 harness + smoke). | L | 🤖 (after D1) |
| D3 | **Consolidate to one worker + kill dead code** — remove `workers/src/*` (old `focusbro.dev` worker), the redundant `focusbro-api` worker (`api/wrangler.toml`, no routes), and the mostly-dead `extended-routes.js` (77KB; only the 2 push routes were needed). | Confusion + deploy surface + the drift class of bugs. | One worker serves everything; `/health` + all key routes still 200 post-deploy; dead trees deleted. | M | 🤖 |
| D4 | **Schema single source of truth** — collapse `schema.sql` vs the inline `CREATE TABLE`s in `initializeDatabase()`. Pairs with R1. | Two definitions drift. | One canonical schema; init reads from it (or migrations). Tests pass. | S–M | 🤖 |
| D5 | **Untrack vendored `node_modules`** (2924 files tracked on `main`) — dedicated PR; confirm `npm ci` in `deploy.yml` still produces a working bundle. | Repo bloat + the rebase-wipe hazard. | `node_modules` gitignored + removed from tracking; a clean deploy still verifies `focusbro.net` 200. | S | 🤖 |
| D6 | **Adopt shared packages (deliberate migrations, one at a time)** — `@lwt/push` (replace `webpush.js`), `@lwt/telephony` (Telnyx SMS), later `@lwt/auth`/`@lwt/stripe`. Prereq: add `.npmrc` (`@latimer-woods-tech`→npm). | Dedup + shared hardening; also the voice-prep (`telephony`). | Each swap: adapter written, unit tests green, **push/SMS verified end-to-end in prod** before the next. Start with `@lwt/push` behind R2's verification. | L | 🤖 (careful; not urgent) |
| D7 | **Doc hygiene** — prune ~40 stale pre-pivot audit docs (AUDIT_*, VALIDATION_ROADMAP, MASTER_DOCUMENTATION_PLAN); fix CLAUDE.md's "no build step" claim (there are 2 generators; wire `build-complete-html.js` into a script too). | The repo's own docs contradict reality. | Stale docs archived/removed; CLAUDE.md matches the real build (`build:html` + view-inline step). | S | 🤖 |

---

## Workstream 4 — UX / trust / a11y polish (Tier 4)

| ID | Item | Why | Acceptance / verification | Size | Autonomy |
|----|------|-----|---------------------------|------|----------|
| U1 | **Contrast tokens** — `--text-muted #94a3b8` / `--text-dim #64748b` on dark cards are borderline WCAG AA. | Accessibility + readability for the ADHD audience. | New values pass AA (≥4.5:1 body / 3:1 large) on the card backgrounds; Lighthouse a11y stays 100. | S | 🧑 (brand color decision) |
| U2 | **Cookie banner review** — still auto-shows on first load; ads are now guides-only. Decide if the core app needs consent UI (CF analytics beacon may still warrant it by jurisdiction) and minimize it. | First-load calm; the wingspan review flagged onboarding+cookie together (onboarding already fixed). | Decision recorded; if kept, it's minimal and non-blocking to the timer. | S | 🧑 |
| U3 | **Legal/brand consistency sweep** — spot-check the remaining served pages + in-app legal modals for brand/date consistency (Terms already fixed in #27). | Trust hygiene. | Served privacy/about + in-app modals consistent (Latimer Woods Tech, current dates). | S | 🤖 |
| U4 | **Note the JWT-in-history** — rotated value is neutralized but still in git history. Decide: leave (documented) vs history scrub (high-risk). No other real secrets found. | Security transparency. | Decision recorded in the runbook. | S | 🧑 |

---

## Workstream 5 — Voice moat (Phase B) ⛔ gated

| ID | Item | Why | Gate | Size | Autonomy |
|----|------|-----|------|------|----------|
| V1 | **Publish `@latimer-woods-tech/voice-agent`** (extraction from XPElevator Phase E). The sole gating dependency; auto-unblock already wired in Factory `docs/DEPENDENCIES.yml`; Bandwidth account already landed. | The moat is unbuildable without it; do NOT hand-roll telephony. | Factory-side effort. | L | ⛔ |
| V2 | **Minimal Telnyx voice check-in** — place a warm persona (ally/hype) call at check-in time; wire as a `'voice'` channel in `checkins-cron.js:deliverCheckin`; lift the voice guards at `accountability.js:227` / `consent.js:357` behind a flag; enforce voice TCPA (schema already pre-provisions `channel='voice'`). | The differentiator. | After V1 + D6(`@lwt/telephony`): first live call to a consented number. | M | ⛔→🤖 |

---

## Phasing & sequencing

**Phase 0 — Clean the foundation (bank now, autonomous, low collision).** Run these in parallel; they don't touch the accountability core the other agent works in: **R1** (DB hot path), **R2** (verify push e2e), **R4** (CI lint+coverage), **D5** (untrack node_modules), **D7** (doc hygiene), **U3** (legal sweep). Then **D3** (dead-code/one-worker) and **R3** (smoke CI) as slightly larger cleanups. Deliver as small, individually-verified PRs (the pattern that worked this session).

**Phase 1 — Instrument (L1).** Coordinate with the accountability-core agent on ownership. Nothing downstream is provable without it.

**Phase 2 — Coach-proof (L2 → L3 → L4).** Weekly report is the keystone; return nudge and guide deep-links compound retention.

**Phase 3 — Activate coach GTM (L5).** Gate: ≥5 real coach-visible reports.

**Phase 4 — Voice (V1 → V2).** Thin wire-up once the engine lands; D6's `@lwt/telephony` adoption is the prep.

**Cross-cutting enablers, do early:** **D1** (Lighthouse CI) unblocks **D2** (deep perf); **R3** (smoke) de-risks all JS changes; **`.npmrc`** unblocks **D6** and any shared-package use.

---

## Immediate quick-wins (this-session-able, autonomous)

Ranked by value/effort:
1. **R1 — `initializeDatabase` hot path** (S) — real latency/cost win, isolated, clearly correct.
2. **R2 — verify push end-to-end** (S) — confirms the P0 fix actually delivers; documents the recipe.
3. **R4 — CI lint + coverage floor** (S) — stops silent regressions.
4. **D7 — doc hygiene** (S) — the repo currently lies about itself.
5. **D5 — untrack node_modules** (S, dedicated PR) — removes the rebase hazard I hit.

## Decisions owed by the founder
- **U1** contrast colors (brand). · **U2** cookie banner necessity. · **U4** JWT-history scrub vs leave. · **L1/L2** coordination with the accountability-core agent (who owns loop instrumentation). · **V-timing**: when to prioritize the `voice-agent` extraction (it's the real unlock for the differentiator).

## Maps to existing tracking
FocusBro GitHub #10 (Contender) already frames Phases A–D. This plan's **W1** = #10 Phase A completion (loop proof) + the coach channel; **W5** = #10 Phase B; **L5/coach white-label** = #10 Phase C; tiers/billing = #10 Phase D. Each row above should become a GitHub issue linked to #10.
