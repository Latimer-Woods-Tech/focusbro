/**
 * FBQ-07b (focusbro#391) — people deferred at night are held out of the batch.
 * FBQ-07 leaves a night-deferred person unlatched (they must still be nudged
 * once it is day), so 50+ of them in one time zone sat at the head of the scan
 * and filled every batch until morning: a fresh daytime-eligible person in
 * another zone was never reached (the FBQ-06 shape). Real migrated SQLite.
 *
 * (original FBQ-07 header follows, kept for the helpers it documents)
 * FBQ-07 (focusbro#391) — the return nudge reaches newly dormant people, and the
 * scan stays cheap. Driven on a REAL SQLite built from migrations/ (real-d1.js),
 * so the SQL that runs here is the SQL production runs.
 *
 * What broke:
 *   - starvation: the scan took the 50 longest-dormant people and skipped the
 *     already-nudged ones in JavaScript, so 50 already-nudged people filled
 *     every batch forever and a newly dormant person was never reached;
 *   - format: the latch was ISO (`…T14:00:00.000Z`) and events are
 *     `datetime('now')` (`… 18:00:00`), so a return on the SAME UTC day read as
 *     "before the latch" and the next quiet spell got no nudge;
 *   - cost: a full GROUP BY over analytics_events with a correlated EXISTS per
 *     event row — quadratic in one person's events, run every minute;
 *   - deletion: `return_nudge_sent` carries the person's id in event_data with
 *     user_id NULL, so deleting the account left those rows behind.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runReturnNudges } from '../checkins-cron.js';
import { bytesToB64url, b64ToBytes } from '../webpush.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;

afterEach(() => vi.unstubAllGlobals());

async function vapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  return {
    env: { VAPID_PUBLIC_KEY: bytesToB64url(pubRaw), VAPID_PRIVATE_KEY: bytesToB64url(b64ToBytes(jwk.d)) },
    sub: { p256dh: bytesToB64url(uaRaw), auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

const ep = (id) => `https://fcm.googleapis.com/fcm/send/${id}`;

/** A person with a word on record, a push subscription, and a last event at `lastAt`. */
function seedPerson(sqlite, keys, id, lastAt, { push = true, tz = 'UTC' } = {}) {
  sqlite.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')`).run(id, `${id}@example.com`);
  sqlite.prepare(`INSERT INTO commitments (id, user_id, title, start_at, channel, timezone, status) VALUES (?, ?, 'stretch', '2026-06-20T15:00:00.000Z', 'push', ?, 'active')`).run(`cm-${id}`, id, tz);
  sqlite.prepare(`INSERT INTO analytics_events (user_id, event_type, created_at) VALUES (?, 'commitment_created', '2026-06-20 15:00:00')`).run(id);
  sqlite.prepare(`INSERT INTO analytics_events (user_id, event_type, created_at) VALUES (?, 'app_open', ?)`).run(id, lastAt);
  if (push) {
    sqlite.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)`)
      .run(`ps-${id}`, id, ep(id), keys.sub.p256dh, keys.sub.auth);
  }
}

function pushSpy() {
  const spy = vi.fn(async () => ({ ok: true, status: 201 }));
  vi.stubGlobal('fetch', spy);
  return { spy, to: (id) => spy.mock.calls.filter(([u]) => String(u) === ep(id)).length };
}

suite('FBQ-07b — night-deferred people do not occupy the batch', () => {
  it('60 night-deferred people do not starve a fresh daytime person; each is nudged once when day comes', async () => {
    const keys = await vapid();
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV(), ...keys.env };
    // 60 Tokyo people, quiet longest. 12:00Z is 21:00 in Tokyo: night for an unscheduled push.
    for (let i = 0; i < 60; i++) {
      seedPerson(db.sqlite, keys, `tk${String(i).padStart(2, '0')}`, `2026-06-${String(21 + (i % 9)).padStart(2, '0')} 10:00:00`, { tz: 'Asia/Tokyo' });
    }
    // One London person (13:00 local, daytime), quiet more recently than all of them.
    seedPerson(db.sqlite, keys, 'fresh', '2026-07-01 09:00:00', { tz: 'Europe/London' });
    const { spy, to } = pushSpy();

    const t1 = await runReturnNudges(env, { now: '2026-07-10T12:00:00.000Z' });
    expect(t1.deferred).toBe(50);
    const t2 = await runReturnNudges(env, { now: '2026-07-10T12:01:00.000Z' });
    // Held people are out of the scan: the second tick reaches the rest AND the fresh person.
    expect(t2.scanned).toBe(11);
    expect(to('fresh')).toBe(1);

    // Nothing is sent to Tokyo overnight, and held people cost no scan work.
    const night = await runReturnNudges(env, { now: '2026-07-10T14:00:00.000Z' });
    expect(night.scanned).toBe(0);
    expect(spy.mock.calls.length).toBe(1);

    // Tokyo morning (08:00 local = 23:00Z): the hold ends, each is nudged exactly once.
    for (const m of ['00', '01', '02', '03']) await runReturnNudges(env, { now: `2026-07-10T23:${m}:00.000Z` });
    for (let i = 0; i < 60; i++) expect(to(`tk${String(i).padStart(2, '0')}`)).toBe(1);
    expect(to('fresh')).toBe(1);
    // A later tick finds no one: the latch, not the hold, now keeps them quiet.
    const after = await runReturnNudges(env, { now: '2026-07-11T23:00:00.000Z' });
    expect(after.scanned).toBe(0);
  });

  it('a person returning during the hold and going quiet again is still nudged once', async () => {
    const keys = await vapid();
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV(), ...keys.env };
    seedPerson(db.sqlite, keys, 'u1', '2026-07-01 09:00:00', { tz: 'Asia/Tokyo' });
    const { to } = pushSpy();
    await runReturnNudges(env, { now: '2026-07-10T12:00:00.000Z' }); // deferred, held to 23:00Z
    expect(to('u1')).toBe(0);
    await runReturnNudges(env, { now: '2026-07-10T23:00:00.000Z' });
    expect(to('u1')).toBe(1);
    await runReturnNudges(env, { now: '2026-07-11T23:00:00.000Z' });
    expect(to('u1')).toBe(1);
  });
});
