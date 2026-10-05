/**
 * FBQ-24 R1: the two internal routes guarded by the shared cron secret, driven
 * through the Worker's own fetch() against a REAL migrated SQLite D1.
 *
 * What must hold for POST /api/internal/run-checkins and
 * POST /api/internal/seed-dogfood:
 *   - CRON_TRIGGER_KEY unset          -> 404 (the route cannot be probed);
 *   - key set, x-cron-key missing     -> 401, nothing written;
 *   - key set, x-cron-key wrong       -> 401, nothing written;
 *   - key set, x-cron-key correct     -> accepted (200 / 201).
 *
 * Mutants killed: `if (key !== env.CRON_TRIGGER_KEY)` -> `if (false)` in each
 * route (before this file, no test touched either route).
 */
import { describe, expect, it } from 'vitest';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const CRON_KEY = 'cron-key-for-tests-0123456789abcdef';
const ctx = { waitUntil() {}, passThroughOnException() {} };

function makeEnv({ cronKey = CRON_KEY } = {}) {
  const env = {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
  };
  if (cronKey) env.CRON_TRIGGER_KEY = cronKey;
  return env;
}

function post(path, { key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['x-cron-key'] = key;
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

function seedUser(env, email) {
  env.DB.sqlite.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run('dogfood-user', email, 'pbkdf2-sha256$100000$c2FsdA$aGFzaA');
}

const commitmentCount = (env) => env.DB.sqlite
  .prepare('SELECT COUNT(*) AS n FROM commitments').get().n;

suite('POST /api/internal/run-checkins requires the cron key', () => {
  const path = '/api/internal/run-checkins';

  it('404s when no cron key is configured', async () => {
    const res = await worker.fetch(post(path, { key: CRON_KEY }), makeEnv({ cronKey: null }), ctx);
    expect(res.status).toBe(404);
  });

  it.each([
    ['a missing', undefined],
    ['an empty', ''],
    ['a wrong', 'not-the-cron-key'],
    ['a truncated', CRON_KEY.slice(0, -1)],
    ['an overlong', CRON_KEY + 'x'],
  ])('rejects %s x-cron-key with 401', async (_label, key) => {
    const res = await worker.fetch(post(path, { key }), makeEnv(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('accepts the configured key and runs the delivery pass', async () => {
    const res = await worker.fetch(post(path, { key: CRON_KEY }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('escalations');
    expect(body).toHaveProperty('returnNudges');
  });
});

suite('POST /api/internal/seed-dogfood requires the cron key', () => {
  const path = '/api/internal/seed-dogfood';
  const email = 'founder@example.com';

  it('404s when no cron key is configured', async () => {
    const env = makeEnv({ cronKey: null });
    seedUser(env, email);
    const res = await worker.fetch(post(path, { key: CRON_KEY, body: { email } }), env, ctx);
    expect(res.status).toBe(404);
    expect(commitmentCount(env)).toBe(0);
  });

  it.each([
    ['a missing', undefined],
    ['an empty', ''],
    ['a wrong', 'not-the-cron-key'],
    ['a truncated', CRON_KEY.slice(0, -1)],
    ['an overlong', CRON_KEY + 'x'],
  ])('rejects %s x-cron-key with 401 and writes nothing', async (_label, key) => {
    const env = makeEnv();
    seedUser(env, email);
    const res = await worker.fetch(post(path, { key, body: { email } }), env, ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(commitmentCount(env)).toBe(0);
  });

  it('accepts the configured key and seeds the commitment', async () => {
    const env = makeEnv();
    seedUser(env, email);
    const res = await worker.fetch(post(path, { key: CRON_KEY, body: { email } }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const row = env.DB.sqlite
      .prepare('SELECT user_id, title FROM commitments WHERE id = ?').get(body.commitment_id);
    expect(row).toEqual({ user_id: 'dogfood-user', title: 'Send one outreach item' });
  });
});
