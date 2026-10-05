/**
 * FBQ-05 (P1) — the delivery cron claims a check-in before it sends it.
 *
 * The cron read due `pending` rows, sent, then ran an UNCONDITIONAL
 * `UPDATE … SET status='sent' WHERE id = ?`. So two overlapping ticks (or a
 * tick racing POST /api/internal/run-checkins) sent the same nudge twice, and
 * an "I did it" tapped while the push was in flight was overwritten back to
 * `sent` — a second tap then credited the streak twice. Driven here with the
 * real cron and the real answer route on a real migrated SQLite; only the push
 * wire (sendWebPush) is intercepted, so every send is counted.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { runDueCheckins, SEND_LEASE_MIN } from '../checkins-cron.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const push = vi.hoisted(() => ({ impl: null, calls: 0 }));
vi.mock('../webpush.js', async (importOriginal) => ({
  ...(await importOriginal()),
  vapidConfigured: () => true,
  sendWebPush: (...args) => { push.calls++; return push.impl(...args); },
}));

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const TZ = 'America/New_York';
const NOW = '2026-10-05T15:00:00.000Z'; // 11:00 New York
const DUE = '2026-10-05T14:30:00.000Z'; // 10:30 New York, today
const plus = (min) => new Date(Date.parse(NOW) + min * 60 * 1000).toISOString();

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return {
    DB, KV_CACHE: makeKV(), BUILD_SHA: 'abc1234',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv',
    TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111',
  };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const call = async (env, method, path, opts) => {
  const res = await worker.fetch(req(method, path, opts), env, ctx);
  return { status: res.status, body: await res.json() };
};
/** A guest with one word due at DUE and one active push subscription. */
async function wordWithPush(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await g.json();
  const c = await call(env, 'POST', '/api/commitments', {
    cookie, body: { title: 'stretch', start_at: DUE, checkin_at: DUE, persona: 'ally', timezone: TZ },
  });
  expect(c.status).toBe(201);
  env.DB.sqlite.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, is_active)
     VALUES (?, ?, ?, 'p', 'a', 1)`,
  ).run(`sub-${userId}`, userId, `https://fcm.googleapis.com/fcm/send/${userId}`);
  return { cookie, userId, id: c.body.commitment.id };
}
const row = (env, id) => env.DB.sqlite.prepare(
  'SELECT id, status, lease_until, attempts, delivered_at FROM commitment_checkins WHERE commitment_id = ? ORDER BY scheduled_for LIMIT 1',
).get(id);
const kept = (env, userId) => (env.DB.sqlite.prepare(
  'SELECT total_kept FROM accountability_streaks WHERE user_id = ?',
).get(userId) || { total_kept: 0 }).total_kept;
// Real-time poll (only Date is faked): the push path signs a reply ticket with
// crypto.subtle, which settles off the microtask queue.
const until = async (cond) => { for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

suite('FBQ-05: the cron claims a check-in before sending it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    push.calls = 0;
    push.impl = async () => ({ ok: true });
  });
  afterEach(() => vi.useRealTimers());

  it('two concurrent ticks over the same due row send it exactly once', async () => {
    const env = makeEnv();
    const { id } = await wordWithPush(env);
    const [a, b] = await Promise.all([runDueCheckins(env, { now: NOW }), runDueCheckins(env, { now: NOW })]);
    expect(push.calls).toBe(1);
    expect(a.sent + b.sent).toBe(1);
    expect(row(env, id)).toMatchObject({ status: 'sent', lease_until: null, attempts: 1 });
  });

  it('"I did it" while the push is in flight survives; a second tap credits nothing', async () => {
    const env = makeEnv();
    const { cookie, userId, id } = await wordWithPush(env);
    let release;
    push.impl = () => new Promise((r) => { release = () => r({ ok: true }); });
    const tick = runDueCheckins(env, { now: NOW });
    await until(() => push.calls === 1);
    expect(push.calls).toBe(1);

    const first = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(first.body.recorded).toBe(true);
    release();
    await tick;
    expect(row(env, id).status).toBe('kept');

    const second = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(second.body.recorded).toBe(false);
    expect(kept(env, userId)).toBe(1);
  });

  it('a tick that dies mid-send holds the row until the lease expires, then it is sent once', async () => {
    const env = makeEnv();
    const { id } = await wordWithPush(env);
    let finishHung;
    push.impl = () => new Promise((r) => { finishHung = () => r({ ok: true }); });
    const hung = runDueCheckins(env, { now: NOW }); // never completes on its own: a crashed invocation
    await until(() => push.calls === 1);
    push.impl = async () => ({ ok: true });

    await runDueCheckins(env, { now: plus(1) });
    expect(push.calls).toBe(1); // still claimed: no second send a minute later
    expect(row(env, id).status).toBe('sending');

    await runDueCheckins(env, { now: plus(SEND_LEASE_MIN + 1) });
    expect(push.calls).toBe(2); // lease expired → reclaimed and delivered once
    const after = row(env, id);
    expect(after).toMatchObject({ status: 'sent', lease_until: null });

    // The dead tick's late completion cannot clobber the row the new tick owns.
    finishHung();
    await hung;
    expect(row(env, id)).toMatchObject({ status: 'sent', delivered_at: after.delivered_at });
    await runDueCheckins(env, { now: plus(SEND_LEASE_MIN + 2) });
    expect(push.calls).toBe(2);
  });

  it('a thrown send releases the claim; the next tick sends it exactly once', async () => {
    const env = makeEnv();
    const { id } = await wordWithPush(env);
    push.impl = async () => { throw new Error('boom'); };
    const s1 = await runDueCheckins(env, { now: NOW });
    expect(s1.retry).toBe(1);
    expect(row(env, id)).toMatchObject({ status: 'pending', lease_until: null, attempts: 1 });

    push.impl = async () => ({ ok: true });
    await runDueCheckins(env, { now: plus(1) });
    await runDueCheckins(env, { now: plus(2) });
    expect(push.calls).toBe(2); // the throw, then one delivery
    expect(row(env, id)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it.each([
    ['quiet hours', 0, 23],
    ['night guard', null, null],
  ])('a row held back (%s) is left pending, never stranded as sending', async (_label, qs, qe) => {
    const env = makeEnv();
    const { userId, id } = await wordWithPush(env);
    const s = env.DB.sqlite;
    s.prepare(`UPDATE commitment_checkins SET channel = 'text' WHERE commitment_id = ?`).run(id);
    s.prepare(`UPDATE users SET phone = '+15550002222', phone_verified_at = datetime('now') WHERE id = ?`).run(userId);
    s.prepare(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES ('pp', ?, 'cs_1', 'paid', ?)`).run(userId, NOW);
    s.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, quiet_start, quiet_end, timezone)
               VALUES ('cc', ?, 'text', 'granted', ?, ?, ?)`).run(userId, qs, qe, TZ);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // Night guard: 10:30 was daytime, but 03:00 New York the next day is night.
    const now = qs === null ? '2026-10-06T07:00:00.000Z' : NOW;
    const sum = await runDueCheckins(env, { now });
    vi.unstubAllGlobals();
    expect(sum.deferred).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(row(env, id)).toMatchObject({ status: 'pending', lease_until: null, attempts: 0 });
  });
});
