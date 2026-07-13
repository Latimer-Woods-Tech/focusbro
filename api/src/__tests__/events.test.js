/**
 * FocusBro — accountability instrumentation tests (Contender #10, Phase A · R-235).
 *
 * The retention/loop-proof spine (docs/IMPROVEMENT_PLAN.md L1): recordEvent
 * writes first-party events into `analytics_events`, and computeLoopMetrics reads
 * them back into the founder/coach numbers. Both are exercised through a
 * minimal D1-shaped fake — no live database. The DESIGN LAW is asserted too:
 * "reschedule" is a protected outcome in the rate, never a shame tally.
 */

import { describe, it, expect } from 'vitest';
import {
  recordEvent, computeLoopMetrics, outcomeEvent, clampSinceDays, EVENTS,
} from '../events.js';

// ── a minimal D1-shaped fake keyed off SQL substrings ──
// `counts` maps event_type → n for the GROUP BY query; `active`/`returning` are
// the two aggregate scalars. `throwOnRun` simulates a broken INSERT (missing
// table) so the non-fatal guarantee can be asserted.
function makeDB({ counts = {}, active = 0, returning = 0, throwOnRun = false } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async all() {
          if (/GROUP BY event_type/.test(sql)) {
            return { results: Object.entries(counts).map(([event_type, n]) => ({ event_type, n })) };
          }
          return { results: [] };
        },
        async first() {
          if (/COUNT\(DISTINCT user_id\)/.test(sql)) return { n: active };
          if (/HAVING COUNT\(DISTINCT substr/.test(sql)) return { n: returning };
          return null;
        },
        async run() {
          if (throwOnRun) throw new Error('no such table: analytics_events');
          runs.push({ sql, params });
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

describe('outcomeEvent — maps a check-in outcome to its event type', () => {
  it('maps kept / reschedule / rescheduled / missed', () => {
    expect(outcomeEvent('kept')).toBe(EVENTS.COMMITMENT_KEPT);
    expect(outcomeEvent('reschedule')).toBe(EVENTS.COMMITMENT_RESCHEDULE);
    expect(outcomeEvent('rescheduled')).toBe(EVENTS.COMMITMENT_RESCHEDULE);
    expect(outcomeEvent('missed')).toBe(EVENTS.COMMITMENT_MISSED);
  });
  it('returns null for anything we do not log', () => {
    expect(outcomeEvent('snooze')).toBeNull();
    expect(outcomeEvent(undefined)).toBeNull();
  });
});

describe('clampSinceDays', () => {
  it('defaults to 7 and clamps to 1..90', () => {
    expect(clampSinceDays(undefined)).toBe(7);
    expect(clampSinceDays('0')).toBe(7);
    expect(clampSinceDays(-3)).toBe(7);
    expect(clampSinceDays('14')).toBe(14);
    expect(clampSinceDays(1000)).toBe(90);
    expect(clampSinceDays(1)).toBe(1);
  });
});

describe('recordEvent — writes to analytics_events, non-fatal', () => {
  it('inserts with (user_id, event_type, event_data) and serializes data', async () => {
    const db = makeDB();
    const ok = await recordEvent({ DB: db }, {
      userId: 'u1', type: EVENTS.COMMITMENT_CREATED, data: { commitment_id: 'c1', recurrence: 'daily' },
    });
    expect(ok).toBe(true);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toMatch(/INSERT INTO analytics_events/);
    expect(db.runs[0].params[0]).toBe('u1');
    expect(db.runs[0].params[1]).toBe('commitment_created');
    expect(JSON.parse(db.runs[0].params[2])).toEqual({ commitment_id: 'c1', recurrence: 'daily' });
  });

  it('never throws when the insert fails — instrumentation cannot break the flow', async () => {
    const db = makeDB({ throwOnRun: true });
    const ok = await recordEvent({ DB: db }, { userId: 'u1', type: EVENTS.COMMITMENT_KEPT });
    expect(ok).toBe(false); // swallowed, returned false, did NOT throw
  });

  it('is a no-op without a DB or a type', async () => {
    expect(await recordEvent(null, { type: 'x' })).toBe(false);
    expect(await recordEvent({ DB: makeDB() }, { userId: 'u1' })).toBe(false);
  });
});

describe('computeLoopMetrics — the retention/coach numbers', () => {
  it('computes totals, honest kept-word rate, and reschedule rate', async () => {
    // 8 kept, 2 reschedule, 2 missed → 12 resolved → kept 0.67, reschedule 0.17
    const db = makeDB({
      counts: {
        [EVENTS.COMMITMENT_CREATED]: 20,
        [EVENTS.CHECKIN_DELIVERED]: 15,
        [EVENTS.COMMITMENT_KEPT]: 8,
        [EVENTS.COMMITMENT_RESCHEDULE]: 2,
        [EVENTS.COMMITMENT_MISSED]: 2,
        [EVENTS.COMMITMENT_RELEASED]: 1,
      },
      active: 5, returning: 3,
    });
    const m = await computeLoopMetrics({ DB: db }, { sinceDays: 7, nowISO: '2026-07-13T00:00:00.000Z' });

    expect(m.totals.commitments_created).toBe(20);
    expect(m.totals.checkins_delivered).toBe(15);
    expect(m.totals.commitments_kept).toBe(8);
    expect(m.totals.commitments_released).toBe(1);
    expect(m.resolved).toBe(12);
    expect(m.kept_word_rate).toBeCloseTo(0.67, 2);
    expect(m.reschedule_rate).toBeCloseTo(0.17, 2);
    expect(m.active_users).toBe(5);
    expect(m.returning_users).toBe(3);
    expect(m.window.days).toBe(7);
    expect(m.window.since).toBe('2026-07-06T00:00:00.000Z');
    expect(m.window.until).toBe('2026-07-13T00:00:00.000Z');
  });

  it('returns null rates (never NaN, never a divide-by-zero) on an empty window', async () => {
    const db = makeDB({ counts: {}, active: 0, returning: 0 });
    const m = await computeLoopMetrics({ DB: db }, { sinceDays: 30 });
    expect(m.resolved).toBe(0);
    expect(m.kept_word_rate).toBeNull();
    expect(m.reschedule_rate).toBeNull();
    expect(m.active_users).toBe(0);
    expect(m.window.days).toBe(30);
  });

  it('a reschedule-heavy window is still counted honestly, never as failure', async () => {
    // The DESIGN LAW: reschedules lower the kept RATE but are never a "miss".
    const db = makeDB({ counts: { [EVENTS.COMMITMENT_KEPT]: 1, [EVENTS.COMMITMENT_RESCHEDULE]: 3 } });
    const m = await computeLoopMetrics({ DB: db }, {});
    expect(m.totals.commitments_missed).toBe(0);
    expect(m.resolved).toBe(4);
    expect(m.kept_word_rate).toBeCloseTo(0.25, 2);
    expect(m.reschedule_rate).toBeCloseTo(0.75, 2);
  });
});
