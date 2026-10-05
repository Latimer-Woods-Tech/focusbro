/**
 * FBQ-02 (P1) — an answer binds to the exact occurrence it was offered for.
 *
 * The web push ticket and the native notification's "I did it" both resolved
 * the word's SOONEST DUE open row, not the occurrence they were offered for. So
 * yesterday's already-answered ticket (72 h TTL, replayable) credited TODAY's
 * undelivered row and swallowed today's nudge, and `missed` through a ticket
 * reset the streak; a pre-scheduled native notification tapped a day late did
 * the same. Driven end to end on a real migrated SQLite, through the router.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { runDueCheckins } from '../checkins-cron.js';
import { signReplyTicket } from '../checkin-reply.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const TZ = 'America/New_York';
// Monday 11:00 New York; the daily word is due at 10:30 local.
const MON = '2026-10-05T15:00:00.000Z';
const DUE = '2026-10-05T14:30:00.000Z';
// Tuesday 09:00 New York — before Tuesday's 10:30 delivery.
const TUE_EARLY = '2026-10-06T13:00:00.000Z';

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
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
async function dailyWord(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await g.json();
  const c = await call(env, 'POST', '/api/commitments', {
    cookie, body: { title: 'stretch', start_at: DUE, checkin_at: DUE, persona: 'ally', timezone: TZ, recurrence: 'daily' },
  });
  expect(c.status).toBe(201);
  return { cookie, userId, id: c.body.commitment.id };
}
const rows = (env, id) => env.DB.sqlite.prepare(
  'SELECT id, status, scheduled_for, last_error FROM commitment_checkins WHERE commitment_id = ? ORDER BY scheduled_for',
).all(id);
const streak = (env, userId) => env.DB.sqlite.prepare(
  'SELECT current_streak, total_kept FROM accountability_streaks WHERE user_id = ?',
).get(userId) || { current_streak: 0, total_kept: 0 };
const markSent = (env, checkinId) => env.DB.sqlite.prepare(
  "UPDATE commitment_checkins SET status = 'sent', delivered_at = datetime('now') WHERE id = ?",
).run(checkinId);
const at = (iso) => vi.setSystemTime(new Date(iso));
const reply = (env, body) => call(env, 'POST', '/api/checkins/reply', { body });
const answer = (env, w, body) => call(env, 'POST', `/api/commitments/${w.id}/checkin`, { cookie: w.cookie, body });

/** Monday's row delivered and answered; Tuesday's row materialized `pending`. */
async function mondayKept(env) {
  const w = await dailyWord(env);
  const [mon] = rows(env, w.id);
  markSent(env, mon.id);
  const ticket = await signReplyTicket(env.JWT_SECRET, mon.id);
  const r = await answer(env, w, { outcome: 'kept' });
  expect(r.body.recorded).toBe(true);
  const [, tue] = rows(env, w.id);
  expect(tue).toMatchObject({ status: 'pending' });
  return { w, mon, tue, ticket };
}

suite('FBQ-02: a ticket answers only its own occurrence', () => {
  afterEach(() => vi.useRealTimers());

  it("yesterday's ticket against today's pending row writes nothing (recorded:false)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const { w, tue, ticket } = await mondayKept(env);
    at(TUE_EARLY);
    const r = await reply(env, { ticket, outcome: 'kept' });
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(false);
    expect(rows(env, w.id)[1]).toMatchObject({ id: tue.id, status: 'pending', scheduled_for: tue.scheduled_for });
    expect(streak(env, w.userId).total_kept).toBe(1);
  });

  it('a replayed ticket writes nothing, the same day or the next', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const w = await dailyWord(env);
    const [mon] = rows(env, w.id);
    markSent(env, mon.id);
    const ticket = await signReplyTicket(env.JWT_SECRET, mon.id);
    const first = await reply(env, { ticket, outcome: 'kept' });
    expect(first.body.recorded).toBe(true);
    for (const when of [MON, TUE_EARLY, '2026-10-07T13:00:00.000Z']) {
      at(when);
      const again = await reply(env, { ticket, outcome: 'kept' });
      expect(again.status, when).toBe(200);
      expect(again.body.recorded, when).toBe(false);
    }
    expect(rows(env, w.id).filter((r) => r.status === 'kept')).toHaveLength(1);
    expect(streak(env, w.userId).total_kept).toBe(1);
  });

  it('`missed` through a ticket is a 400 and leaves the streak and the row alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const { w, tue } = await mondayKept(env);
    expect(streak(env, w.userId).current_streak).toBe(1);
    at('2026-10-06T15:00:00.000Z');
    markSent(env, tue.id);
    const ticket = await signReplyTicket(env.JWT_SECRET, tue.id);
    const r = await reply(env, { ticket, outcome: 'missed' });
    expect(r.status).toBe(400);
    expect(streak(env, w.userId)).toEqual({ current_streak: 1, total_kept: 1 });
    expect(rows(env, w.id)[1]).toMatchObject({ id: tue.id, status: 'sent' });
  });

  it('a valid ticket for its own open row keeps it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const w = await dailyWord(env);
    const [mon] = rows(env, w.id);
    markSent(env, mon.id);
    const r = await reply(env, { ticket: await signReplyTicket(env.JWT_SECRET, mon.id), outcome: 'kept' });
    expect(r.body.recorded).toBe(true);
    expect(rows(env, w.id)[0]).toMatchObject({ id: mon.id, status: 'kept' });
    expect(streak(env, w.userId).total_kept).toBe(1);
  });

  it('a ticket for its own unreachable-skipped row keeps it (FBQ-01 open definition)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const w = await dailyWord(env);
    await runDueCheckins(env);
    const [mon, tue] = rows(env, w.id);
    expect(mon).toMatchObject({ status: 'skipped', last_error: 'no_subscription' });
    const r = await reply(env, { ticket: await signReplyTicket(env.JWT_SECRET, mon.id), outcome: 'kept' });
    expect(r.body.recorded).toBe(true);
    expect(rows(env, w.id)[0].status).toBe('kept');
    expect(rows(env, w.id)[1]).toMatchObject({ id: tue.id, status: 'pending' });
  });
});

suite('FBQ-02: the native answer binds to its occurrence', () => {
  afterEach(() => vi.useRealTimers());

  it('checkin_id of an earlier, settled occurrence writes nothing and leaves today untouched', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const { w, mon, tue } = await mondayKept(env);
    at(TUE_EARLY);
    const r = await answer(env, w, { outcome: 'kept', checkin_id: mon.id });
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(false);
    expect(r.body.message).toBeTruthy();
    expect(rows(env, w.id)[1]).toMatchObject({ id: tue.id, status: 'pending', scheduled_for: tue.scheduled_for });
    expect(streak(env, w.userId).total_kept).toBe(1);
  });

  it('checkin_id of its own row keeps exactly that row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const { w, tue } = await mondayKept(env);
    at(TUE_EARLY);
    const r = await answer(env, w, { outcome: 'kept', checkin_id: tue.id });
    expect(r.body.recorded).toBe(true);
    expect(rows(env, w.id)[1]).toMatchObject({ id: tue.id, status: 'kept' });
    expect(streak(env, w.userId).total_kept).toBe(2);
  });

  it("checkin_id of another word's row writes nothing on either word", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const a = await mondayKept(env);
    const other = await call(env, 'POST', '/api/commitments', {
      cookie: a.w.cookie, body: { title: 'read', start_at: DUE, checkin_at: DUE, persona: 'ally', timezone: TZ, recurrence: 'daily' },
    });
    const [otherRow] = rows(env, other.body.commitment.id);
    at(TUE_EARLY);
    const r = await answer(env, a.w, { outcome: 'kept', checkin_id: otherRow.id });
    expect(r.body.recorded).toBe(false);
    expect(rows(env, a.w.id)[1].status).toBe('pending');
    expect(rows(env, other.body.commitment.id)[0].status).toBe('pending');
  });

  it("occurrence_at of Monday's notification tapped Tuesday writes nothing; Tuesday's own keeps Tuesday", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const { w, mon, tue } = await mondayKept(env);
    at(TUE_EARLY);
    const stale = await answer(env, w, { outcome: 'kept', occurrence_at: mon.scheduled_for });
    expect(stale.body.recorded).toBe(false);
    expect(rows(env, w.id)[1].status).toBe('pending');
    const own = await answer(env, w, { outcome: 'kept', occurrence_at: tue.scheduled_for });
    expect(own.body.recorded).toBe(true);
    expect(rows(env, w.id)[1]).toMatchObject({ id: tue.id, status: 'kept' });
  });

  it('without checkin_id the answer keeps its existing behaviour (older app builds, the /me/ card)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const { w, tue } = await mondayKept(env);
    at(TUE_EARLY);
    const r = await answer(env, w, { outcome: 'kept' });
    expect(r.body.recorded).toBe(true);
    expect(rows(env, w.id)[1]).toMatchObject({ id: tue.id, status: 'kept' });
  });

  it('a malformed checkin_id or occurrence_at is a 400 and writes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const w = await dailyWord(env);
    for (const bad of [{ checkin_id: 42 }, { checkin_id: '' }, { occurrence_at: 'not a date' }]) {
      const r = await answer(env, w, { outcome: 'kept', ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(rows(env, w.id)[0].status).toBe('pending');
  });

  it('the list exposes the id of each word\'s next check-in, for the notification to carry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON);
    const env = makeEnv();
    const { w, tue } = await mondayKept(env);
    const list = await call(env, 'GET', '/api/commitments', { cookie: w.cookie });
    const c = list.body.commitments.find((x) => x.id === w.id);
    expect(c).toMatchObject({ next_checkin: tue.scheduled_for, next_checkin_id: tue.id });
  });
});
