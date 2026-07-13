/**
 * FocusBro — analytics ingest tests (Contender #10, Phase A · L1 bridge, R-239 follow-up).
 *
 * syncAnalyticsEvents is the LIVE, authed ingest (POST /sync/events) the free-tier
 * timer bridge posts `session_complete` to. It writes every event through
 * events.js `recordEvent`, so these tests assert the three properties the bridge
 * relies on: the client timestamp lands the row on its real day, a client event
 * id makes a replay idempotent (in-batch dedup + OR IGNORE at the DB), and an
 * event with no type is skipped rather than dropping the whole batch. A minimal
 * D1-shaped fake captures the INSERTs; recordSync's own writes land in it too.
 */

import { describe, it, expect } from 'vitest';
import { syncAnalyticsEvents } from '../sync.js';

// D1-shaped fake: captures every run() so we can inspect the analytics INSERTs.
function makeDB() {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { runs.push({ sql, params }); return { success: true }; },
      };
      return stmt;
    },
  };
  return db;
}

// Only the analytics_events INSERTs (recordEvent) — filter out recordSync's
// sync_logs / audit_logs writes so assertions target the bridge.
function analyticsRuns(db) {
  return db.runs.filter((r) => /INTO analytics_events/.test(r.sql));
}

describe('syncAnalyticsEvents — the live timer→retention ingest', () => {
  it('is a no-op for an empty or non-array batch', async () => {
    const db = makeDB();
    expect(await syncAnalyticsEvents({ DB: db }, 'u1', [])).toEqual({ success: true, synced: 0 });
    expect(await syncAnalyticsEvents({ DB: db }, 'u1', null)).toEqual({ success: true, synced: 0 });
    expect(analyticsRuns(db)).toHaveLength(0);
  });

  it('writes a session_complete on its client day via an idempotent OR IGNORE row', async () => {
    const db = makeDB();
    const res = await syncAnalyticsEvents({ DB: db }, 'user-7', [
      { id: 'evt-1', type: 'session_complete', tool: 'pomodoro', duration_seconds: 1500, at: '2026-07-02T08:15:00.000Z' },
    ]);
    expect(res).toEqual({ success: true, synced: 1 });
    const rows = analyticsRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].sql).toMatch(/INSERT OR IGNORE INTO analytics_events/);
    expect(rows[0].params[0]).toBe('user-7');            // user id
    expect(rows[0].params[1]).toBe('session_complete');  // event type
    expect(JSON.parse(rows[0].params[2])).toEqual({ tool: 'pomodoro', duration_seconds: 1500 }); // envelope stripped
    expect(rows[0].params[3]).toBe('2026-07-02 08:15:00'); // real day, normalized
    expect(rows[0].params[4]).toBe('evt-1');             // client event id bound for DB dedup
  });

  it('dedups repeated client ids WITHIN a batch (a double-flush counts once)', async () => {
    const db = makeDB();
    const res = await syncAnalyticsEvents({ DB: db }, 'u1', [
      { id: 'dup', type: 'session_complete', tool: 'pomodoro', at: '2026-07-02T08:00:00Z' },
      { id: 'dup', type: 'session_complete', tool: 'pomodoro', at: '2026-07-02T08:00:00Z' },
      { id: 'other', type: 'session_complete', tool: 'pomodoro', at: '2026-07-02T09:00:00Z' },
    ]);
    expect(res.synced).toBe(2);
    expect(analyticsRuns(db)).toHaveLength(2);
  });

  it('skips an event with no type without dropping the rest of the batch', async () => {
    const db = makeDB();
    const res = await syncAnalyticsEvents({ DB: db }, 'u1', [
      { id: 'a', tool: 'pomodoro', at: '2026-07-02T08:00:00Z' }, // no type → skipped
      { id: 'b', type: 'session_complete', tool: 'pomodoro', at: '2026-07-02T08:30:00Z' },
    ]);
    expect(res.synced).toBe(1);
    expect(analyticsRuns(db)).toHaveLength(1);
    expect(analyticsRuns(db)[0].params[1]).toBe('session_complete');
  });

  it('accepts an event without a tool now (only type is required)', async () => {
    const db = makeDB();
    const res = await syncAnalyticsEvents({ DB: db }, 'u1', [
      { id: 'c', type: 'session_complete', at: '2026-07-02T08:00:00Z' },
    ]);
    expect(res.synced).toBe(1);
    expect(analyticsRuns(db)).toHaveLength(1);
  });

  it('caps a single batch at 100 events so one request cannot flood the spine', async () => {
    const db = makeDB();
    const big = Array.from({ length: 150 }, (_, i) => ({ id: 'e' + i, type: 'session_complete', tool: 'pomodoro' }));
    const res = await syncAnalyticsEvents({ DB: db }, 'u1', big);
    expect(res.synced).toBe(100);
    expect(analyticsRuns(db)).toHaveLength(100);
  });
});
