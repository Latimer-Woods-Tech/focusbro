---
verified: "2026-07-26"
verified_by: agent (repository, CI/deploy history, production health, and read-only D1 inspection)
last_updated: "2026-07-26"
---

# FocusBro — Architecture

## Current system

FocusBro is a single Cloudflare Worker serving `https://focusbro.net`. It uses
itty-router, Cloudflare D1, and Cloudflare KV; there is no Pages, Neon, or
separate application runtime. The Worker serves the generated acquisition shell
from `api/src/html.js` (built from `public/index.html`) and focused server-owned
surfaces such as `/me/`, `/me/report`, and `/coach/` from Worker modules.

| Component | Current implementation |
|---|---|
| Runtime and routes | Cloudflare Worker, `api/src/index.js`, itty-router |
| Database | D1 `focusbro-db`, immutable migrations through `0006_sync_device_log_schema` |
| Cache | KV binding `KV_CACHE` |
| Authentication | PBKDF2 password hashes, revocable hash-only sessions, secure HttpOnly cookies |
| Delivery | Minute cron for accountability check-ins; Web Push and consent-gated text boundaries |
| CI | GitHub Actions: lint, 813-unit-test coverage suite, fresh-D1 migration contract, mobile Playwright smoke, docs health |
| Deploy | Reviewed D1 migrations, Worker deploy, cache purge, exact build-SHA health canary |

The production canary was verified at build
`0efe14ddbe3d91ec7c8d7dfc9607f411c68858a3`: `/health` returned 200 with
schema `0006_sync_device_log_schema` and a fresh cron heartbeat.

## Configuration and secret boundary

The root `wrangler.toml` is the only Worker configuration in this repository.
It contains public bindings and non-secret environment values only. Deployment
credentials are supplied by GitHub secrets, while operational credentials are
retrieved from GCP Secret Manager for controlled local operations. Never put a
JWT, provider token, or webhook secret in Wrangler variables or source.

## Managed technical debt

| Debt | State | Exit condition |
|---|---|---|
| Legacy bearer-session bridge and SHA-256 password compatibility | Blocked safely | Remove only after production has zero legacy session credentials and zero legacy password hashes; the 2026-07-26 read-only D1 check found one of each. |
| Generated acquisition shell and inline scripts | Queued | Split browser modules and move static assets to Workers Assets only after preserving the critical mobile journeys and enforcing CSP. |
| Dormant billing implementation | Intentionally gated | Rebuild against the canonical `subscriptions` contract after the retention gate; do not re-enable legacy routes. |
| Archive-document link debt | Non-runtime cleanup | Archive or repair historical references without weakening canonical docs-health checks. |

The execution order, acceptance gates, and ownership boundaries are maintained
in [`IMPROVEMENT_PLAN.md`](./IMPROVEMENT_PLAN.md). The founding-cohort learning
gate remains founder- and time-owned; code cannot substitute for retained-user
evidence.
