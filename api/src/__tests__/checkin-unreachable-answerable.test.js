/**
 * FBQ-01 (P0) — a check-in no channel could reach can still be answered.
 *
 * With no push subscription (every Android-app user: the WebView has no
 * PushManager; every web user who declined push) the delivery cron parks the
 * due row `skipped / no_subscription`. The answer path only resolved sent /
 * deferred / awaiting_time / due-pending rows, so "I did it" answered 200 "got
 * this one already" and wrote NOTHING. Driven end to end here: the real cron,
 * then the real routes, on a real migrated SQLite.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { runDueCheckins } from '../checkins-cron.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const TZ = 'America/New_York';
// 11:00 in New York — the check-ins below are due at 10:30 local, today.
const NOW = '2026-10-05T15:00:00.000Z';
const DUE = '2026-10-05T14:30:00.000Z';

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  // VAPID configured, so the skip reason is the person's: no subscription.
  return {
    DB, KV_CACHE: makeKV(), BUILD_SHA: 'abc1234',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv',
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
async function guestWord(env, word) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await g.json();
  const c = await call(env, 'POST', '/api/commitments', {
    cookie, body: { title: 'stretch', start_at: DUE, checkin_at: DUE, persona: 'ally', timezone: TZ, ...word },
  });
  expect(c.status).toBe(201);
  return { cookie, userId, id: c.body.commitment.id };
}
const rows = (env, id) => env.DB.sqlite.prepare(
  'SELECT id, status, scheduled_for, last_error FROM commitment_checkins WHERE commitment_id = ? ORDER BY scheduled_for',
).all(id);
const kept = (env, userId) => (env.DB.sqlite.prepare(
  'SELECT total_kept FROM accountability_streaks WHERE user_id = ?',
).get(userId) || { total_kept: 0 }).total_kept;
const at = (iso) => vi.setSystemTime(new Date(iso));

suite('FBQ-01: an unreachable check-in can be answered', () => {
  afterEach(() => vi.useRealTimers());

  it('no push subscription: the cron skips it, "I did it" records it once, a double tap writes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const { cookie, userId, id } = await guestWord(env, { recurrence: 'daily' });
    await runDueCheckins(env);
    const [today, tomorrow] = rows(env, id);
    expect(today).toMatchObject({ status: 'skipped', last_error: 'no_subscription' });
    expect(tomorrow.status).toBe('pending');

    const first = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(first.status).toBe(200);
    expect(first.body.recorded).toBe(true);
    expect(first.body.message).toBeTruthy();
    expect(rows(env, id)[0].status).toBe('kept');
    expect(kept(env, userId)).toBe(1);

    const second = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(second.status).toBe(200);
    expect(second.body.recorded).toBe(false);
    expect(kept(env, userId)).toBe(1);
    expect(rows(env, id)[1]).toMatchObject({ status: 'pending', scheduled_for: tomorrow.scheduled_for });
  });

  it('a stale skip stays unanswerable: nothing written', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-06T16:00:00.000Z'); // 25.5h after DUE → the cron retires it `stale`
    const env = makeEnv();
    const { cookie, userId, id } = await guestWord(env, {});
    await runDueCheckins(env);
    expect(rows(env, id)[0]).toMatchObject({ status: 'skipped', last_error: 'stale' });
    const r = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(false);
    expect(rows(env, id)[0].status).toBe('skipped');
    expect(kept(env, userId)).toBe(0);
  });

  it('a recurring word never credits an earlier day\'s skip; a one-shot can be answered the next morning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const daily = await guestWord(env, { recurrence: 'daily' });
    const once = await guestWord(env, {});
    await runDueCheckins(env);
    at('2026-10-06T13:00:00.000Z'); // 09:00 the next local day
    const r1 = await call(env, 'POST', `/api/commitments/${daily.id}/checkin`, { cookie: daily.cookie, body: { outcome: 'kept' } });
    expect(r1.body.recorded).toBe(true);
    const [yesterday, today] = rows(env, daily.id);
    expect(yesterday).toMatchObject({ status: 'skipped', last_error: 'no_subscription' });
    expect(today.status).toBe('kept'); // today's early "did it", as before — never yesterday's skip
    const r2 = await call(env, 'POST', `/api/commitments/${once.id}/checkin`, { cookie: once.cookie, body: { outcome: 'kept' } });
    expect(r2.body.recorded).toBe(true);
    expect(rows(env, once.id)[0].status).toBe('kept');
    const r3 = await call(env, 'POST', `/api/commitments/${once.id}/checkin`, { cookie: once.cookie, body: { outcome: 'kept' } });
    expect(r3.body.recorded).toBe(false);
    expect(kept(env, once.userId)).toBe(1);
  });

  it('a free text word with no push: skipped text_is_pro_*, shown on the list, answerable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const { cookie, userId, id } = await guestWord(env, { channel: 'text' });
    await runDueCheckins(env);
    expect(rows(env, id)[0]).toMatchObject({ status: 'skipped', last_error: 'text_is_pro_no_subscription' });
    const list = await call(env, 'GET', '/api/commitments', { cookie });
    expect(list.body.commitments.find((c) => c.id === id).next_checkin).toBe(DUE);
    const r = await call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } });
    expect(r.body.recorded).toBe(true);
    expect(kept(env, userId)).toBe(1);
  });

  it('snooze re-arms today\'s unreachable check-in and never pulls tomorrow\'s into today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const { cookie, id } = await guestWord(env, { recurrence: 'daily' });
    await runDueCheckins(env);
    const [today, tomorrow] = rows(env, id);
    const s = await call(env, 'POST', `/api/commitments/${id}/snooze`, { cookie, body: { minutes: 15 } });
    expect(s.status).toBe(200);
    const after = rows(env, id);
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === tomorrow.id)).toMatchObject({ status: 'pending', scheduled_for: tomorrow.scheduled_for });
    expect(after.find((r) => r.id === today.id)).toMatchObject({ status: 'pending', scheduled_for: s.body.snoozed_until });
  });
});
