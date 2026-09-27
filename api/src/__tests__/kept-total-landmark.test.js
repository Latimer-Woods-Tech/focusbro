/**
 * FocusBro — lifetime kept-word landmark (Contender #10, Phase A).
 *
 * The streak card already celebrates the current RUN — streakSummaryCopy (the
 * running count), personalBestCopy (at your all-time peak), milestoneCopy (the run
 * is exactly at 3/7/14/30/100). But ALL THREE read `current_streak`, which a single
 * miss silently resets to zero. Nothing celebrated the one number that can NEVER
 * decline: the lifetime `total_kept`. This slice adds that celebration —
 * keptTotalLandmarkCopy — the mark for the cumulative count of every word you have
 * EVER kept crossing a landmark (10/25/50/100/250/500/1000).
 *
 * It is anti-shame not just by wording but by ARITHMETIC: total_kept only ever
 * increments (a miss resets the run but never touches the lifetime total — see
 * computeStreakAfter), so this line can only ever appear on the way UP, and no
 * reset can take a reached landmark away. This suite pins that guarantee: the copy
 * fires ONLY exactly at a landmark, is '' everywhere between (so it can never nag),
 * is design-LAW clean, and never references a gap or a distance-to-next.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import {
  keptTotalLandmarkCopy,
  KEPT_TOTAL_LANDMARKS,
  computeStreakAfter,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

describe('keptTotalLandmarkCopy — the lifetime count that only ever grows', () => {
  it('fires with a warm, non-empty line at EXACTLY each landmark total', () => {
    for (const n of KEPT_TOTAL_LANDMARKS) {
      const line = keptTotalLandmarkCopy({ streak: { total_kept: n } });
      expect(typeof line).toBe('string');
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).toContain(String(n)); // names the count reached
      expect(line.toLowerCase()).toContain('all-time'); // it's the LIFETIME mark, not the run
    }
  });

  it('is EMPTY between landmarks — proof it is a moment marker, never a running nag', () => {
    // A spread straddling every landmark boundary, plus zero/one.
    for (const n of [0, 1, 9, 11, 24, 26, 49, 51, 99, 101, 249, 251, 499, 501, 999, 1001, 2000]) {
      expect(keptTotalLandmarkCopy({ streak: { total_kept: n } }), `total ${n} must NOT fire`).toBe('');
    }
  });

  it('is empty/garbage-safe (no streak, missing total, junk) — never throws, never a blank scold', () => {
    expect(keptTotalLandmarkCopy()).toBe('');
    expect(keptTotalLandmarkCopy({})).toBe('');
    expect(keptTotalLandmarkCopy({ streak: {} })).toBe('');
    expect(keptTotalLandmarkCopy({ streak: { total_kept: 'nonsense' } })).toBe('');
    expect(keptTotalLandmarkCopy({ streak: { total_kept: null } })).toBe('');
  });

  // ── proof-of-rejection (Standing Law #1): the design-LAW scanner used below is
  // shown able to FAIL, then every landmark line is shown to pass it clean.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('you failed again, this is pathetic').length).toBeGreaterThan(0);
  });

  it('every landmark line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    for (const n of KEPT_TOTAL_LANDMARKS) {
      const line = keptTotalLandmarkCopy({ streak: { total_kept: n } });
      const violations = scanDesignLaw(line);
      expect(violations, `landmark ${n}: ${JSON.stringify(line)} → ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('never names a gap, a distance-to-next, or a past — it only celebrates the count reached', () => {
    for (const n of KEPT_TOTAL_LANDMARKS) {
      const line = keptTotalLandmarkCopy({ streak: { total_kept: n } }).toLowerCase();
      // no "N to go" / "N left" / "N until" / distance framing, no "was"/"used to" past framing
      expect(/\bto go\b|\bleft\b|\buntil\b|\baway\b|\bmore to\b|\bused to\b|\bwas better\b/.test(line), line).toBe(false);
    }
  });

  it('ARITHMETIC anti-shame: a miss resets the run but NEVER lowers the lifetime total that this line reads', () => {
    // At a landmark, a subsequent miss zeroes current_streak — but total_kept (what
    // this line reads) is untouched, so a reached landmark can never be revoked.
    const atLandmark = { current_streak: 5, longest_streak: 9, total_kept: 100, last_kept_date: '2026-08-16' };
    expect(keptTotalLandmarkCopy({ streak: atLandmark }).length).toBeGreaterThan(0);
    const afterMiss = computeStreakAfter(atLandmark, 'missed', '2026-08-17');
    expect(afterMiss.current_streak).toBe(0);       // the run resets
    expect(afterMiss.total_kept).toBe(100);         // the lifetime total does NOT
    expect(keptTotalLandmarkCopy({ streak: afterMiss }).length).toBeGreaterThan(0); // landmark survives the miss
  });

  it('is independent of the current run — it fires on total alone, whatever the streak is doing', () => {
    // total exactly 100 fires regardless of current_streak (fresh reset OR a long run).
    expect(keptTotalLandmarkCopy({ streak: { total_kept: 100, current_streak: 0 } }).length).toBeGreaterThan(0);
    expect(keptTotalLandmarkCopy({ streak: { total_kept: 100, current_streak: 100 } }).length).toBeGreaterThan(0);
    // and a big current run at a NON-landmark total stays silent (it's a total mark, not a run mark).
    expect(keptTotalLandmarkCopy({ streak: { total_kept: 87, current_streak: 87 } })).toBe('');
  });

  it('exposes a sane, ascending lifetime ladder distinct from the streak milestones', () => {
    expect(KEPT_TOTAL_LANDMARKS).toEqual([10, 25, 50, 100, 250, 500, 1000]);
    const sorted = [...KEPT_TOTAL_LANDMARKS].sort((a, b) => a - b);
    expect(KEPT_TOTAL_LANDMARKS).toEqual(sorted); // strictly ascending, as authored
  });
});

// ── route wiring: the streak endpoint carries the landmark alongside best/milestone
// The harness mirrors kept-log.test.js: the real route through itty-router with an
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

describe('GET /api/accountability/streak — the landmark rides alongside best + milestone', () => {
  it('returns a non-empty landmark exactly at a lifetime landmark total', async () => {
    const res = await callStreak({ current_streak: 4, longest_streak: 30, total_kept: 100, last_kept_date: '2026-08-16' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.landmark).toBe('string');
    expect(body.landmark.trim().length).toBeGreaterThan(0);
    expect(body.landmark).toContain('100');
    // the other two celebrations still resolve (independent fields, never dropped)
    expect('best' in body && 'milestone' in body).toBe(true);
    expect(scanDesignLaw(body.landmark)).toEqual([]);
  });

  it('returns an EMPTY landmark between landmarks (the card simply hides it — never a nag)', async () => {
    const res = await callStreak({ current_streak: 4, longest_streak: 30, total_kept: 87, last_kept_date: '2026-08-16' });
    const body = await res.json();
    expect(body.landmark).toBe('');
  });

  it('is empty-safe when the user has no streak row yet (total defaults to 0 → no landmark)', async () => {
    const res = await callStreak(null);
    const body = await res.json();
    expect(body.landmark).toBe('');
    expect(body.streak.total_kept).toBe(0);
  });

  it('401s without a valid token', async () => {
    const res = await callStreak({ total_kept: 100 }, { token: 'bad' });
    expect(res.status).toBe(401);
  });
});
