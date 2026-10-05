# FocusBro API Testing Guide

Vitest for the worker (`api/src/__tests__/`, ~165 files), Playwright for the browser
smoke (`api/e2e/`). CI (`.github/workflows/test.yml`) runs on **Node 24.x**; the real-D1
helper needs `node:sqlite` (Node 22.5+), and its suites skip themselves on older Node.

## Run

```bash
cd api && npm ci
npm run lint            # eslint src --max-warnings 0
npm run build           # node --check on the worker files
npm test                # vitest run
npm run test:coverage   # what CI runs; enforces the floor in vitest.config.js
npm run test:smoke      # Playwright (needs the browsers Playwright expects)
npx vitest run src/__tests__/route-consent.test.js     # one file
npx vitest run --sequence.shuffle                       # order-independence check
```

No `.env` is needed: tests build their own `env` (secrets are literals in the test).

## Two ways to test a route

1. **Real D1 (preferred for anything that reads or writes state).**
   `helpers/real-d1.js` builds an in-memory SQLite from every `migrations/NNNN_*.sql`, so
   CHECK constraints, unique indexes and foreign keys are the production ones.
   `helpers/route-kit.js` wraps it: `makeEnv()`, `call(env, path, {method, body, cookie})`
   through `worker.fetch`, and `register(env, email)` which signs up the way a person does
   and returns the session cookie. Assert the status **and** read the table back
   (`row`/`rows`/`count`). A 200 alone proves nothing.
2. **Hand-rolled D1 stub** for pure unit tests of a helper. Never use one to claim a route
   works; a stub returns whatever the test told it to.

Every route test should cover the unhappy paths: 401 without a session (and with a forged
cookie), 400 on bad input with nothing written, and cross-user 404/no-effect.

## Schema source of truth

`migrations/` is the source of truth. `schema.sql` is a mirror; `schema-parity.test.js`
fails if they drift.

## Writing tests that stay honest

- Import the real code from `src/`. A test that re-implements the validator inline and
  asserts on literals (the old `auth.test.js` / `validation.test.js`) can never fail.
- Prove a new gate can fail: break the source briefly, watch the test go red, revert.
- Do not depend on module state leaking between files. `vi.mock` plus a top-level
  `await import()` needs `vi.resetModules()` first and a `vi.doUnmock` + `vi.resetModules()`
  in `afterAll`, or the file passes only under the default isolated pool.
- No wall-clock literals without fake timers (the "burned fixture date" failure class).

## Coverage floor

`vitest.config.js` `thresholds` is a ratchet: kept about 3 points below actual so a
regression fails CI. When you add coverage, raise it; never lower it to land a change.

## CI

`test.yml`: content-ledger check, lint, `build:html`, `test:coverage`, then the Playwright
smoke job. Merge-gate details live in `docs/QA_REMEDIATION_2026-10.md` (FBQ-25).
