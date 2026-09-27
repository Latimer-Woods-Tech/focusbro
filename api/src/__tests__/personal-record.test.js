/**
 * FocusBro — the STANDING all-time record (Contender #10, Phase A).
 *
 * The streak card already speaks four ways, but every one of them goes quiet at a
 * fresh start (current_streak === 0): streakSummaryCopy says only "fresh start",
 * and personalBestCopy / milestoneCopy both read the current run, so they return
 * '' the instant a run resets. That leaves the person's genuine best run — a real
 * thing they achieved — completely invisible at the single most shame-prone moment
 * in the product ("I lost my streak"). personalRecordCopy fills exactly that gap:
 * it surfaces the strongest run (longest_streak) as a PERMANENT record, shown only
 * at zero, as reassurance that a reset can never revoke it.
 *
 * It is anti-shame by ARITHMETIC and by GATING:
 *  - longest_streak is monotonic — computeStreakAfter only ever raises it (a miss
 *    resets the run but never lowers the best), so this line, like the lifetime
 *    landmark, can only ever describe a number on the way up.
 *  - It fires ONLY at current_streak === 0, so it never sits beside a live run and
 *    never juxtaposes "your record is N but you're at M" — the decline-comparison
 *    the LAW forbids. At zero there is no current run to compare against; the record
 *    stands alone, a standing achievement, never a gap.
 *
 * This suite pins that gate, the arithmetic guarantee, design-LAW cleanliness, and
 * the clean taxonomy against the other three streak lines, with a proof-of-rejection
 * (Standing Law #1) showing the scanner used here can actually fail.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import {
  personalRecordCopy,
  personalBestCopy,
  milestoneCopy,
  streakSummaryCopy,
  computeStreakAfter,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

describe('personalRecordCopy — the strongest run, held as a permanent record', () => {
  it('fires with a warm, non-empty line at a fresh start (current 0) with a record of 2+', () => {
    for (const best of [2, 3, 7, 14, 30, 100, 365]) {
      const line = personalRecordCopy({ streak: { current_streak: 0, longest_streak: best } });
      expect(typeof line).toBe('string');
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).toContain(String(best)); // names the record it's holding
    }
  });

  it('is SILENT whenever a run is going — it never sits beside a live streak', () => {
    // any current_streak > 0 hides it, whatever the best is (below / at / above).
    for (const [cur, best] of [[1, 30], [5, 30], [30, 30], [2, 2], [12, 40]]) {
      expect(
        personalRecordCopy({ streak: { current_streak: cur, longest_streak: best } }),
        `cur ${cur}, best ${best} must NOT fire`,
      ).toBe('');
    }
  });

  it('is SILENT when there is no record worth naming (best < 2), even at a fresh start', () => {
    expect(personalRecordCopy({ streak: { current_streak: 0, longest_streak: 0 } })).toBe('');
    expect(personalRecordCopy({ streak: { current_streak: 0, longest_streak: 1 } })).toBe('');
  });

  it('is empty/garbage-safe (no streak, missing fields, junk) — never throws, never a blank scold', () => {
    expect(personalRecordCopy()).toBe('');
    expect(personalRecordCopy({})).toBe('');
    expect(personalRecordCopy({ streak: {} })).toBe('');
    expect(personalRecordCopy({ streak: { current_streak: 'x', longest_streak: 'y' } })).toBe('');
    expect(personalRecordCopy({ streak: { longest_streak: null } })).toBe('');
  });

  // ── proof-of-rejection (Standing Law #1): the scanner used below is shown able
  // to FAIL first, so the "clean" assertions that follow are not vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('your best run is gone, you failed again').length).toBeGreaterThan(0);
  });

  it('every record line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    for (const best of [2, 3, 7, 14, 30, 100, 250, 1000]) {
      const line = personalRecordCopy({ streak: { current_streak: 0, longest_streak: best } });
      const violations = scanDesignLaw(line);
      expect(violations, `record ${best}: ${JSON.stringify(line)} → ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('never names a decline, a gap, a comparison-to-now, or a past — it only holds the record', () => {
    for (const best of [2, 7, 30, 100]) {
      const line = personalRecordCopy({ streak: { current_streak: 0, longest_streak: best } }).toLowerCase();
      // no decline/comparison framing, no "was better"/"used to"/"back then", no distance
      expect(
        /\bbut you\b|\byou were\b|\bused to\b|\bback then\b|\bnow at\b|\blower\b|\bbehind\b|\bto go\b|\bleft\b|\bwas better\b/.test(line),
        line,
      ).toBe(false);
    }
  });

  it('ARITHMETIC anti-shame: a miss zeroes the run but NEVER lowers longest_streak — so the record appears exactly AT the reset', () => {
    // A live run at its peak: personalRecordCopy stays silent (a run is going).
    const atPeak = { current_streak: 30, longest_streak: 30, total_kept: 120, last_kept_date: '2026-08-16' };
    expect(personalRecordCopy({ streak: atPeak })).toBe('');
    // The dreaded miss: the run resets to 0, but longest_streak is untouched...
    const afterMiss = computeStreakAfter(atPeak, 'missed', '2026-08-17');
    expect(afterMiss.current_streak).toBe(0);   // the run resets
    expect(afterMiss.longest_streak).toBe(30);  // the record does NOT
    // ...so at the exact moment the person fears they "lost everything", the record
    // line steps in and names the 30 that still stands. This is the load-bearing win.
    const line = personalRecordCopy({ streak: afterMiss });
    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain('30');
    expect(scanDesignLaw(line)).toEqual([]);
  });

  it('a no-shame RESCHEDULE keeps the run protected — so the record stays silent (no reset happened)', () => {
    const run = { current_streak: 4, longest_streak: 9, total_kept: 20, last_kept_date: '2026-08-16' };
    const afterResched = computeStreakAfter(run, 'reschedule', '2026-08-17');
    expect(afterResched.current_streak).toBe(4); // protected, no reset
    expect(personalRecordCopy({ streak: afterResched })).toBe(''); // a run is still going
  });

  it('slots cleanly into the streak taxonomy — exactly one of {record, best, summary-inline} owns any given state', () => {
    // (a) at a fresh start with a record: personalRecordCopy owns it; personalBest/milestone are silent.
    const fresh = { current_streak: 0, longest_streak: 30 };
    expect(personalRecordCopy({ streak: fresh }).length).toBeGreaterThan(0);
    expect(personalBestCopy({ streak: fresh })).toBe('');
    expect(milestoneCopy({ streak: fresh })).toBe('');

    // (b) at the all-time peak: personalBestCopy owns it; personalRecordCopy is silent (a run is going).
    const peak = { current_streak: 30, longest_streak: 30 };
    expect(personalBestCopy({ streak: peak }).length).toBeGreaterThan(0);
    expect(personalRecordCopy({ streak: peak })).toBe('');

    // (c) climbing back below the best: streakSummaryCopy narrates the best inline; record stays silent (no double-mention).
    const climbing = { current_streak: 5, longest_streak: 30 };
    expect(streakSummaryCopy({ streak: climbing })).toContain('30');
    expect(personalRecordCopy({ streak: climbing })).toBe('');
  });
});

// ── route wiring: the streak endpoint carries `record` alongside best/milestone/landmark.
// Mirrors kept-total-landmark.test.js — the real route through itty-router with an
// in-memory D1 double whose accountability_streaks row is what loadStreak reads.
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (request) => {
    const h = request.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (token) => (token === 'good' ? { sub: 'u1' } : null),
  jsonResponse,
  generateUUID,
};
function makeDB(streak) {
  return {
    prepare(sql) {
      const stmt = {
        bind() { return stmt; },
        async first() { return /FROM accountability_streaks/.test(sql) ? streak : null; },
        async all() { return { results: [] }; },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
}
function callStreak(streak, { token = 'good' } = {}) {
  const router = Router();
  registerAccountabilityRoutes(router, ctx);
  const env = { DB: makeDB(streak), JWT_SECRET: 'test' };
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  return router.handle(new Request('https://x/api/accountability/streak', { method: 'GET', headers }), env);
}

describe('GET /api/accountability/streak — the standing record rides alongside best + milestone + landmark', () => {
  it('returns a non-empty record at a fresh start with a best run of 2+', async () => {
    const res = await callStreak({ current_streak: 0, longest_streak: 30, total_kept: 120, last_kept_date: '2026-08-16' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.record).toBe('string');
    expect(body.record.trim().length).toBeGreaterThan(0);
    expect(body.record).toContain('30');
    // the other celebrations still resolve (independent fields, never dropped)
    expect('best' in body && 'milestone' in body && 'landmark' in body).toBe(true);
    expect(scanDesignLaw(body.record)).toEqual([]);
  });

  it('returns an EMPTY record while a run is going (the card simply hides it — never beside a live streak)', async () => {
    const res = await callStreak({ current_streak: 5, longest_streak: 30, total_kept: 120, last_kept_date: '2026-08-16' });
    const body = await res.json();
    expect(body.record).toBe('');
  });

  it('is empty-safe when the user has no streak row yet (best defaults to 0 → no record)', async () => {
    const res = await callStreak(null);
    const body = await res.json();
    expect(body.record).toBe('');
    expect(body.streak.longest_streak).toBe(0);
  });

  it('401s without a valid token', async () => {
    const res = await callStreak({ current_streak: 0, longest_streak: 30 }, { token: 'bad' });
    expect(res.status).toBe(401);
  });
});
