/**
 * FBQ-05 R4 (focusbro#391) — one OPEN occurrence per (word, instant).
 *
 * materializeNextOccurrence (cron) and ensureNextOccurrence (app) were
 * check-then-insert, so the cron and the app could both queue tomorrow's
 * occurrence: two nudges. Migration 0011 adds a unique index PARTIAL on
 * status IN ('pending','sending'); the inserts become ON CONFLICT DO NOTHING and
 * every re-pend goes through rependCheckin, which MERGES onto an existing open
 * occurrence instead of throwing inside the Telnyx webhook. Driven on a real
 * migrated SQLite.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'itty-router';
import worker from '../index.js';
import { materializeNextOccurrence } from '../checkins-cron.js';
import { registerConsentRoutes } from '../consent.js';
import { generateUUID } from '../middleware.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));
const TZ = 'America/New_York';
const NOW = '2026-10-05T15:00:00.000Z';      // 11:00 New York
const TODAY_9 = '2026-10-05T13:00:00.000Z';  // 09:00 New York, today (delivered)
const TMRW_9 = '2026-10-06T13:00:00.000Z';   // 09:00 New York, tomorrow
const PHONE = '+15551234567';

function makeEnv() {
  const DB = makeMigratedD1();
  for (const sql of RUNTIME_CREATES) DB.sqlite.exec(sql);
  return {
    DB, KV_CACHE: makeKV(), BUILD_SHA: 'abc1234',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111', TELNYX_PUBLIC_KEY: 'test',
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
/** A guest with a daily 09:00 New York word; its first row is tomorrow 09:00 pending. */
async function dailyWord(env) {
  const g = await worker.fetch(req('POST', '/auth/guest', { body: {} }), env, ctx);
  expect(g.status).toBe(201);
  const cookie = g.headers.get('Set-Cookie').split(';')[0];
  const { user_id: userId } = await g.json();
  const c = await call(env, 'POST', '/api/commitments', {
    cookie, body: { title: 'stretch', recurrence: 'daily', local_time: '09:00', timezone: TZ, persona: 'ally' },
  });
  expect(c.status).toBe(201);
  expect(c.body.commitment.checkin_at).toBe(TMRW_9);
  return { cookie, userId, id: c.body.commitment.id };
}
const rows = (env, id) => env.DB.sqlite.prepare(
  'SELECT id, scheduled_for, status, last_error FROM commitment_checkins WHERE commitment_id = ? ORDER BY rowid',
).all(id);
const open = (env, id) => rows(env, id).filter((r) => r.status === 'pending' || r.status === 'sending');
/** Today's 09:00 occurrence, already delivered (as the cron leaves it). */
const addDelivered = (env, id, userId, status = 'sent', channel = 'push') => env.DB.sqlite.prepare(
  `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, delivered_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(`today-${id}`, id, userId, TODAY_9, channel, status, TODAY_9);

suite('FBQ-05 R4: one open occurrence per word and instant', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('the cron and the app queueing tomorrow at once leave exactly one open row', async () => {
    const env = makeEnv();
    const { userId, id, cookie } = await dailyWord(env);
    env.DB.sqlite.prepare(`DELETE FROM commitment_checkins WHERE commitment_id = ?`).run(id);
    addDelivered(env, id, userId);
    const cronRow = {
      commitment_id: id, user_id: userId, recurrence: 'daily', timezone: TZ, local_time: '09:00',
      channel: 'push', commitment_status: 'active',
    };
    // Two overlapping ticks and the app's "I did it" (ensureNextOccurrence) race.
    const [a, b, answer] = await Promise.all([
      materializeNextOccurrence(env, cronRow, NOW),
      materializeNextOccurrence(env, cronRow, NOW),
      call(env, 'POST', `/api/commitments/${id}/checkin`, { cookie, body: { outcome: 'kept' } }),
    ]);
    expect(answer.status).toBe(200);
    expect([a, b].filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(open(env, id)).toEqual([expect.objectContaining({ scheduled_for: TMRW_9, status: 'pending' })]);
  });

  it('pause then resume restores exactly one open occurrence at tomorrow 09:00', async () => {
    const env = makeEnv();
    const { cookie, id } = await dailyWord(env);
    expect((await call(env, 'POST', `/api/commitments/${id}/pause`, { cookie, body: {} })).status).toBe(200);
    expect(open(env, id)).toEqual([]);
    const r = await call(env, 'POST', `/api/commitments/${id}/resume`, { cookie, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.next_checkin.scheduled_for).toBe(TMRW_9);
    // The cancelled row and the resumed row share the instant: a PLAIN unique
    // index would have dropped the resume. The partial one only sees the open row.
    expect(rows(env, id).map((x) => [x.scheduled_for, x.status])).toEqual([
      [TMRW_9, 'cancelled'], [TMRW_9, 'pending'],
    ]);
  });

  it.each([
    ['a fresh reply to the nudge', 'sent'],
    ['the answer to "when?"', 'awaiting_time'],
  ])('SMS "tomorrow 9am" on a daily 9am word (%s) → 200, one open row', async (_l, status) => {
    const env = makeEnv();
    const { userId, id } = await dailyWord(env);
    env.DB.sqlite.prepare(`UPDATE users SET phone = ?, phone_verified_at = datetime('now') WHERE id = ?`).run(PHONE, userId);
    env.DB.sqlite.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, phone) VALUES (?, ?, 'text', 'granted', ?)`).run(`cc-${userId}`, userId, PHONE); // FBQ-12: replies need granted consent
    env.DB.sqlite.prepare(`UPDATE commitments SET channel = 'text' WHERE id = ?`).run(id);
    addDelivered(env, id, userId, status, 'text');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const router = Router();
    registerConsentRoutes(router, {
      getAuthToken: () => null, verifyToken: async () => null, generateUUID,
      jsonResponse: (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }),
      verifyInboundSignature: async () => true,
    });
    const res = await router.fetch(new Request(`${ORIGIN}/api/webhooks/telnyx/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'telnyx-timestamp': '1785000000', 'telnyx-signature-ed25519': 'sig' },
      body: JSON.stringify({ data: { id: `evt-${status}`, event_type: 'message.received', payload: { from: { phone_number: PHONE }, text: 'tomorrow 9am' } } }),
    }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'rescheduled', scheduled_for: TMRW_9 });
    expect(open(env, id)).toEqual([expect.objectContaining({ scheduled_for: TMRW_9 })]);
    // History kept: the moved row is retired, not deleted.
    expect(rows(env, id).find((r) => r.id === `today-${id}`))
      .toMatchObject({ status: 'skipped', last_error: 'duplicate_occurrence' });
  });

  it('snooze onto an existing open occurrence → 200, one open row', async () => {
    const env = makeEnv();
    const { cookie, userId, id } = await dailyWord(env);
    addDelivered(env, id, userId);
    const at = new Date(Date.parse(NOW) + 15 * 60000).toISOString();
    env.DB.sqlite.prepare(`UPDATE commitment_checkins SET scheduled_for = ? WHERE commitment_id = ? AND status = 'pending'`).run(at, id);
    const r = await call(env, 'POST', `/api/commitments/${id}/snooze`, { cookie, body: { minutes: 15 } });
    expect(r.status).toBe(200);
    expect(open(env, id)).toEqual([expect.objectContaining({ scheduled_for: at })]);
  });

  it('"Move it → I\'m on it" onto an existing open occurrence → 200, one open row', async () => {
    const env = makeEnv();
    const { cookie, userId, id } = await dailyWord(env);
    addDelivered(env, id, userId);
    const at = new Date(Date.parse(NOW) + 15 * 60000).toISOString();
    env.DB.sqlite.prepare(`UPDATE commitment_checkins SET scheduled_for = ? WHERE commitment_id = ? AND status = 'pending'`).run(at, id);
    const r = await call(env, 'POST', `/api/commitments/${id}/checkin`, {
      cookie, body: { outcome: 'reschedule', when_text: "I'm on it, give me 15" },
    });
    expect(r.status).toBe(200);
    expect(r.body.action).toBe('snoozed');
    expect(open(env, id)).toEqual([expect.objectContaining({ scheduled_for: at })]);
  });

  it('an edit onto the instant of an in-flight (sending) occurrence → 200, one open row', async () => {
    const env = makeEnv();
    const { cookie, id } = await dailyWord(env);
    env.DB.sqlite.prepare(`UPDATE commitment_checkins SET status = 'sending' WHERE commitment_id = ?`).run(id);
    const r = await call(env, 'POST', `/api/commitments/${id}/edit`, { cookie, body: { local_time: '09:00' } });
    expect(r.status).toBe(200);
    expect(open(env, id)).toEqual([expect.objectContaining({ scheduled_for: TMRW_9, status: 'sending' })]);
  });
});

suite('migration 0011 over seeded open duplicates', () => {
  it('keeps the oldest open row, retires later twins, deletes nothing, then enforces', () => {
    const files = readdirSync(MIGRATIONS).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
    const target = '0011_checkin_open_occurrence_unique.sql';
    expect(files).toContain(target);
    const db = new DatabaseSync(':memory:');
    for (const f of files.filter((n) => n < target)) db.exec(readFileSync(`${MIGRATIONS}/${f}`, 'utf8'));
    db.exec(`INSERT INTO users (id, email, password_hash) VALUES ('u', 'u@x.test', 'h');
             INSERT INTO commitments (id, user_id, title, start_at) VALUES ('c', 'u', 't', '${TMRW_9}');`);
    const add = db.prepare(`INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, status) VALUES (?, 'c', 'u', ?, ?)`);
    add.run('a1', TMRW_9, 'pending');   // oldest open → stays
    add.run('a2', TMRW_9, 'pending');   // twin → retired
    add.run('a3', TMRW_9, 'sending');   // twin → retired
    add.run('h1', TMRW_9, 'cancelled'); // history at the same instant → untouched
    add.run('b1', TODAY_9, 'sent');
    add.run('b2', TODAY_9, 'pending');  // only open row at its instant → stays

    db.exec(readFileSync(`${MIGRATIONS}/${target}`, 'utf8'));

    const got = Object.fromEntries(db.prepare('SELECT id, status, last_error FROM commitment_checkins').all()
      .map((r) => [r.id, [r.status, r.last_error]]));
    expect(got).toEqual({
      a1: ['pending', null],
      a2: ['skipped', 'duplicate_occurrence'],
      a3: ['skipped', 'duplicate_occurrence'],
      h1: ['cancelled', null],
      b1: ['sent', null],
      b2: ['pending', null],
    });
    expect(() => add.run('a4', TMRW_9, 'pending')).toThrow(/UNIQUE/);
    expect(() => add.run('h2', TMRW_9, 'cancelled')).not.toThrow();
    // Re-running is a no-op (IF NOT EXISTS; nothing left to resolve).
    expect(() => db.exec(readFileSync(`${MIGRATIONS}/${target}`, 'utf8'))).not.toThrow();
  });
});
