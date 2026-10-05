/**
 * FBQ-07c (focusbro#391) — night-deferred escalation candidates must not starve
 * the escalation scan. Driven on a REAL SQLite built from migrations/ (real-d1.js).
 *
 * What broke: runEscalations reads the OLDEST 50 quiet check-ins and defers the
 * ones outside daytime WITHOUT latching, so 50+ rows in a zone that is at night
 * refilled every batch forever and a row in a zone that was in daytime sat behind
 * them (the FBQ-06 / FBQ-07b shape). A deferred row now carries
 * `escalation_retry_after`; the scan skips it until the hold passes. The hold is
 * not the one-shot latch, so a held row is still escalated exactly once, later.
 */
import { describe, it, expect } from 'vitest';
import { runEscalations } from '../checkins-cron.js';
import { DatabaseSync, makeMigratedD1, makeKV } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;

function seed(sqlite, id, { tz, deliveredAt, ceiling, pro = true }) {
  sqlite.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')`).run(id, `${id}@example.com`);
  sqlite.prepare(`INSERT INTO commitments (id, user_id, title, start_at, channel, timezone, status) VALUES (?, ?, 'stretch', '2026-07-09T20:00:00.000Z', 'push', ?, 'active')`).run(`cm-${id}`, id, tz);
  sqlite.prepare(`INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status, delivered_at) VALUES (?, ?, ?, ?, 'push', 'sent', ?)`)
    .run(`ck-${id}`, `cm-${id}`, id, deliveredAt, deliveredAt);
  if (ceiling) sqlite.prepare(`INSERT INTO escalation_prefs (user_id, ceiling) VALUES (?, ?)`).run(id, ceiling);
  if (pro) sqlite.prepare(`INSERT INTO pro_purchases (id, user_id, stripe_session_id, status) VALUES (?, ?, ?, 'paid')`).run(`pp-${id}`, id, `cs-${id}`);
}

const latched = (sqlite, id) => sqlite.prepare(`SELECT escalated_at FROM commitment_checkins WHERE id = ?`).get(`ck-${id}`).escalated_at !== null;

suite('FBQ-07c — night-deferred escalation rows do not starve the scan', () => {
  it('55 rows at night + 1 row in daytime: the daytime row is reached on the second tick, none is escalated at night', async () => {
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV() };
    // 55 older rows in UTC; at 03:00Z it is night there.
    for (let i = 0; i < 55; i++) seed(db.sqlite, `n${String(i).padStart(2, '0')}`, { tz: 'UTC', deliveredAt: `2026-07-10T01:${String(i % 40).padStart(2, '0')}:00.000Z` });
    // One newer row in Tokyo, where 03:00Z is 12:00 — daytime. ceiling none: a chosen skip, latched when scanned.
    seed(db.sqlite, 'tokyo', { tz: 'Asia/Tokyo', deliveredAt: '2026-07-10T02:00:00.000Z', ceiling: 'none' });

    const t1 = await runEscalations(env, { now: '2026-07-10T03:00:00.000Z' });
    expect(t1.deferred).toBe(50);
    expect(latched(db.sqlite, 'tokyo')).toBe(false); // behind the first batch

    const t2 = await runEscalations(env, { now: '2026-07-10T03:01:00.000Z' });
    // Held rows are skipped: tick 2 sees the 5 unheld night rows, then the Tokyo row.
    expect(t2.scanned).toBe(6);
    expect(t2.skipped).toBe(1);
    expect(latched(db.sqlite, 'tokyo')).toBe(true);

    // A hold is not a latch: no night row is latched; each is held into the daytime window.
    const held = db.sqlite.prepare(`SELECT COUNT(*) AS n FROM commitment_checkins WHERE id LIKE 'ck-n%' AND escalated_at IS NULL AND escalation_retry_after >= '2026-07-10T08:00:00.000Z'`).get().n;
    expect(held).toBe(55);

    // Before the hold passes, nothing is rescanned.
    const t3 = await runEscalations(env, { now: '2026-07-10T04:00:00.000Z' });
    expect(t3.scanned).toBe(0);
  });

  it('a held row is still escalated exactly once after its hold passes', async () => {
    const db = makeMigratedD1();
    const env = { DB: db, KV_CACHE: makeKV() };
    seed(db.sqlite, 'u1', { tz: 'UTC', deliveredAt: '2026-07-10T01:00:00.000Z' });
    await runEscalations(env, { now: '2026-07-10T03:00:00.000Z' });
    expect(latched(db.sqlite, 'u1')).toBe(false);
    // Daytime: no consent on record, so it is latched as a skip — scanned once, never again.
    const day = await runEscalations(env, { now: '2026-07-10T09:00:00.000Z' });
    expect(day.scanned).toBe(1);
    expect(latched(db.sqlite, 'u1')).toBe(true);
    const again = await runEscalations(env, { now: '2026-07-10T09:05:00.000Z' });
    expect(again.scanned).toBe(0);
  });
});
