/**
 * FocusBro — the silent miss, met with warmth on return (Contender #10, Phase A · R-286).
 *
 * The escalation ladder knocks exactly once more (push → one SMS) and then, if
 * that lands on silence too, latches `escalated_at` and goes quiet forever. That
 * left the last unresolved corner of the two-way moat: a check-in nobody ever
 * answered sat as an eternal `status='sent'` row — a "still waiting" ghost that
 * never closes. The DESIGN LAW's answer to a miss is never a scold and never a
 * dangling thread, so the moment the person comes back under their own steam
 * (`GET /api/commitments` — loading their words), every genuinely-silent check-in
 * is resolved as a no-shame `reschedule`: streak-protected, rhythm-continuing,
 * never a miss score.
 *
 * These pin the guarantees against a fake D1 keyed off SQL substrings — no live
 * DB, no network:
 *   - a stranded (escalated + silent + active) check-in is closed as a reschedule
 *     and the streak is left untouched (the no-shame guarantee, end to end);
 *   - a recurring rhythm re-queues its next occurrence — the door keeps rolling;
 *   - only genuinely-silent rows qualify: the silence cutoff is `now − 60 min`,
 *     so a reply still in flight is never stolen, and the SQL guards on the
 *     escalation latch, the unanswered row, and an active commitment;
 *   - nothing to reconcile writes nothing; and the pass is non-fatal — a DB
 *     failure returns `{ reconciled: 0 }` and never throws into the return.
 */

import { describe, it, expect } from 'vitest';
import { reconcileStrandedCheckins, STRANDED_SILENCE_MIN, STRANDED_NOTE } from '../accountability.js';

// ── a minimal D1-shaped fake ─────────────────────────────────
// `stranded` is the set of rows the stranded-scan SELECT returns; `streak` feeds
// the streak read inside applyCheckinOutcome; `existingPending` answers the
// recurring "is a future pending row already queued?" probe. Every prepare(sql)
// is captured (with its bound params) in `runs` / `queries` so we can assert on
// exactly what ran. `throwOnScan` makes the scan itself blow up.
function makeDB({ stranded = [], streak = null, existingPending = null, throwOnScan = false } = {}) {
  const runs = [];
  const queries = [];
  const db = {
    runs,
    queries,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; queries.push({ sql, params }); return stmt; },
        async first() {
          if (/FROM accountability_streaks/.test(sql)) return streak;
          if (/FROM commitment_checkins\s+WHERE commitment_id = \? AND status = 'pending'/.test(sql)) return existingPending;
          return null;
        },
        async all() {
          if (/FROM commitment_checkins c\s+JOIN commitments m/.test(sql) && /escalated_at IS NOT NULL/.test(sql)) {
            if (throwOnScan) throw new Error('transient D1 failure on scan');
            return { results: stranded };
          }
          return { results: [] };
        },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}

const NOW = '2026-07-29T18:00:00.000Z';
const oneShotRow = {
  checkin_id: 'ci-silent', commitment_id: 'cm-1',
  recurrence: 'none', timezone: 'UTC', local_time: null, channel: 'push', commitment_status: 'active',
};
const dailyRow = {
  checkin_id: 'ci-silent-daily', commitment_id: 'cm-2',
  recurrence: 'daily', timezone: 'America/New_York', local_time: '08:40', channel: 'push', commitment_status: 'active',
};

describe('reconcileStrandedCheckins — the silent miss, resolved warmly on return', () => {
  const USER = 'user-1';

  it('closes a stranded one-shot as a no-shame reschedule and leaves the streak untouched', async () => {
    const db = makeDB({
      stranded: [oneShotRow],
      streak: { current_streak: 6, longest_streak: 9, total_kept: 20, last_kept_date: '2026-07-28' },
    });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(1);

    // the exact stranded row was stamped 'reschedule' (not 'missed')
    const rowUpd = db.runs.find((x) => /UPDATE commitment_checkins/.test(x.sql) && x.params.includes('ci-silent'));
    expect(rowUpd).toBeTruthy();
    expect(rowUpd.params).toContain('reschedule');
    expect(rowUpd.params).toContain(STRANDED_NOTE);

    // one-shot commitment moved to 'rescheduled' → renders "Moved — still on", an open door
    const cUpd = db.runs.find((x) => /UPDATE commitments SET status/.test(x.sql));
    expect(cUpd.params).toContain('rescheduled');

    // streak persisted UNCHANGED — a silent miss never breaks the chain
    const sUpd = db.runs.find((x) => /INSERT INTO accountability_streaks/.test(x.sql));
    expect(sUpd.params).toContain(6);   // current_streak held
    expect(sUpd.params).toContain(20);  // total_kept held
  });

  it('a recurring rhythm keeps rolling — its next occurrence materializes', async () => {
    const db = makeDB({ stranded: [dailyRow], existingPending: null });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(1);
    // recurring commitment stays active (a rhythm is never "done")
    const cUpd = db.runs.find((x) => /UPDATE commitments SET status/.test(x.sql));
    expect(cUpd.params).toContain('active');
    // next occurrence queued
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(true);
  });

  it('resolves every stranded row it is handed and reports the count', async () => {
    const db = makeDB({ stranded: [oneShotRow, { ...dailyRow, checkin_id: 'ci-3', commitment_id: 'cm-3' }] });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(2);
  });

  it('only genuinely-silent rows qualify: silence cutoff is now − 60 min, guarded on latch/unanswered/active', async () => {
    const db = makeDB({ stranded: [] });
    await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    const scan = db.queries.find((q) => /FROM commitment_checkins c\s+JOIN commitments m/.test(q.sql) && /escalated_at IS NOT NULL/.test(q.sql));
    expect(scan).toBeTruthy();
    // the SQL enforces the four guards that make this a real silent miss
    // (the open set spans awaiting_time too, but a push row is only ever 'sent')
    expect(scan.sql).toMatch(/c\.status IN \('sent', 'awaiting_time'\)/);
    expect(scan.sql).toMatch(/c\.responded_at IS NULL/);
    expect(scan.sql).toMatch(/c\.escalated_at IS NOT NULL/);
    expect(scan.sql).toMatch(/m\.status = 'active'/);
    // the cutoff param is exactly now − STRANDED_SILENCE_MIN, so a reply in flight is safe
    const expectedCutoff = new Date(new Date(NOW).getTime() - STRANDED_SILENCE_MIN * 60 * 1000).toISOString();
    expect(scan.params).toContain(expectedCutoff);
  });

  it('nothing to reconcile writes nothing', async () => {
    const db = makeDB({ stranded: [] });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(0);
    expect(db.runs.length).toBe(0);
  });

  it('is non-fatal: a scan failure returns { reconciled: 0 } and never throws into the return', async () => {
    const db = makeDB({ throwOnScan: true });
    // The pass swallows its own errors (a return is never blocked by housekeeping),
    // so this resolves rather than rejecting.
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(0);
  });

  it('guards missing inputs — no env/DB/user is a no-op, never a throw', async () => {
    expect((await reconcileStrandedCheckins(null, USER)).reconciled).toBe(0);
    expect((await reconcileStrandedCheckins({}, USER)).reconciled).toBe(0);
    expect((await reconcileStrandedCheckins({ DB: makeDB() }, '')).reconciled).toBe(0);
  });
});
