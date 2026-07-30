/**
 * FocusBro — the silent miss now closes on EVERY channel, not just push (Contender #10, Phase A · R-288).
 *
 * R-286 held a warm, no-shame door open for a silently-missed check-in: on the
 * person's return, a `status='sent'` row nobody ever answered is resolved as a
 * `reschedule` (streak-safe, rhythm-continuing) instead of sitting open forever
 * as a "still waiting" ghost. But its scan required `escalated_at IS NOT NULL` —
 * and the escalation ladder is PUSH-ONLY (`runEscalations` scans `channel = 'push'`).
 * A TEXT check-in is therefore never escalated: `escalated_at` stays NULL forever,
 * so the R-286 scan never saw it, and a silently-missed text word had its own
 * eternal dangling thread — the exact defect one channel over.
 *
 * R-288 closes it: text has no escalation anchor, so its silence is measured from
 * `delivered_at` and held for the SAME total window a push miss weathers
 * (`STRANDED_TEXT_SILENCE_MIN` = the 15-min escalation delay + STRANDED_SILENCE_MIN).
 *
 * These pin the guarantee against a FILTER-FAITHFUL fake D1 — the scan's `all()`
 * evaluates the real WHERE/branches against each candidate row, so reverting the
 * query genuinely drops the text row (a true proof-of-rejection, not a bypass):
 *   - a stranded TEXT check-in (delivered, never escalated, silent past the text
 *     window, on an active commitment) is closed as a no-shame reschedule;
 *   - a text reply STILL IN FLIGHT (delivered inside the window) is never stolen;
 *   - the push path is unchanged — a stranded push row still resolves (no regression);
 *   - the SQL carries the text branch + ASC ordering, and binds the now−75-min cutoff.
 */

import { describe, it, expect } from 'vitest';
import {
  reconcileStrandedCheckins,
  STRANDED_SILENCE_MIN,
  STRANDED_TEXT_SILENCE_MIN,
  STRANDED_NOTE,
} from '../accountability.js';

const NOW = '2026-07-29T18:00:00.000Z';
const nowMs = new Date(NOW).getTime();
const pushCutoff = new Date(nowMs - STRANDED_SILENCE_MIN * 60 * 1000).toISOString();
const textCutoff = new Date(nowMs - STRANDED_TEXT_SILENCE_MIN * 60 * 1000).toISOString();

// ── a FILTER-FAITHFUL D1-shaped fake ─────────────────────────
// `candidates` are the raw commitment_checkins⋈commitments rows in the store.
// The stranded-scan `all()` applies the SAME predicate the real SQL does — the
// shared base guards, then whichever channel branches the SQL actually contains,
// against the cutoff params it actually bound. So the OLD query (no text branch,
// `escalated_at IS NOT NULL` for any channel) returns nothing for a text row,
// and reverting the fix makes the text cases fail. `streak` feeds the read inside
// applyCheckinOutcome; every prepare(sql) is captured in `runs`/`queries`.
function makeDB({ candidates = [], streak = null, existingPending = null } = {}) {
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
          const isScan = /FROM commitment_checkins c\s+JOIN commitments m/.test(sql) && /escalated_at/.test(sql);
          if (!isScan) return { results: [] };

          const hasPushBranch = /c\.channel = 'push'/.test(sql) && /c\.escalated_at IS NOT NULL/.test(sql);
          const hasTextBranch = /c\.channel = 'text'/.test(sql) && /c\.delivered_at\s+IS NOT NULL/.test(sql) && /c\.delivered_at\s*<=/.test(sql);
          // R-286 (pre-fix) shape: an unbranched `escalated_at IS NOT NULL` over any channel.
          const legacyEscalated = !hasPushBranch && /c\.escalated_at IS NOT NULL/.test(sql);
          const boundPush = params.includes(pushCutoff);
          const boundText = params.includes(textCutoff);

          const results = candidates.filter((r) => {
            if (r.status !== 'sent' || r.responded_at != null || r.commitment_status !== 'active') return false;
            const pushOk = (hasPushBranch && r.channel === 'push' && r.escalated_at != null && boundPush && r.escalated_at <= pushCutoff)
              || (legacyEscalated && r.escalated_at != null && boundPush && r.escalated_at <= pushCutoff);
            const textOk = hasTextBranch && r.channel === 'text' && r.escalated_at == null
              && r.delivered_at != null && boundText && r.delivered_at <= textCutoff;
            return pushOk || textOk;
          }).map((r) => ({
            checkin_id: r.checkin_id, commitment_id: r.commitment_id,
            recurrence: r.recurrence, timezone: r.timezone, local_time: r.local_time,
            channel: r.channel, commitment_status: r.commitment_status,
          }));
          return { results };
        },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}

const USER = 'user-1';

// a text word delivered well before the text window closed, never escalated → a genuine silent miss
const strandedTextOneShot = {
  checkin_id: 'ci-text-silent', commitment_id: 'cm-t1',
  status: 'sent', responded_at: null, escalated_at: null,
  delivered_at: '2026-07-29T16:00:00.000Z', // 2h before NOW; past the 75-min window
  channel: 'text', recurrence: 'none', timezone: 'UTC', local_time: null, commitment_status: 'active',
};
const strandedTextDaily = {
  ...strandedTextOneShot,
  checkin_id: 'ci-text-daily', commitment_id: 'cm-t2',
  recurrence: 'daily', timezone: 'America/New_York', local_time: '08:40',
};
// a text word delivered only 10 min ago — a reply may still be in flight; must NOT be stolen
const inFlightText = {
  checkin_id: 'ci-text-fresh', commitment_id: 'cm-t3',
  status: 'sent', responded_at: null, escalated_at: null,
  delivered_at: new Date(nowMs - 10 * 60 * 1000).toISOString(),
  channel: 'text', recurrence: 'none', timezone: 'UTC', local_time: null, commitment_status: 'active',
};
// the push path, unchanged: escalated then silent past the hour
const strandedPush = {
  checkin_id: 'ci-push-silent', commitment_id: 'cm-p1',
  status: 'sent', responded_at: null,
  escalated_at: '2026-07-29T16:30:00.000Z', delivered_at: '2026-07-29T16:15:00.000Z',
  channel: 'push', recurrence: 'none', timezone: 'UTC', local_time: null, commitment_status: 'active',
};

describe('reconcileStrandedCheckins — the silent miss closes on the TEXT channel too (R-288)', () => {
  it('closes a stranded one-shot TEXT check-in as a no-shame reschedule, streak untouched', async () => {
    const db = makeDB({
      candidates: [strandedTextOneShot],
      streak: { current_streak: 4, longest_streak: 7, total_kept: 12, last_kept_date: '2026-07-28' },
    });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(1);

    const rowUpd = db.runs.find((x) => /UPDATE commitment_checkins/.test(x.sql) && x.params.includes('ci-text-silent'));
    expect(rowUpd).toBeTruthy();
    expect(rowUpd.params).toContain('reschedule'); // never 'missed'
    expect(rowUpd.params).toContain(STRANDED_NOTE);

    // one-shot commitment → "Moved — still on", an open door
    const cUpd = db.runs.find((x) => /UPDATE commitments SET status/.test(x.sql));
    expect(cUpd.params).toContain('rescheduled');

    // streak persisted UNCHANGED — a silent miss never breaks the chain
    const sUpd = db.runs.find((x) => /INSERT INTO accountability_streaks/.test(x.sql));
    expect(sUpd.params).toContain(4);
    expect(sUpd.params).toContain(12);
  });

  it('a recurring TEXT rhythm keeps rolling — its next occurrence materializes', async () => {
    const db = makeDB({ candidates: [strandedTextDaily], existingPending: null });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(1);
    const cUpd = db.runs.find((x) => /UPDATE commitments SET status/.test(x.sql));
    expect(cUpd.params).toContain('active'); // a rhythm is never "done"
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(true);
  });

  it('never steals a text reply still in flight — a row delivered inside the window is left open', async () => {
    const db = makeDB({ candidates: [inFlightText] });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(0);
    expect(db.runs.length).toBe(0); // nothing resolved
  });

  it('the push path is unchanged — a stranded push row still resolves (no regression)', async () => {
    const db = makeDB({ candidates: [strandedPush] });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(1);
    const rowUpd = db.runs.find((x) => /UPDATE commitment_checkins/.test(x.sql) && x.params.includes('ci-push-silent'));
    expect(rowUpd.params).toContain('reschedule');
  });

  it('resolves both channels handed together and reports the total', async () => {
    const db = makeDB({ candidates: [strandedTextOneShot, strandedPush] });
    const out = await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    expect(out.reconciled).toBe(2);
  });

  it('SQL-shape lock: the scan carries the text branch, ASC ordering, and binds the now−75-min text cutoff', async () => {
    const db = makeDB({ candidates: [] });
    await reconcileStrandedCheckins({ DB: db }, USER, { nowISO: NOW });
    const scan = db.queries.find((q) => /FROM commitment_checkins c\s+JOIN commitments m/.test(q.sql) && /escalated_at/.test(q.sql));
    expect(scan).toBeTruthy();
    // the shared guards remain
    expect(scan.sql).toMatch(/c\.status = 'sent'/);
    expect(scan.sql).toMatch(/c\.responded_at IS NULL/);
    expect(scan.sql).toMatch(/m\.status = 'active'/);
    // the text branch: never-escalated, delivered, silent past the text window
    expect(scan.sql).toMatch(/c\.channel = 'text'/);
    expect(scan.sql).toMatch(/c\.escalated_at IS NULL/);
    expect(scan.sql).toMatch(/c\.delivered_at\s+IS NOT NULL/);
    expect(scan.sql).toMatch(/ORDER BY COALESCE\(c\.escalated_at, c\.delivered_at\) ASC/);
    // both cutoffs are bound; the text cutoff is exactly now − STRANDED_TEXT_SILENCE_MIN
    expect(scan.params).toContain(pushCutoff);
    expect(scan.params).toContain(textCutoff);
    expect(STRANDED_TEXT_SILENCE_MIN).toBe(75); // 15-min escalation delay + 60-min post-silence
  });
});
