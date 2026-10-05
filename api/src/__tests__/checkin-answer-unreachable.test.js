/**
 * The "still here" door for an UNREACHABLE check-in must open.
 *
 * Found on the Android emulator (G795 proof run, 2026-10-05): an app user has
 * no web-push subscription, so the cron parks every check-in `skipped`
 * (`no_subscription`) while the phone shows it as a LOCAL notification. GET
 * /api/commitments surfaces that row as "still here whenever you're ready" —
 * but "I did it", on the notification AND on the card, answered "got this one
 * already" and wrote nothing. No Android-app user could keep a word.
 *
 * Proven on a real migrated SQLite, end to end through the router.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return { DB, KV_CACHE: makeKV(), JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789', BUILD_SHA: 'abc1234' };
}
function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = ORIGIN; }
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

// A guest's word whose only check-in the cron has already parked `skipped`.
async function wordSkipped(env, reason, { recurrence } = {}) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const body = { title: 'walk the dog', start_at: '2099-01-01T15:00:00.000Z', persona: 'ally', channel: 'push' };
  if (recurrence) Object.assign(body, { recurrence, local_time: '09:00', timezone: 'UTC' });
  const c = await worker.fetch(req('POST', '/api/commitments', { cookie, body }), env, ctx);
  expect(c.status).toBe(201);
  const j = await c.json();
  const commitmentId = (j.commitment || j).id;
  const row = env.DB.sqlite.prepare('SELECT id, user_id FROM commitment_checkins WHERE commitment_id = ? LIMIT 1').get(commitmentId);
  env.DB.sqlite.prepare("UPDATE commitment_checkins SET status = 'skipped', last_error = ?, scheduled_for = ? WHERE id = ?")
    .run(reason, iso(Date.now() - HOUR), row.id);
  return { cookie, commitmentId, checkinId: row.id, userId: row.user_id };
}
const answer = (env, cookie, id, outcome) =>
  worker.fetch(req('POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome } }), env, ctx);
const checkin = (env, id) => env.DB.sqlite.prepare('SELECT status FROM commitment_checkins WHERE id = ?').get(id);
const word = (env, id) => env.DB.sqlite.prepare('SELECT status FROM commitments WHERE id = ?').get(id);
const kept = (env) => (env.DB.sqlite.prepare('SELECT total_kept FROM accountability_streaks').get() || { total_kept: 0 }).total_kept;

suite('answering a check-in the cron could not deliver', () => {
  it('the list shows the door, and "I did it" keeps the word (the Android-app case)', async () => {
    const env = makeEnv();
    const { cookie, commitmentId, checkinId } = await wordSkipped(env, 'no_subscription');

    const list = await (await worker.fetch(req('GET', '/api/commitments', { cookie }), env, ctx)).json();
    expect(list.commitments.find((c) => c.id === commitmentId).next_checkin, 'the door is shown').toBeTruthy();

    const r = await answer(env, cookie, commitmentId, 'kept');
    expect(r.status).toBe(200);
    expect(checkin(env, checkinId).status).toBe('kept');
    expect(word(env, commitmentId).status).toBe('kept');
    expect(kept(env)).toBe(1);
  });

  it('every unreachable reason opens, and "Not yet" is honoured too', async () => {
    for (const reason of ['push_not_configured', 'no_phone', 'text_not_configured']) {
      const env = makeEnv();
      const { cookie, commitmentId, checkinId } = await wordSkipped(env, reason);
      expect((await answer(env, cookie, commitmentId, 'kept')).status, reason).toBe(200);
      expect(checkin(env, checkinId).status, reason).toBe('kept');
    }
    const env = makeEnv();
    const { cookie, commitmentId, checkinId } = await wordSkipped(env, 'no_subscription');
    expect((await answer(env, cookie, commitmentId, 'missed')).status).toBe(200);
    expect(checkin(env, checkinId).status).toBe('missed');
    expect(kept(env)).toBe(0);
  });

  it('a `stale` skip stays closed — it aged out on purpose (proof of rejection)', async () => {
    const env = makeEnv();
    const { cookie, commitmentId, checkinId } = await wordSkipped(env, 'stale');
    expect((await answer(env, cookie, commitmentId, 'kept')).status).toBe(200);
    expect(checkin(env, checkinId).status).toBe('skipped');
    expect(word(env, commitmentId).status).toBe('active');
    expect(kept(env)).toBe(0);
  });

  it('a delivered check-in still wins over an unreachable one', async () => {
    const env = makeEnv();
    const { cookie, commitmentId, checkinId: skippedId, userId } = await wordSkipped(env, 'no_subscription');
    env.DB.sqlite.prepare(
      `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
       VALUES ('ci-sent', ?, ?, ?, 'push', 'sent')`
    ).run(commitmentId, userId, iso(Date.now() - 2 * HOUR));
    expect((await answer(env, cookie, commitmentId, 'kept')).status).toBe(200);
    expect(checkin(env, 'ci-sent').status).toBe('kept');
    expect(checkin(env, skippedId).status).toBe('skipped');
  });

  it('a recurring word credits the MOST RECENT unreachable day, never an old one or tomorrow', async () => {
    const env = makeEnv();
    const { cookie, commitmentId, checkinId: todayId, userId } = await wordSkipped(env, 'no_subscription', { recurrence: 'daily' });
    const add = (id, at, status, err) => env.DB.sqlite.prepare(
      `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, last_error)
       VALUES (?, ?, ?, ?, 'push', ?, ?)`
    ).run(id, commitmentId, userId, iso(at), status, err);
    add('ci-yesterday', Date.now() - 25 * HOUR, 'skipped', 'no_subscription');
    add('ci-tomorrow', Date.now() + 47 * HOUR, 'pending', null);

    expect((await answer(env, cookie, commitmentId, 'kept')).status).toBe(200);
    expect(checkin(env, todayId).status).toBe('kept');
    expect(checkin(env, 'ci-yesterday').status).toBe('skipped');
    expect(checkin(env, 'ci-tomorrow').status).toBe('pending');
  });
});
