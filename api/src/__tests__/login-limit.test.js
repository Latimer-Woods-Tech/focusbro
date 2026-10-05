/**
 * FBQ-13 (focusbro#391): the login limit stops guessing — proven against a
 * REAL migrated SQLite D1 through the Worker's own fetch().
 *
 * Before: the limit was checked only on the wrong-password branches, so a
 * correct guess always got in while the account was "limited"; there was no
 * IP-wide budget across accounts; and every limiter was a KV read-then-write,
 * so 40 concurrent guest creates all got 201 despite a 10-per-IP limit.
 *
 * Mutants killed: checking the limit after verifyPassword; dropping the IP-wide
 * key; a read-then-write limiter; a policy that accepts a short all-digit password.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { hashPassword } from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const PASSWORD = 'correct horse battery';

function makeEnv() {
  return {
    DB: makeMigratedD1(),
    KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    AUTH_EMAIL_FROM: 'support@example.com',
    RESEND_API_KEY: 're_test_key',
  };
}

function post(env, path, body, ip = '203.0.113.9') {
  return worker.fetch(new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  }), env, ctx);
}

async function addUser(env, email, id = `user-${email}`) {
  env.DB.sqlite.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(id, email, await hashPassword(PASSWORD));
}

const login = (env, email, password, ip) => post(env, '/auth/login', { email, password }, ip);

async function lockAccount(env, email, ip) {
  for (let i = 0; i < 10; i += 1) {
    expect((await login(env, email, 'wrong-guess-' + i, ip)).status).toBe(401);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

suite('FBQ-13 login limit (real D1)', () => {
  it('answers 429 to the CORRECT password while the account is limited', async () => {
    const env = makeEnv();
    await addUser(env, 'locked@example.invalid');
    await lockAccount(env, 'locked@example.invalid');
    const res = await login(env, 'locked@example.invalid', PASSWORD);
    expect(res.status).toBe(429);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // The lock is per account+IP: the owner on another network is not locked out.
    expect((await login(env, 'locked@example.invalid', PASSWORD, '198.51.100.7')).status).toBe(200);
  });

  it('trips an IP-wide limit on failures spread across accounts', async () => {
    const env = makeEnv();
    await addUser(env, 'bystander@example.invalid');
    // 30 failures, each against a different account, never 10 on any one.
    for (let i = 0; i < 30; i += 1) {
      expect((await login(env, `spray-${i}@example.invalid`, 'Password1!')).status).toBe(401);
    }
    expect((await login(env, 'bystander@example.invalid', PASSWORD)).status).toBe(429);
    expect((await login(env, 'bystander@example.invalid', PASSWORD, '198.51.100.7')).status).toBe(200);
  });

  it('a successful login does not reset the IP-wide budget', async () => {
    const env = makeEnv();
    await addUser(env, 'mine@example.invalid');
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 10; i += 1) {
        await login(env, `victim-${round}-${i}@example.invalid`, 'guess');
      }
      // The attacker's own account logging in between rounds must not refund the spray.
      await login(env, 'mine@example.invalid', PASSWORD);
    }
    expect((await login(env, 'victim-x@example.invalid', 'guess')).status).toBe(429);
  });

  it('restores login once the window has passed', async () => {
    const env = makeEnv();
    await addUser(env, 'later@example.invalid');
    await lockAccount(env, 'later@example.invalid');
    expect((await login(env, 'later@example.invalid', PASSWORD)).status).toBe(429);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60 * 1000);
    expect((await login(env, 'later@example.invalid', PASSWORD)).status).toBe(200);
  });

  it('a limited account can still request — and complete — a password reset', async () => {
    const env = makeEnv();
    await addUser(env, 'forgot@example.invalid');
    await lockAccount(env, 'forgot@example.invalid');
    const sent = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }));
    expect((await post(env, '/auth/request-password-reset', { email: 'forgot@example.invalid' })).status).toBe(202);
    expect(sent).toHaveLength(1);
    const token = sent[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    expect((await post(env, '/auth/confirm-password-reset', { token, password: 'a brand new phrase' })).status).toBe(200);
    // Proving ownership by email lifts the account lock.
    expect((await login(env, 'forgot@example.invalid', 'a brand new phrase')).status).toBe(200);
  });

  it('40 concurrent guest creates from one IP give at most 10 × 201', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 40 }, () => post(env, '/auth/guest', {})),
    );
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThanOrEqual(10);
    expect(results.every((r) => r.status === 201 || r.status === 429)).toBe(true);
    const rows = env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE is_guest = 1').get().n;
    expect(rows).toBe(created);
  });
});

suite('FBQ-13 R4 password policy (real D1)', () => {
  it('rejects an all-digit password shorter than 12 characters', async () => {
    const env = makeEnv();
    const res = await post(env, '/auth/register', { email: 'digits@example.invalid', password: '12345678' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/12/);
    expect((await post(env, '/auth/register', { email: 'digits@example.invalid', password: '12345678901' })).status).toBe(400);
  });

  it('still accepts a 12-digit password and an ordinary 8-character one', async () => {
    const env = makeEnv();
    expect((await post(env, '/auth/register', { email: 'long@example.invalid', password: '123456789012' })).status).toBe(201);
    expect((await post(env, '/auth/register', { email: 'mixed@example.invalid', password: 'abc12345' }, '198.51.100.7')).status).toBe(201);
  });
});
