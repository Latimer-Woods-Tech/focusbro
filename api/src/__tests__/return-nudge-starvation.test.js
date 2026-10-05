/**
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
import { readdirSync, readFileSync } from 'node:fs';
import { runReturnNudges } from '../checkins-cron.js';
import { deleteAccount } from '../account-delete.js';
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
function seedPerson(sqlite, keys, id, lastAt, { push = true } = {}) {
  sqlite.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')`).run(id, `${id}@example.com`);
  sqlite.prepare(`INSERT INTO commitments (id, user_id, title, start_at, channel, timezone, status) VALUES (?, ?, 'stretch', '2026-06-20T15:00:00.000Z', 'push', 'UTC', 'active')`).run(`cm-${id}`, id);
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

suite('FBQ-07 — a newly dormant person is not starved by people already nudged', () => {
  it('60 people already nudged + 1 newly dormant: the new one is nudged on the first tick after', async () => {
    const keys = await vapid();
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV(), ...keys.env };
    // 60 people who went quiet long ago, oldest first.
    for (let i = 0; i < 60; i++) {
      seedPerson(db.sqlite, keys, `old${String(i).padStart(2, '0')}`, `2026-06-${String(21 + (i % 9)).padStart(2, '0')} 10:00:00`);
    }
    const { spy } = pushSpy();
    // Two daytime ticks nudge all 60 (50 per tick), once each.
    await runReturnNudges(env, { now: '2026-07-10T12:00:00.000Z' });
    await runReturnNudges(env, { now: '2026-07-10T12:01:00.000Z' });
    expect(spy.mock.calls.length).toBe(60);

    // Days later one more person goes quiet — more recently than all 60.
    seedPerson(db.sqlite, keys, 'fresh', '2026-07-12 09:00:00');
    const { to } = pushSpy();
    const s = await runReturnNudges(env, { now: '2026-07-16T12:00:00.000Z' });
    expect(to('fresh')).toBe(1);
    expect(s.nudged).toBe(1);
    // …and none of the 60 hears a second nudge in this dormancy.
    expect(s.nudged + s.skipped + s.failed + s.deferred).toBe(1);
  });

  it('each person hears exactly one nudge per quiet spell, across many ticks', async () => {
    const keys = await vapid();
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV(), ...keys.env };
    seedPerson(db.sqlite, keys, 'u1', '2026-07-01 09:00:00');
    const { to } = pushSpy();
    for (let d = 10; d <= 20; d++) {
      for (const h of ['09', '13', '18']) await runReturnNudges(env, { now: `2026-07-${d}T${h}:00:00.000Z` });
    }
    expect(to('u1')).toBe(1);
  });
});

suite('FBQ-07 — one time format: a return on the same UTC day opens the next spell', () => {
  it('nudged 10:00Z, back at 18:00 the same day, quiet again → nudged once more', async () => {
    const keys = await vapid();
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV(), ...keys.env };
    seedPerson(db.sqlite, keys, 'u1', '2026-07-01 09:00:00');
    const { to } = pushSpy();
    await runReturnNudges(env, { now: '2026-07-14T10:00:00.000Z' });
    expect(to('u1')).toBe(1);

    // They come back that evening (recorded the way recordEvent does: datetime format).
    db.sqlite.prepare(`INSERT INTO analytics_events (user_id, event_type, created_at) VALUES ('u1', 'app_open', '2026-07-14 18:00:00')`).run();
    // Still quiet at the next ticks inside 3 days → nothing.
    await runReturnNudges(env, { now: '2026-07-16T12:00:00.000Z' });
    expect(to('u1')).toBe(1);
    // Quiet for more than 3 days → the new spell gets its one nudge.
    await runReturnNudges(env, { now: '2026-07-18T12:00:00.000Z' });
    expect(to('u1')).toBe(2);
    await runReturnNudges(env, { now: '2026-07-19T12:00:00.000Z' });
    expect(to('u1')).toBe(2);
  });
});

suite('FBQ-07 — account deletion takes the nudge records with it', () => {
  it('no return_nudge_sent row still names the deleted person; another person\'s rows stay', async () => {
    const keys = await vapid();
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV(), ...keys.env };
    seedPerson(db.sqlite, keys, 'gone', '2026-07-01 09:00:00');
    seedPerson(db.sqlite, keys, 'stays', '2026-07-01 09:00:00');
    pushSpy();
    const s = await runReturnNudges(env, { now: '2026-07-14T12:00:00.000Z' });
    expect(s.nudged).toBe(2);
    const named = (id) => db.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'return_nudge_sent' AND event_data LIKE ?`,
    ).get(`%"${id}"%`).n;
    expect(named('gone')).toBe(1);

    await deleteAccount(env, 'gone');
    expect(named('gone')).toBe(0);
    expect(named('stays')).toBe(1);
  });
});

// ── cost: the scan is linear in events and served by an index ──
function bulkEvents(sqlite, rows) {
  const ins = sqlite.prepare(`INSERT INTO analytics_events (user_id, event_type, created_at) VALUES (?, ?, ?)`);
  sqlite.exec('BEGIN');
  for (const r of rows()) ins.run(...r);
  sqlite.exec('COMMIT');
}

async function timedTick(env, now) {
  const t0 = performance.now();
  const s = await runReturnNudges(env, { now });
  return { ms: performance.now() - t0, s };
}

suite('FBQ-07 — the scan is cheap enough to run every minute', () => {
  it('one person with 10,000 events: a tick finishes in under 1 s', async () => {
    const db = makeMigratedD1();
    db.sqlite.prepare(`INSERT INTO users (id, email, password_hash) VALUES ('heavy', 'h@example.com', 'x')`).run();
    bulkEvents(db.sqlite, function* rows() {
      const base = Date.parse('2026-06-01T00:00:00Z');
      for (let i = 0; i < 10000; i++) {
        const at = new Date(base + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
        yield ['heavy', i === 9999 ? 'commitment_created' : 'focus_session', at];
      }
    });
    const { ms, s } = await timedTick({ DB: db, KV_CACHE: makeKV() }, '2026-07-14T12:00:00.000Z');
    console.log(`[FBQ-07 timing] 10k events / 1 user: ${ms.toFixed(1)} ms`);
    expect(s.scanned).toBe(1);
    expect(ms).toBeLessThan(1000);
  }, 120000);

  it('1,000,000 events across 2,000 people: a tick finishes in under 500 ms', async () => {
    const db = makeMigratedD1();
    const users = db.sqlite.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')`);
    db.sqlite.exec('BEGIN');
    for (let u = 0; u < 2000; u++) users.run(`p${u}`, `p${u}@example.com`);
    db.sqlite.exec('COMMIT');
    // 500 events each; every one has a word on record; half are active today,
    // half went quiet and were already nudged this spell (latched by real ticks below).
    bulkEvents(db.sqlite, function* rows() {
      const base = Date.parse('2026-06-01T00:00:00Z');
      for (let u = 0; u < 2000; u++) {
        const quiet = u % 2 === 0;
        for (let i = 0; i < 500; i++) {
          const t = quiet ? base + i * 3600000 : Date.parse('2026-07-14T00:00:00Z') + i * 60000;
          yield [`p${u}`, i === 250 ? 'commitment_created' : 'focus_session', new Date(t).toISOString().slice(0, 19).replace('T', ' ')];
        }
      }
    });
    const env = { DB: db, KV_CACHE: makeKV() };
    // No channel → each quiet person is latched on their first scan.
    for (let i = 0; i < 20; i++) await runReturnNudges(env, { now: `2026-07-14T12:${String(i).padStart(2, '0')}:00.000Z` });
    const { ms, s } = await timedTick(env, '2026-07-14T12:30:00.000Z');
    console.log(`[FBQ-07 timing] 1M events / 2000 users: ${ms.toFixed(1)} ms (scanned ${s.scanned})`);
    expect(s.scanned).toBe(0);
    expect(ms).toBeLessThan(500);
  }, 600000);
});

suite('FBQ-07 — the latch migration backfills from sent nudges', () => {
  it('a person already nudged keeps their latch; a malformed or orphan row is ignored', () => {
    const dir = new URL('../../../migrations/', import.meta.url);
    const files = readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
    const latchFile = files.find((n) => /_return_nudge_latch\.sql$/.test(n));
    const sqlite = new DatabaseSync(':memory:');
    for (const f of files.filter((n) => n < latchFile)) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
    sqlite.exec(`INSERT INTO users (id, email, password_hash) VALUES ('u1', 'u1@example.com', 'x')`);
    const ev = sqlite.prepare(`INSERT INTO analytics_events (user_id, event_type, event_data, created_at) VALUES (NULL, 'return_nudge_sent', ?, ?)`);
    ev.run('{"user_id":"u1","channel":"push"}', '2026-07-01 12:00:00');
    ev.run('{"user_id":"u1","channel":"push"}', '2026-07-09 12:00:00');
    ev.run('{"user_id":"ghost","channel":"push"}', '2026-07-09 12:00:00');
    ev.run('not json', '2026-07-09 12:00:00');
    sqlite.exec(readFileSync(new URL(latchFile, dir), 'utf8'));
    expect(sqlite.prepare('SELECT user_id, nudged_at FROM return_nudge_latch').all().map((r) => ({ ...r })))
      .toEqual([{ user_id: 'u1', nudged_at: '2026-07-09 12:00:00' }]);
  });
});
