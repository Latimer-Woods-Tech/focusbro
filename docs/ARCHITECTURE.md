---
verified: 2026-07-04
verified_by: agent (design-spine session; live curl + CF API + repo inspection)
---

# FocusBro — Architecture

> **Grounding rule:** nothing in a `(Current)` section that wasn't verified against the repo/live infra on the `verified` date above. Aspirational content goes under Target Architecture only. C4 L1/L2 in text; no component diagrams.

## System Context (Current)
Visitors hit **https://focusbro.net** (Cloudflare zone `focusbro.net`), served entirely by a single Cloudflare Worker. No sister-app integrations, no Stripe, no Neon — persistence is Cloudflare D1 + KV. External systems: Google AdSense (ownership `<script>` on the homepage, publisher `ca-pub-1346297152611586`; **not yet approved** — rejected, remediation in flight via control issue #6), ElevenLabs (build-time audio asset generation in CI only, `continue-on-error`).

Live state verified 2026-07-04 ~22:20 UTC with browser-UA curl (CF WAF blocks bot UAs):

| Endpoint | Observed |
|---|---|
| `GET /` | 200 — timer app renders, **but still the pre-Phase-1 build**: 3× "Ad Space" placeholder labels, 3× `data-ad-slot="XXXXXXXXXX"`, "Keep Teams" presence copy, `simulateActivity` engine all present in live HTML |
| `GET /ads.txt` | 200 — serves **OLD** `google.com, pub-7015938501859914, DIRECT, f08c47fec0942fa0` (source/main has the corrected `pub-1346297152611586`) |
| `GET /guides/` | 404 — content layer does not exist yet |
| `GET /sitemap.xml` | 200 — 5 URLs only (`/`, privacy, terms, about, contact); no guides |
| `GET /privacy.html` | 200 — contains **neither** `adssettings.google.com` nor `aboutads.info` opt-out links |
| `GET /about.html` / `/contact.html` | 200 — thin (about ≈ one paragraph; contact ≈ 725 bytes) |
| `GET /health` | 200 |

**⚠️ Deploy pipeline is silently broken (root cause of the source↔live gap).** CF API shows worker `focusbro-production` last modified **2026-05-06** — the 2026-07-04 "Deploy to Cloudflare" run [28718694798](https://github.com/Latimer-Woods-Tech/focusbro/actions/runs/28718694798) went green without updating it. `.github/workflows/deploy.yml` runs `npx wrangler deploy --env production 2>&1 | tee ...` and then reads `$?` — without `pipefail` that captures **tee's** exit code, so a wrangler auth/deploy failure is masked (the same run's cache-purge step failed with CF auth error 10000, pointing at a bad `CLOUDFLARE_API_TOKEN` secret). Everything the loop shipped in commit `3b9a2e9` is on `main` but **not live**.

## Containers (Current)

| Container | Tech | Name / ID | Notes |
|---|---|---|---|
| Site + API worker | CF Worker (itty-router style, template-string HTML) | `focusbro` → deploys as `focusbro-production` (account `a1c8a33cbe8a3c9e260480433a0dbb06`) | `wrangler.toml` at repo root; `[env.production]` routes `focusbro.net/*` + `*.focusbro.net/*`; live code stale since 2026-05-06 |
| DB | Cloudflare D1 | `focusbro-db` (`f6b1685b-a879-4d42-9c23-a30da614be01`) | binding `DB` |
| Cache | Cloudflare KV | `732d985fd2b84650aa828f7982ba0f87` | binding `KV_CACHE` |
| CI/CD | GitHub Actions | `deploy.yml` (push to main), `test.yml` (vitest, 53 tests), `docs-health.yml` | deploy is green-but-broken; see above |

**Architecture quirk (honest note):** there is no static-site or Pages layer — **every page is served as a hardcoded template string from `api/src/index.js`**. The homepage HTML lives in `api/src/html.js`, which is a *generated* module built from `public/index.html` by `build-complete-html.js` / `create-html-module.js`. Editing `public/index.html` without regenerating `html.js` ships nothing. Two additional stale wrangler configs exist and confuse tooling: `api/wrangler.toml` (worker `focusbro-api`, plaintext placeholder `JWT_SECRET`) and `workers/wrangler.toml` (legacy `focusbro.dev` zone). The root `wrangler.toml` also carries **plaintext `JWT_SECRET` in `[env.production].vars`** — a hard-constraint violation. The repo has **committed `node_modules/`** (clone requires `core.longpaths=true` on Windows).

## Target Architecture
An AdSense-approved publisher site: the same single Worker serving (a) the free focus app (Pomodoro timer, tasks, stats, ambient sound) and (b) a **16-guide educational content layer** — server-rendered full-HTML pages at `/guides/<slug>.html` from an `api/src/guides/` module exporting `[{slug,title,description,html}]` with a generic route registrar (not 16 more template strings bloating `index.js`), plus a `/guides/` index and a homepage nav link. Compliant policy pages (privacy with third-party/DoubleClick cookie language and both opt-out links), a dismissible vanilla-JS cookie-consent banner, substantive About/Contact, sitemap listing all guide URLs with lastmod. Secrets out of `wrangler.toml` vars (`JWT_SECRET` via `wrangler secret put`, rotated). A deploy pipeline that actually fails when wrangler fails, verified by curl against live.

## Gap Analysis

| Gap (Target − Current) | Requirement(s) | Closed by |
|---|---|---|
| Deploy pipeline green-but-broken; live worker stale since 2026-05-06; Phase 1 commit `3b9a2e9` not live | R-100 | issue #6 (blocks every phase's acceptance; fix `pipefail`/token, redeploy, curl-verify) |
| Live ads.txt = old `pub-7015938501859914`; placeholder ad units + presence feature still live | R-001, R-002, R-003 | issue #6 Phase 1 (source done; needs a real deploy) |
| Privacy policy missing opt-out links / vendor-cookie language; no consent banner; thin About/Contact | R-004, R-005, R-006 | issue #6 Phase 2 |
| No content layer: `/guides/` 404, sitemap has 5 URLs, zero articles | R-007, R-101 | issue #6 Phase 3 |
| Plaintext `JWT_SECRET` in wrangler vars; committed `node_modules/` | R-009, R-102 | issue #6 Phase 4 |
| AdSense resubmission readiness (manual founder click, after ~2–4 wk indexing) | R-903 (guardrail) | issue #6 Phase 4 + founder |

## Key Decisions
- [ADR-0001](./adr/0001-adsense-publisher-content-strategy.md) — win AdSense with a genuine content layer, not checklist cosmetics.

## Known Debt
- **P1 — deploy.yml masks wrangler failures** (`| tee` without `pipefail`) and its CF API token fails auth (error 10000 on cache purge); CI-green ≠ deployed. Verified 2026-07-04.
- **P1 — plaintext `JWT_SECRET`** in root `wrangler.toml` `[env.production].vars` and in `api/wrangler.toml`. Rotation required (Phase 4).
- **P2 — committed `node_modules/`** (~3,200 files, long paths) and a `deploy.log` in git; needs `.gitignore` + `git rm -r --cached`.
- **P2 — three wrangler.toml files** (root, `api/`, `workers/`) for what is operationally one worker; `workers/` targets a dead `focusbro.dev` zone and `focusbro-api-production` (last modified 2026-05-06) appears orphaned.
- **P3 — ~40 loose planning/audit .md files at repo root** predating the docs control plane; most are stale (see `docs/STALE_DOCS.md`).
