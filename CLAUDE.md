# FocusBro — Standing Orders

> Canonical reference for all agents, engineers, and AI tools working in this repository.
> Read `ARCHITECTURE_PLAN.md` for the full 6-phase build plan and system model.
> Read `PRODUCT_PRINCIPLES.md` for the product philosophy and design decisions.

## Mission

FocusBro (focusbro.net) is a focus and wellness Progressive Web App with 14 built-in
wellness tools. Users track focus sessions, breathing exercises, grounding practices,
body scans, meditations, movement breaks, and more. Cloud sync, push notifications,
analytics, Slack integration, and team features are provided for Pro and Enterprise tiers.

Tiers: Free / Pro ($5/month or $49/year) / Enterprise ($15/user/month).

## Stack

> WARNING: FocusBro uses Cloudflare D1 (SQLite), NOT Neon PostgreSQL.
> Agents from other Factory repos must not assume Neon or Hyperdrive here.

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Router | itty-router (NOT Hono) |
| Database | Cloudflare D1 (SQLite) — binding: `DB` |
| Cache | Cloudflare KV — binding: `KV` |
| Auth | HMAC-SHA256 JWT (30-day tokens, no external auth dependency) |
| Frontend | Vanilla HTML5 + CSS3 + JavaScript — source of truth is `public/index.html`; one build step: `npm run build:html` |
| Push | Web Push API (VAPID keys in KV) |
| Payments | Stripe |
| Build | `npm run build:html` — `create-html-module.js` stringifies `public/index.html` → `api/src/html.js` (the string the Worker serves). Auto-run by the `predeploy` hook. |
| Tests | Vitest |

## Hard Constraints

- No `process.env` — use `env.VAR` (Worker bindings)
- No Node.js built-ins in Worker code (`fs`, `path`, `crypto`) — use Web Crypto API
- No `Buffer` — use `TextEncoder` / `TextDecoder` / `Uint8Array`
- No framework rewrites — router is itty-router; do not migrate to Hono without explicit decision
- No Neon, no Hyperdrive — database is Cloudflare D1 (`env.DB`)
- **Build the served HTML before every deploy** — `npm run build:html` regenerates `api/src/html.js` from `public/index.html`. The `predeploy` npm hook runs it automatically on `npm run deploy`. (`build-complete-html.js` and `public/components/views/*.js` are one-time assembly artifacts — already inlined into `public/index.html`; do NOT run them in a routine build.)
- Auth tokens are HS256 JWT signed with HMAC-SHA256 via Web Crypto — not jsonwebtoken
- Stripe webhook handlers must verify signature before processing
- D1 migrations live in `schema.sql` — never modify production schema without a migration file

## Surfaces

| Surface | URL |
|---------|-----|
| Production | https://focusbro.net |
| Worker health | `curl https://focusbro.adrper79.workers.dev/health` |

A fix is done when `curl https://focusbro.adrper79.workers.dev/health` returns `200`.

## Deploy

```bash
npm run build:html    # regenerate api/src/html.js from public/index.html
npm run deploy        # predeploy hook rebuilds HTML, then wrangler deploy --env production
```

## Test

```bash
npx vitest run
```

## The 14 Wellness Tools

Pomodoro Timer, Box Breathing, 4-7-8 Breathing, 5-4-3-2-1 Grounding, Body Scan,
Guided Meditation, Movement Break, Gratitude Journal, Mindful Check-In, Focus Music,
Ambient Sounds, Eye Rest, Hydration Reminder, Sleep Wind-Down.

## Session Start Checklist

1. Read `ARCHITECTURE_PLAN.md` — 6-phase build plan and system model
2. Read `PRODUCT_PRINCIPLES.md` — product philosophy, tier model, tool catalogue
3. Run `npx vitest run` — note current baseline
4. Read `src/index.js` (or main Worker entry) — router wiring and middleware
5. Confirm D1 schema in `schema.sql` before any database work
6. Check `git log --oneline -10` — understand recent changes
7. **Before deploying**: run `npm run build:html` (or `npm run deploy`, whose `predeploy` hook auto-builds)

## Key Docs

| Doc | Purpose |
|-----|---------|
| `ARCHITECTURE_PLAN.md` | 6-phase build plan, system architecture |
| `PRODUCT_PRINCIPLES.md` | Product philosophy, tier model, tool catalogue |
| `schema.sql` | D1 database schema |
| `public/index.html` | Frontend SPA |

## Commit Format

`type(scope): description`

Scopes: `worker`, `frontend`, `db`, `auth`, `tools`, `stripe`, `push`, `docs`
Types: `feat`, `fix`, `refactor`, `test`, `docs`, `perf`, `chore`
