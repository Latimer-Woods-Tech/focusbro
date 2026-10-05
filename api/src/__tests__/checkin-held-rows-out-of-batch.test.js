/**
 * FBQ-06 (P1) — a check-in held back does not occupy the delivery batch.
 *
 * The cron scanned `status='pending' AND scheduled_for <= now ORDER BY
 * scheduled_for LIMIT 100`. A row held for quiet hours or by the late-text night
 * guard `continue`d without any write, so it kept its old scheduled_for, sorted
 * first on every tick, and cost 2–3 D1 queries each time. 105 held text rows
 * starved one due push for the whole quiet window (10 hours in QA).
 *
 * The fix: a held row gets `next_attempt_at` (the instant the hold ends) and the
 * scan skips it until then. Driven on a real migrated SQLite; only the push and
 * Telnyx wires are intercepted.
 */
import { describe, it, expect, vi, afterEach, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const push = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../webpush.js', async (importOriginal) => ({
  ...(await importOriginal()),
  vapidConfigured: () => true,
  sendWebPush: async () => { push.calls++; return { ok: true }; },
}));

// FBQ-24 R4: under `--no-isolate` the module registry is shared across files, so
// index.js / checkins-cron.js may already be cached bound to the REAL webpush.js
// (or another file's mock). Drop the cache so the imports below are evaluated
// afresh against the mock above, and do not leave this mock behind afterwards.
vi.resetModules();
const { runDueCheckins, MAX_CHECKIN_LATENESS_MIN } = await import('../checkins-cron.js');
const { rependCheckin } = await import('../accountability.js');
const { nextInstantWhere, isWithinQuietHours } = await import('../consent.js');
const worker = (await import('../index.js')).default;

afterAll(() => {
  vi.doUnmock('../webpush.js');
  vi.resetModules();
});

const suite = DatabaseSync ? describe : describe.skip;
const TZ = 'America/New_York';
const ORIGIN = 'https://focusbro.net';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const RUNTIME_CREATES = [...readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)].map((m) => m[1]);
const NOW = '2026-10-05T15:00:00.000Z'; // 11:00 New York
const DUE = '2026-10-05T14:30:00.000Z'; // 10:30 New York
const QUIET_END = '2026-10-05T17:00:00.000Z'; // quiet 10→13 New York ends at 13:00 = 17:00Z
const at = (iso, min) => new Date(Date.parse(iso) + min * 60 * 1000).toISOString();

function makeEnv() {
  return {
    DB: makeMigratedD1(), KV_CACHE: makeKV(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
    VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv',
    TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+15550001111',
  };
}
function user(env, id, { phone = null } = {}) {
  env.DB.sqlite.prepare(`INSERT INTO users (id, email, password_hash, phone) VALUES (?, ?, 'x', ?)`)
    .run(id, `${id}@example.test`, phone);
  env.DB.sqlite.prepare(`UPDATE users SET phone_verified_at = datetime('now') WHERE id = ? AND phone IS NOT NULL`).run(id); // FBQ-12: verified fixture
}
/** A Pro user who texts, with granted consent and the given quiet window. */
function texter(env, id, { qs = 10, qe = 13 } = {}) {
  user(env, id, { phone: '+15550002222' });
  const s = env.DB.sqlite;
  s.prepare(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES (?, ?, ?, 'paid', ?)`)
    .run(`pp-${id}`, id, `cs-${id}`, NOW);
  s.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, quiet_start, quiet_end, timezone)
             VALUES (?, ?, 'text', 'granted', ?, ?, ?)`).run(`cc-${id}`, id, qs, qe, TZ);
}
function word(env, userId, key, { channel = 'push', scheduledFor = DUE } = {}) {
  const s = env.DB.sqlite;
  s.prepare(`INSERT INTO commitments (id, user_id, title, start_at, checkin_at, channel, timezone)
             VALUES (?, ?, 'stretch', ?, ?, ?, ?)`).run(`w-${key}`, userId, scheduledFor, scheduledFor, channel, TZ);
  s.prepare(`INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`).run(`c-${key}`, `w-${key}`, userId, scheduledFor, channel);
  return `c-${key}`;
}
function pusher(env, id) {
  user(env, id);
  env.DB.sqlite.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, is_active)
                         VALUES (?, ?, ?, 'p', 'a', 1)`).run(`sub-${id}`, id, `https://fcm.googleapis.com/fcm/send/${id}`);
}
const get = (env, id) => env.DB.sqlite.prepare(
  'SELECT status, next_attempt_at, last_error, attempts FROM commitment_checkins WHERE id = ?',
).get(id);
/** Count every D1 statement a tick prepares. */
function counting(env) {
  const n = { calls: 0 };
  const prepare = env.DB.prepare.bind(env.DB);
  return { n, env: { ...env, DB: { ...env.DB, prepare: (sql) => { n.calls++; return prepare(sql); } } } };
}
/** 105 quiet-hours-held text rows, all scheduled before one due push row. */
function starvationFixture(env) {
  texter(env, 'texter');
  for (let i = 0; i < 105; i++) word(env, 'texter', `t${i}`, { channel: 'text', scheduledFor: at(DUE, -60 + i * 0.1) });
  pusher(env, 'pusher');
  return word(env, 'pusher', 'p', { scheduledFor: DUE });
}

describe('nextInstantWhere: the exact end of an hour-based hold', () => {
  it('finds a half-hour-offset boundary (Asia/Kolkata quiet 22→7 ends 01:30Z)', () => {
    const until = nextInstantWhere('2026-10-05T20:00:00.000Z', (iso) => !isWithinQuietHours(iso, 'Asia/Kolkata', 22, 7));
    expect(until).toBe('2026-10-06T01:30:00.000Z');
  });
  it('is null when the hold never ends within a day', () => {
    expect(nextInstantWhere(NOW, () => false)).toBe(null);
    expect(nextInstantWhere('not a date', () => true)).toBe(null);
  });
});

suite('FBQ-06: a held check-in does not occupy the batch', () => {
  let fetchSpy;
  beforeEach(() => {
    push.calls = 0;
    fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('105 held text rows plus 1 due push: the push is sent on the first tick', async () => {
    const env = makeEnv();
    const pushRow = starvationFixture(env);
    const sum = await runDueCheckins(env, { now: NOW });
    expect(push.calls).toBe(1);
    expect(sum.sent).toBe(1);
    expect(sum.deferred).toBe(105);
    expect(get(env, pushRow).status).toBe('sent');
    expect(fetchSpy).not.toHaveBeenCalled(); // no text went out inside quiet hours
    // Every held row carries its hold end and stays pending, unclaimed.
    expect(env.DB.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM commitment_checkins WHERE user_id = 'texter' AND status = 'pending' AND next_attempt_at = ?`,
    ).get(QUIET_END).n).toBe(105);
  });

  it('the scan\'s D1 call count does not grow with held rows', async () => {
    const lone = makeEnv();
    pusher(lone, 'pusher');
    word(lone, 'pusher', 'p', { scheduledFor: at(NOW, 1) });
    const crowded = makeEnv();
    starvationFixture(crowded);
    word(crowded, 'pusher', 'p2', { scheduledFor: at(NOW, 1) });
    await runDueCheckins(crowded, { now: NOW }); // holds the 105, sends the first push

    const a = counting(lone);
    const b = counting(crowded);
    const sa = await runDueCheckins(a.env, { now: at(NOW, 2) });
    const sb = await runDueCheckins(b.env, { now: at(NOW, 2) });
    expect(sa.sent).toBe(1);
    expect(sb.sent).toBe(1);
    expect(sb.scanned).toBe(1); // the held rows are not even read
    expect(b.n.calls).toBe(a.n.calls);
  });

  it('a held row is not touched before its hold ends, and is sent at the hold end', async () => {
    const env = makeEnv();
    texter(env, 'texter');
    const id = word(env, 'texter', 't', { channel: 'text' });
    expect((await runDueCheckins(env, { now: NOW })).deferred).toBe(1);
    expect(get(env, id)).toMatchObject({ status: 'pending', next_attempt_at: QUIET_END, attempts: 0 });

    const before = await runDueCheckins(env, { now: at(QUIET_END, -1) });
    expect(before).toMatchObject({ scanned: 0, deferred: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const s = await runDueCheckins(env, { now: QUIET_END });
    expect(s.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(get(env, id).status).toBe('sent');
  });

  it('a night-guard hold ends at the morning floor (08:00 local)', async () => {
    const env = makeEnv();
    texter(env, 'texter', { qs: null, qe: null });
    const id = word(env, 'texter', 't', { channel: 'text' }); // 10:30 New York: daytime
    const night = '2026-10-06T07:00:00.000Z'; // 03:00 New York the next day
    expect((await runDueCheckins(env, { now: night })).deferred).toBe(1);
    expect(get(env, id).next_attempt_at).toBe('2026-10-06T12:00:00.000Z'); // 08:00 New York
    expect((await runDueCheckins(env, { now: '2026-10-06T11:59:00.000Z' })).scanned).toBe(0);
    expect((await runDueCheckins(env, { now: '2026-10-06T12:00:00.000Z' })).sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a held row that is past the stale cutoff when its hold ends is retired, not sent late', async () => {
    const env = makeEnv();
    texter(env, 'texter');
    // Scheduled 23h before NOW: inside the window now, stale (26h) by 13:00.
    const id = word(env, 'texter', 't', { channel: 'text', scheduledFor: at(NOW, -23 * 60) });
    expect((await runDueCheckins(env, { now: NOW })).deferred).toBe(1);
    expect(Date.parse(QUIET_END) - Date.parse(at(NOW, -23 * 60))).toBeGreaterThan(MAX_CHECKIN_LATENESS_MIN * 60 * 1000);
    const s = await runDueCheckins(env, { now: QUIET_END });
    expect(s.stale).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(get(env, id)).toMatchObject({ status: 'skipped', last_error: 'stale' });
  });

  it('a re-pended row loses its hold (snooze / reply reschedule, and the lease sweep)', async () => {
    const env = makeEnv();
    texter(env, 'texter');
    const id = word(env, 'texter', 't', { channel: 'text' });
    await runDueCheckins(env, { now: NOW });
    expect(get(env, id).next_attempt_at).toBe(QUIET_END);
    expect(await rependCheckin(env, { checkinId: id, userId: 'texter', scheduledFor: at(NOW, 30) })).toBe('moved');
    expect(get(env, id)).toMatchObject({ status: 'pending', next_attempt_at: null });

    // A stale hold on a row stranded as 'sending' is cleared by the lease sweep.
    env.DB.sqlite.prepare(`UPDATE commitment_checkins SET status = 'sending', lease_until = ?, next_attempt_at = ?
                           WHERE id = ?`).run(at(NOW, -1), QUIET_END, id);
    await runDueCheckins(env, { now: NOW });
    expect(get(env, id).next_attempt_at).toBe(null);
  });

  it('saving new quiet hours releases the hold, so the new window applies on the next tick', async () => {
    const env = makeEnv();
    for (const sql of RUNTIME_CREATES) env.DB.sqlite.exec(sql);
    const g = await worker.fetch(new Request(`${ORIGIN}/auth/guest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}',
    }), env, ctx);
    const cookie = g.headers.get('Set-Cookie').split(';')[0];
    const { user_id: userId } = await g.json();
    const s = env.DB.sqlite;
    s.prepare(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status, paid_at) VALUES ('pp', ?, 'cs', 'paid', ?)`).run(userId, NOW);
    s.prepare(`INSERT INTO contact_consent (id, user_id, channel, status, quiet_start, quiet_end, timezone)
               VALUES ('cc', ?, 'text', 'granted', 10, 13, ?)`).run(userId, TZ);
    s.prepare(`UPDATE users SET phone = '+15550002222', phone_verified_at = datetime('now') WHERE id = ?`).run(userId);
    const id = word(env, userId, 't', { channel: 'text' });
    await runDueCheckins(env, { now: NOW });
    expect(get(env, id).next_attempt_at).toBe(QUIET_END);

    const res = await worker.fetch(new Request(`${ORIGIN}/api/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
      body: JSON.stringify({ channel: 'text', agree: true, phone: '+15550002222', quiet_start: 22, quiet_end: 7, timezone: TZ }),
    }), env, ctx);
    expect(res.status).toBe(200);
    expect(get(env, id)).toMatchObject({ status: 'pending', next_attempt_at: null });
    expect((await runDueCheckins(env, { now: at(NOW, 1) })).sent).toBe(1);
  });
});
