/**
 * FBQ-19 (P2) — the settled-word edges, each driven on a real migrated SQLite.
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

const word = (env, id) => env.DB.sqlite.prepare('SELECT status FROM commitments WHERE id = ?').get(id).status;
const successors = (env, id) => env.DB.sqlite.prepare(
  'SELECT id, title, status FROM commitments WHERE rescheduled_from = ?',
).all(id);
const checkin = (env, cookie, id, body) => call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body });

suite('FBQ-19: settled-word edges', () => {
  afterEach(() => vi.useRealTimers());

  it('1. a stranded one-shot stays active and answerable on return (no dead "Moved" word)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const { cookie, userId, id } = await guestWord(env, {});
    env.DB.sqlite.prepare(
      `UPDATE commitment_checkins SET status = 'sent', channel = 'push',
              delivered_at = '2026-10-05T10:00:00.000Z', escalated_at = '2026-10-05T11:00:00.000Z'
        WHERE commitment_id = ?`,
    ).run(id);
    const list = await call(env, 'GET', '/api/commitments', { cookie });
    expect(list.body.commitments.find((c) => c.id === id).status).toBe('active');
    expect(word(env, id)).toBe('active');
    expect(successors(env, id)).toHaveLength(0);
    const r = await checkin(env, cookie, id, { outcome: 'kept' });
    expect(r.body.recorded).toBe(true);
    expect(word(env, id)).toBe('kept');
    expect(kept(env, userId)).toBe(1);
    const again = await checkin(env, cookie, id, { outcome: 'kept' });
    expect(again.body.recorded).toBe(false);
    expect(kept(env, userId)).toBe(1);
  });

  it('2. "try again" on a settled-missed one-shot makes a new word and leaves history alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const { cookie, userId, id } = await guestWord(env, {});
    env.DB.sqlite.prepare("UPDATE commitments SET status = 'missed' WHERE id = ?").run(id);
    env.DB.sqlite.prepare("UPDATE commitment_checkins SET status = 'missed' WHERE commitment_id = ?").run(id);
    const bad = await checkin(env, cookie, id, { outcome: 'reschedule', when_text: 'whenever, ish' });
    expect(bad.status).toBe(400);
    expect(successors(env, id)).toHaveLength(0);
    const r = await checkin(env, cookie, id, { outcome: 'reschedule', when_text: 'tomorrow 9am' });
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(true);
    expect(r.body.new_commitment).toMatchObject({ title: 'stretch', status: 'active' });
    expect(word(env, id)).toBe('missed');
    expect(rows(env, id)[0].status).toBe('missed');
    const next = successors(env, id);
    expect(next).toHaveLength(1);
    expect(rows(env, next[0].id).map((x) => x.status)).toEqual(['pending']);
    expect(kept(env, userId)).toBe(0);
    const dup = await checkin(env, cookie, id, { outcome: 'reschedule', when_text: 'tomorrow 9am' });
    expect(dup.body.recorded).toBe(false);
    expect(successors(env, id)).toHaveLength(1);
  });

  it('3. "I did it" on a one-shot due tomorrow is recorded once and the word stops ringing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const tomorrow = '2026-10-07T14:30:00.000Z';
    const { cookie, userId, id } = await guestWord(env, { start_at: tomorrow, checkin_at: tomorrow });
    expect(rows(env, id)[0]).toMatchObject({ status: 'pending', scheduled_for: tomorrow });
    const r = await checkin(env, cookie, id, { outcome: 'kept' });
    expect(r.body.recorded).toBe(true);
    expect(word(env, id)).toBe('kept');
    expect(rows(env, id)[0].status).toBe('kept');
    expect(kept(env, userId)).toBe(1);
    const again = await checkin(env, cookie, id, { outcome: 'kept' });
    expect(again.body.recorded).toBe(false);
    expect(kept(env, userId)).toBe(1);
    at('2026-10-07T15:00:00.000Z');
    await runDueCheckins(env);
    expect(rows(env, id)[0].status).toBe('kept');
  });

  it('3b. a RECURRING word still never credits tomorrow\'s row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const tomorrow = '2026-10-07T14:30:00.000Z';
    const { cookie, userId, id } = await guestWord(env, { recurrence: 'daily', start_at: tomorrow, checkin_at: tomorrow });
    const r = await checkin(env, cookie, id, { outcome: 'kept' });
    expect(r.body.recorded).toBe(false);
    expect(kept(env, userId)).toBe(0);
  });

  it('4. release never overwrites a kept word, and a second release is a no-op', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const { cookie, id } = await guestWord(env, {});
    await checkin(env, cookie, id, { outcome: 'kept' });
    const r = await call(env, 'POST', `/api/commitments/${id}/release`, { cookie, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.commitment.status).toBe('kept');
    expect(word(env, id)).toBe('kept');
    const other = await guestWord(env, {});
    await call(env, 'POST', `/api/commitments/${other.id}/release`, { cookie: other.cookie, body: {} });
    const twice = await call(env, 'POST', `/api/commitments/${other.id}/release`, { cookie: other.cookie, body: {} });
    expect(twice.body.commitment.status).toBe('released');
    expect(word(env, other.id)).toBe('released');
  });

  it('5. a text word with an unverified number and no push stays on the list and answerable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    const env = makeEnv();
    const { cookie, userId, id } = await guestWord(env, { channel: 'text' });
    env.DB.sqlite.prepare(
      `INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES ('pp', ?, 'cs_1', 'paid', ?)`,
    ).run(userId, NOW);
    await runDueCheckins(env);
    expect(rows(env, id)[0]).toMatchObject({ status: 'skipped', last_error: 'phone_unverified_no_subscription' });
    const list = await call(env, 'GET', '/api/commitments', { cookie });
    expect(list.body.commitments.find((c) => c.id === id).next_checkin).toBe(DUE);
    const r = await checkin(env, cookie, id, { outcome: 'kept' });
    expect(r.body.recorded).toBe(true);
  });
});
