/**
 * FBQ-08 (P1) — push intake and delivery are bounded.
 *
 * Before: subscribe accepted ANY URL (the Worker then POSTed to it: SSRF-lite),
 * with no per-user cap; sendWebPush had no timeout and the cron sent serially, so
 * one endpoint that accepts and never answers stalled every later check-in; the
 * request carried no Urgency and a 12h TTL; a 400/403 never retired a dead
 * subscription. Driven with the real worker, the real cron and the REAL
 * sendWebPush on a real migrated SQLite; only the network `fetch` is stubbed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { runDueCheckins } from '../checkins-cron.js';
import * as webpush from '../webpush.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const { bytesToB64url, b64ToBytes } = webpush;
// Absent on unmodified main: the fail-first run must fail on behaviour, not on import.
const isAllowedPushEndpoint = webpush.isAllowedPushEndpoint || (() => false);

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const TZ = 'America/New_York';
const NOW = '2026-10-05T15:00:00.000Z';
const DUE = '2026-10-05T14:30:00.000Z';
const FCM = 'https://fcm.googleapis.com/fcm/send/';

async function makeEnv() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return {
    DB, KV_CACHE: makeKV(), BUILD_SHA: 'abc1234',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    VAPID_PUBLIC_KEY: bytesToB64url(pub), VAPID_PRIVATE_KEY: bytesToB64url(b64ToBytes(jwk.d)),
  };
}
async function subKeys() {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    p256dh: bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))),
    auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function guest(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  return { cookie: g.headers.get('Set-Cookie').split(';')[0], userId: (await g.json()).user_id };
}
async function subscribe(env, cookie, endpoint, keys) {
  const res = await worker.fetch(req('POST', '/notifications/subscribe', {
    cookie, body: { subscription: { endpoint, keys: keys || await subKeys() } },
  }), env, ctx);
  return res.status;
}
/** A guest with one word due now and the given push subscriptions (inserted directly). */
async function wordWith(env, endpoints) {
  const { cookie, userId } = await guest(env);
  const c = await worker.fetch(req('POST', '/api/commitments', {
    cookie, body: { title: 'stretch', start_at: DUE, checkin_at: DUE, persona: 'ally', timezone: TZ },
  }), env, ctx);
  expect(c.status).toBe(201);
  const id = (await c.json()).commitment.id;
  for (const [i, ep] of endpoints.entries()) {
    const k = await subKeys();
    env.DB.sqlite.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(`s-${userId}-${i}`, userId, ep, k.p256dh, k.auth);
  }
  return { cookie, userId, id };
}
const checkin = (env, id) => env.DB.sqlite.prepare(
  'SELECT status, attempts, last_error FROM commitment_checkins WHERE commitment_id = ? LIMIT 1').get(id);
const active = (env, endpoint) => env.DB.sqlite.prepare(
  'SELECT is_active FROM push_subscriptions WHERE endpoint = ?').get(endpoint).is_active;

suite('FBQ-08 R1: subscribe accepts only known push-service hosts', () => {
  it.each([
    ['https://evil.example/x'],
    ['http://fcm.googleapis.com/fcm/send/a'], // not https
    ['https://fcm.googleapis.com.evil.example/a'], // suffix trick
    ['https://evilfcm.googleapis.com/a'], // not a listed host
    ['https://evil.com/?h=fcm.googleapis.com'],
    ['https://user:pw@fcm.googleapis.com/a'], // credentials
    ['https://fcm.googleapis.com:8443/a'], // odd port
    ['https://127.0.0.1/a'],
    [`${FCM}${'a'.repeat(600)}`], // too long
  ])('rejects %s with 400 and stores nothing', async (endpoint) => {
    const env = await makeEnv();
    const { cookie } = await guest(env);
    expect(await subscribe(env, cookie, endpoint)).toBe(400);
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n).toBe(0);
  });

  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc'],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc'],
    ['https://wns2-par02p.notify.windows.com/w/?token=abc'],
    ['https://web.push.apple.com/abc'],
    ['https://api.push.apple.com/3/device/abc'],
  ])('accepts %s', async (endpoint) => {
    const env = await makeEnv();
    const { cookie } = await guest(env);
    expect(await subscribe(env, cookie, endpoint)).toBe(200);
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it('rejects an oversized key', async () => {
    const env = await makeEnv();
    const { cookie } = await guest(env);
    expect(await subscribe(env, cookie, `${FCM}a`, { p256dh: 'x'.repeat(300), auth: 'a' })).toBe(400);
  });
});

suite('FBQ-08 R2: at most 5 active subscriptions per user', () => {
  it('the 6th retires the oldest; the 6th is active', async () => {
    const env = await makeEnv();
    const { cookie, userId } = await guest(env);
    for (let i = 1; i <= 5; i++) {
      env.DB.sqlite.prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, is_active, created_at)
         VALUES (?, ?, ?, 'p', 'a', 1, ?)`,
      ).run(`s${i}`, userId, `${FCM}${i}`, `2026-10-0${i} 10:00:00`);
    }
    expect(await subscribe(env, cookie, `${FCM}6`)).toBe(200);
    expect(active(env, `${FCM}1`)).toBe(0);
    for (const i of [2, 3, 4, 5, 6]) expect(active(env, `${FCM}${i}`)).toBe(1);
    // Another user's rows are untouched.
    const other = await guest(env);
    expect(await subscribe(env, other.cookie, `${FCM}other`)).toBe(200);
    expect(active(env, `${FCM}2`)).toBe(1);
  });
});

suite('FBQ-08 R3-R5: delivery is bounded, urgent, short-lived, self-cleaning', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('a hung endpoint does not stall the tick: it is retried and a second user is still delivered', async () => {
    const env = await makeEnv();
    const a = await wordWith(env, [`${FCM}hung`]);
    const b = await wordWith(env, [`${FCM}fine`]);
    const seen = [];
    // Hangs for ever; only settles if the caller aborts it. (Without a signal it never returns.)
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      seen.push(url);
      if (!url.endsWith('/hung')) return Promise.resolve({ ok: true, status: 201 });
      return new Promise((_, rej) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => rej(new Error('aborted')));
      });
    }));
    const tick = runDueCheckins(env, { now: NOW });
    const winner = await Promise.race([tick, new Promise((r) => setTimeout(() => r('HUNG'), 9000))]);
    expect(winner).not.toBe('HUNG');
    expect(winner.sent).toBe(1);
    expect(winner.retry).toBe(1);
    expect(checkin(env, a.id)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'push_timeout' });
    expect(checkin(env, b.id).status).toBe('sent');
    expect(seen).toHaveLength(2);
  }, 20000);

  it('sends Urgency: high and a TTL no longer than 1h (inside the 24h window)', async () => {
    const env = await makeEnv();
    await wordWith(env, [`${FCM}one`]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await runDueCheckins(env, { now: NOW });
    const h = fetchMock.mock.calls[0][1].headers;
    expect(h.Urgency).toBe('high');
    expect(Number(h.TTL)).toBeGreaterThan(0);
    expect(Number(h.TTL)).toBeLessThanOrEqual(3600);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a row that predates the allowlist is never fetched and is retired', async () => {
    const env = await makeEnv();
    const w = await wordWith(env, ['https://evil.example/hook']);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await runDueCheckins(env, { now: NOW });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(active(env, 'https://evil.example/hook')).toBe(0);
    expect(checkin(env, w.id).last_error).toBe('endpoint_not_allowed');
  });

  it.each([404, 410])('%i deactivates immediately, even with no other success', async (status) => {
    const env = await makeEnv();
    await wordWith(env, [`${FCM}gone`]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status })));
    await runDueCheckins(env, { now: NOW });
    expect(active(env, `${FCM}gone`)).toBe(0);
  });

  it.each([400, 403])('%i deactivates the bad subscription when other pushes in the tick succeed', async (status) => {
    const env = await makeEnv();
    await wordWith(env, [`${FCM}dead`]);
    await wordWith(env, [`${FCM}fine`]);
    vi.stubGlobal('fetch', vi.fn(async (url) => (url.endsWith('/dead') ? { ok: false, status } : { ok: true, status: 201 })));
    await runDueCheckins(env, { now: NOW });
    expect(active(env, `${FCM}dead`)).toBe(0);
    expect(active(env, `${FCM}fine`)).toBe(1);
  });

  it.each([400, 403])('mass-%i guard: when NOTHING in the tick succeeds nothing is deactivated, and it logs loudly', async (status) => {
    const env = await makeEnv();
    await wordWith(env, [`${FCM}a`, `${FCM}b`]);
    await wordWith(env, [`${FCM}c`]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runDueCheckins(env, { now: NOW });
    for (const e of ['a', 'b', 'c']) expect(active(env, `${FCM}${e}`)).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toContain('push_vapid_suspect');
    err.mockRestore();
  });
});
