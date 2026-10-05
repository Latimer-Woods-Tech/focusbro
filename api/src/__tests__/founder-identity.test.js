/**
 * FBQ-14: founder-only access is bound to a pinned user id and a VERIFIED
 * email — never to the (public) FOUNDER_EMAIL alone.
 *
 * Driven through the Worker's own fetch() against a REAL migrated SQLite D1.
 * Accounts are created through POST /auth/register, exactly as the 2026-10-05
 * QA probe created one with the founder address in production.
 *
 * What must hold on GET /api/internal/metrics and
 * POST /api/internal/webhooks/telnyx/:eventId/replay:
 *   - an UNVERIFIED account holding the founder email -> 401 (was 200 on main);
 *   - FOUNDER_USER_ID unset, founder email VERIFIED   -> allowed (transition);
 *   - FOUNDER_USER_ID set: only that id, and only once verified; a different
 *     verified account matching FOUNDER_EMAIL is refused;
 *   - FOUNDER_USER_ID set, FOUNDER_EMAIL unset        -> still works (the id is
 *     the identity; the public email is no longer needed).
 * And the x-cron-key path still accepts the right key and rejects wrong,
 * short and long keys.
 */
import { describe, expect, it } from 'vitest';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const FOUNDER_EMAIL = 'founder@example.invalid';
const CRON_KEY = 'cron-key-for-tests-0123456789abcdef';
const ctx = { waitUntil() {}, passThroughOnException() {} };

function makeEnv({ founderUserId, founderEmail = FOUNDER_EMAIL, cronKey } = {}) {
  const env = {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    API_ORIGIN: ORIGIN,
  };
  if (founderEmail) env.FOUNDER_EMAIL = founderEmail;
  if (founderUserId) env.FOUNDER_USER_ID = founderUserId;
  if (cronKey) env.CRON_TRIGGER_KEY = cronKey;
  return env;
}

async function register(env, email) {
  const res = await worker.fetch(new Request(ORIGIN + '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: 'correct-horse-battery' }),
  }), env, ctx);
  expect(res.status).toBe(201);
  const body = await res.json();
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0];
  expect(cookie).toContain('=');
  return { userId: body.user_id, cookie };
}

function markVerified(env, userId) {
  env.DB.sqlite.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(userId);
}

function metrics(env, headers = {}) {
  return worker.fetch(new Request(ORIGIN + '/api/internal/metrics', { headers }), env, ctx);
}

function replay(env, headers = {}) {
  return worker.fetch(new Request(ORIGIN + '/api/internal/webhooks/telnyx/evt-none/replay', {
    method: 'POST', headers: { Origin: ORIGIN, ...headers },
  }), env, ctx);
}

suite('FBQ-14: founder access needs the pinned id and a verified email', () => {
  it('denies an UNVERIFIED account registered with the founder email (metrics + replay)', async () => {
    const env = makeEnv();
    const { cookie } = await register(env, FOUNDER_EMAIL);
    expect((await metrics(env, { Cookie: cookie })).status).toBe(401);
    expect((await replay(env, { Cookie: cookie })).status).toBe(401);
  });

  it('denies an UNVERIFIED founder-email account even when it IS the pinned id', async () => {
    const env = makeEnv();
    const { userId, cookie } = await register(env, FOUNDER_EMAIL);
    env.FOUNDER_USER_ID = userId;
    expect((await metrics(env, { Cookie: cookie })).status).toBe(401);
    expect((await replay(env, { Cookie: cookie })).status).toBe(401);
  });

  it('transition: with FOUNDER_USER_ID unset, a VERIFIED founder-email account is allowed', async () => {
    const env = makeEnv();
    const { userId, cookie } = await register(env, FOUNDER_EMAIL);
    markVerified(env, userId);
    const res = await metrics(env, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // Replay reaches the lookup (404 = no such failed event), i.e. it is authorized.
    expect((await replay(env, { Cookie: cookie })).status).toBe(404);
  });

  it('with FOUNDER_USER_ID set, only that verified id is allowed', async () => {
    const env = makeEnv();
    const founder = await register(env, FOUNDER_EMAIL);
    markVerified(env, founder.userId);
    env.FOUNDER_USER_ID = founder.userId;
    expect((await metrics(env, { Cookie: founder.cookie })).status).toBe(200);
    expect((await replay(env, { Cookie: founder.cookie })).status).toBe(404);
  });

  it('with FOUNDER_USER_ID set, a different VERIFIED account matching FOUNDER_EMAIL is refused', async () => {
    const env = makeEnv();
    const impostor = await register(env, FOUNDER_EMAIL);
    markVerified(env, impostor.userId);
    env.FOUNDER_USER_ID = 'the-real-founder-id';
    expect((await metrics(env, { Cookie: impostor.cookie })).status).toBe(401);
    expect((await replay(env, { Cookie: impostor.cookie })).status).toBe(401);
  });

  it('with FOUNDER_USER_ID set, a verified non-founder account is refused', async () => {
    const env = makeEnv();
    const founder = await register(env, FOUNDER_EMAIL);
    markVerified(env, founder.userId);
    env.FOUNDER_USER_ID = founder.userId;
    const other = await register(env, 'someone@example.invalid');
    markVerified(env, other.userId);
    expect((await metrics(env, { Cookie: other.cookie })).status).toBe(401);
  });

  it('with FOUNDER_USER_ID set and FOUNDER_EMAIL unset, the pinned verified id still works', async () => {
    const env = makeEnv({ founderEmail: null });
    const founder = await register(env, 'founder-moved@example.invalid');
    markVerified(env, founder.userId);
    env.FOUNDER_USER_ID = founder.userId;
    expect((await metrics(env, { Cookie: founder.cookie })).status).toBe(200);
  });

  it('404s when neither the cron key nor any founder identity is configured', async () => {
    const env = makeEnv({ founderEmail: null });
    const { cookie } = await register(env, 'someone@example.invalid');
    expect((await metrics(env, { Cookie: cookie })).status).toBe(404);
  });
});

suite('FBQ-14 R2: the metrics cron key is compared in constant time and exactly', () => {
  it.each([
    ['a wrong', 'not-the-cron-key-0123456789abcdef!!'],
    ['a short', CRON_KEY.slice(0, -1)],
    ['a long', CRON_KEY + 'x'],
    ['an empty', ''],
  ])('rejects %s x-cron-key with 401 on metrics and replay', async (_label, key) => {
    const env = makeEnv({ cronKey: CRON_KEY });
    expect((await metrics(env, { 'x-cron-key': key })).status).toBe(401);
    expect((await replay(env, { 'x-cron-key': key })).status).toBe(401);
  });

  it('accepts the configured key on metrics and replay', async () => {
    const env = makeEnv({ cronKey: CRON_KEY });
    expect((await metrics(env, { 'x-cron-key': CRON_KEY })).status).toBe(200);
    expect((await replay(env, { 'x-cron-key': CRON_KEY })).status).toBe(404);
  });
});

describe('FBQ-14 R2: no route compares the cron key with a plain (early-exit) string compare', () => {
  it('index.js never does `=== / !== env.CRON_TRIGGER_KEY`', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/[!=]==\s*env\.CRON_TRIGGER_KEY/);
    expect(src).toMatch(/cronKeyMatches\(/);
  });
});
