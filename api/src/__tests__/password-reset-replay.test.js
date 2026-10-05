/**
 * FBQ-24 R1: a password-reset link works exactly once, proven against a REAL
 * migrated SQLite D1 through the Worker's own fetch(). The older test in
 * account-recovery.test.js only greps the SQL string, so dropping
 * `AND consumed_at IS NULL` from confirmPasswordReset went unnoticed.
 *
 * Flow: request reset (token captured from the outbound email) -> confirm with
 * the token -> confirm AGAIN with the same token. The replay must be rejected
 * and must leave the password set by the first confirmation in place.
 *
 * Mutant killed: removing `AND consumed_at IS NULL` (account-recovery.js
 * confirmPasswordReset).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { hashPassword, verifyPassword } from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const EMAIL = 'reset-replay@example.com';
const USER_ID = 'reset-replay-user';
const ctx = { waitUntil() {}, passThroughOnException() {} };

function makeEnv() {
  return {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    AUTH_EMAIL_FROM: 'support@example.com',
    RESEND_API_KEY: 're_test_key',
  };
}

function postJson(path, body) {
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify(body),
  });
}

const passwordHash = (env) => env.DB.sqlite
  .prepare('SELECT password_hash FROM users WHERE id = ?').get(USER_ID).password_hash;

afterEach(() => {
  vi.unstubAllGlobals();
});

suite('password reset link is single-use (real D1)', () => {
  it('rejects a replayed reset token and keeps the first new password', async () => {
    const env = makeEnv();
    env.DB.sqlite.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
      .run(USER_ID, EMAIL, await hashPassword('original-password'));

    // Capture the reset link from the outbound email instead of sending it.
    const sent = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }));

    const requested = await worker.fetch(postJson('/auth/request-password-reset', { email: EMAIL }), env, ctx);
    expect(requested.status).toBe(202);
    expect(sent).toHaveLength(1);
    const token = sent[0].body.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const first = await worker.fetch(
      postJson('/auth/confirm-password-reset', { token, password: 'first-new-password' }), env, ctx);
    expect(first.status).toBe(200);
    const afterFirst = passwordHash(env);
    expect(await verifyPassword('first-new-password', afterFirst)).toBe(true);
    const consumedAt = env.DB.sqlite
      .prepare("SELECT consumed_at FROM auth_action_tokens WHERE user_id = ? AND purpose = 'password_reset'")
      .get(USER_ID).consumed_at;
    expect(consumedAt).toBeTruthy();

    const replay = await worker.fetch(
      postJson('/auth/confirm-password-reset', { token, password: 'attacker-new-password' }), env, ctx);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'Invalid or expired reset link' });

    const afterReplay = passwordHash(env);
    expect(afterReplay).toBe(afterFirst);
    expect(await verifyPassword('attacker-new-password', afterReplay)).toBe(false);
    expect(await verifyPassword('first-new-password', afterReplay)).toBe(true);
    const resets = env.DB.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = ? AND action = 'password_reset'")
      .get(USER_ID).n;
    expect(resets).toBe(1);
  });
});
