/**
 * FocusBro — "days you showed up" breadth read (Contender #10, Phase A depth).
 *
 * The person-level standing reads on /me/ already count HOW MANY words (lifetime
 * landmark), crown the tallest single day (best day), name the hour of day (power
 * hours), mark the longest run (personal record), and name WHEN it began (keeping
 * since). None reads the BREADTH of the practice — how many SEPARATE days the
 * person ever showed up. Two accounts with the same kept total read very
 * differently if one batched 40 words across 6 days and another spread them across
 * 35; this names that spread.
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - The count is derived from status='kept' instants ONLY (the route reuses the
 *    all-time kept scan — no miss row is ever read), so every counted day is a day
 *    the person SHOWED UP.
 *  - A quiet day is simply absent from the set — never counted, never subtracted —
 *    so the number can only ever grow. No comparison, no target, no "days since".
 *  - It fires ONLY at SHOWED_UP_DAYS_MIN+ distinct days → a barely-started account
 *    returns '' and nothing shows, never a hollow "1 day", never a zero.
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import { distinctKeptDays } from '../momentum.js';
import {
  showedUpDaysCopy,
  showedUpDaysHeadingCopy,
  showedUpDaysIntroCopy,
  SHOWED_UP_DAYS_MIN,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── the pure breadth counter ─────────────────────────────────
describe('distinctKeptDays — count of distinct local days carrying a kept word', () => {
  it('counts each local calendar day once, regardless of how many words landed that day', () => {
    const ts = [
      '2026-08-15T09:00:00Z', '2026-08-15T18:00:00Z', // same day, twice
      '2026-08-16T10:00:00Z',
      '2026-08-17T11:00:00Z', '2026-08-17T12:00:00Z', '2026-08-17T23:00:00Z',
    ];
    expect(distinctKeptDays({ timestamps: ts, timezone: 'UTC' })).toBe(3);
  });

  it('resolves day boundaries in the given timezone', () => {
    // 01:30Z on Aug 16 is still Aug 15 in New York (UTC-4) → collapses onto the Aug 15 word.
    const ts = ['2026-08-15T20:00:00Z', '2026-08-16T01:30:00Z'];
    expect(distinctKeptDays({ timestamps: ts, timezone: 'America/New_York' })).toBe(1);
    // in UTC those are two different days
    expect(distinctKeptDays({ timestamps: ts, timezone: 'UTC' })).toBe(2);
  });

  it('is garbage-safe: empty, missing, and unparseable instants → a clean count, never a throw', () => {
    expect(distinctKeptDays({ timestamps: [], timezone: 'UTC' })).toBe(0);
    expect(distinctKeptDays({})).toBe(0);
    expect(distinctKeptDays()).toBe(0);
    expect(distinctKeptDays({ timestamps: ['nope', null, undefined, '2026-08-17T09:00:00Z'], timezone: 'UTC' })).toBe(1);
  });
});

// ── the copy ─────────────────────────────────────────────────
describe('showedUpDaysCopy — the warm "you\'ve shown up on N different days" breadth line', () => {
  it('fires with a line naming the count of days the person showed up', () => {
    const line = showedUpDaysCopy({ days: 28 });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line).toContain('28');
    expect(line.toLowerCase()).toContain('shown up');
    // breadth, not a single word or a run
    expect(line.toLowerCase()).toContain('day');
  });

  it('both personas read as coming-through and name the count', () => {
    const ally = showedUpDaysCopy({ days: 12, persona: 'ally' });
    expect(ally).toContain('12');
    expect(ally.toLowerCase()).toContain('came through');
    const hype = showedUpDaysCopy({ days: 40, persona: 'hype' });
    expect(hype).toContain('40');
    expect(hype.toLowerCase()).toContain('came through');
  });

  it('is SILENT below the distinct-day floor — a barely-started account shows nothing', () => {
    for (let d = 0; d < SHOWED_UP_DAYS_MIN; d++) {
      expect(showedUpDaysCopy({ days: d })).toBe('');
    }
    // exactly at the floor it speaks
    expect(showedUpDaysCopy({ days: SHOWED_UP_DAYS_MIN }).length).toBeGreaterThan(0);
  });

  it('is garbage-safe — a missing or unparseable count returns \'\', never a throw', () => {
    expect(showedUpDaysCopy({ days: null })).toBe('');
    expect(showedUpDaysCopy({ days: 'lots' })).toBe('');
    expect(showedUpDaysCopy({})).toBe('');
    expect(showedUpDaysCopy()).toBe('');
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('you only showed up 3 days, you keep failing and falling behind').length).toBeGreaterThan(0);
  });

  it('every days-you-showed-up line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [showedUpDaysHeadingCopy(), showedUpDaysIntroCopy()];
    for (const persona of ['ally', 'hype', 'unknown']) {
      for (const days of [SHOWED_UP_DAYS_MIN, 7, 28, 150, 365]) {
        surface.push(showedUpDaysCopy({ days, persona }));
      }
    }
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a target, a comparison, a decline, a gap-since, or a miss — only the days shown up', () => {
    for (const persona of ['ally', 'hype']) {
      const line = showedUpDaysCopy({ days: 30, persona }).toLowerCase();
      expect(
        /\bgoal\b|\btarget\b|\bonly\b|\bjust\b|\bwas better\b|\bused to\b|\bgap\b|\bdays? since\b|\bmiss|\bbehind\b|\bfail/.test(line),
        line,
      ).toBe(false);
    }
  });
});

// ── route wiring: GET /api/accountability/kept carries `showed_up_days` ──
// Mirrors best-day.test.js / account-keeping-since.test.js: any non-JOIN
// commitment_checkins .all() query returns `windowTimestamps` (so the all-time
// kept scan the breadth read reuses returns them); the streak .first() drives the
// lifetime count; the MIN(responded_at) .first() drives keeping_since.
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
function makeDB({ windowTimestamps = [], streak = null, timezone = null, firstKept = null } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/MIN\(responded_at\)/.test(sql)) return { first_kept: firstKept };
          if (/FROM accountability_streaks/.test(sql)) return streak;
          if (/SELECT timezone FROM commitments/.test(sql)) return timezone ? { timezone } : null;
          return null;
        },
        async all() {
          if (/FROM commitment_checkins/.test(sql) && /JOIN commitments/.test(sql)) return { results: [] };
          if (/FROM commitment_checkins/.test(sql)) return { results: windowTimestamps.map((t) => ({ responded_at: t })) };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}
function buildRouter(db) {
  const router = Router();
  registerAccountabilityRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  return (method, path, { token = 'good' } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    return router.handle(new Request('https://x' + path, { method, headers }), env);
  };
}

describe('GET /api/accountability/kept — showed_up_days rides alongside best day', () => {
  it('returns a non-empty showed_up_days line once the person has 3+ distinct active days', async () => {
    const windowTimestamps = [
      '2026-08-15T09:00:00Z', '2026-08-15T18:00:00Z',
      '2026-08-16T10:00:00Z',
      '2026-08-17T11:00:00Z',
    ]; // 3 distinct UTC days
    const db = makeDB({ windowTimestamps, streak: { total_kept: 4 }, timezone: 'UTC' });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.showed_up_days).toBe('string');
    expect(body.showed_up_days.trim().length).toBeGreaterThan(0);
    expect(body.showed_up_days).toContain('3');
    expect(body.showed_up_days.toLowerCase()).toContain('shown up');
    expect(scanDesignLaw(body.showed_up_days)).toEqual([]);
  });

  it('sends an EMPTY showed_up_days below the distinct-day floor — nothing shows', async () => {
    const windowTimestamps = ['2026-08-16T09:00:00Z', '2026-08-17T10:00:00Z']; // only 2 distinct days
    const db = makeDB({ windowTimestamps, streak: { total_kept: 2 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.showed_up_days).toBe('');
  });

  it('is empty-safe: a brand-new account with no kept history → \'\' (never a blank panel)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.showed_up_days).toBe('');
    expect(res.status).toBe(200);
  });

  it('the breadth count reads from a status=\'kept\' ONLY scan — never a miss series', async () => {
    const db = makeDB({ windowTimestamps: ['2026-08-17T09:00:00Z'], streak: { total_kept: 1 }, timezone: 'UTC' });
    await buildRouter(db)('GET', '/api/accountability/kept');
    const allTimeQuery = db.queries.find((q) => /FROM commitment_checkins/.test(q) && /LIMIT 5000/.test(q));
    expect(allTimeQuery, 'the all-time kept scan ran').toBeTruthy();
    expect(/status = 'kept'/.test(allTimeQuery)).toBe(true);
    expect(/missed/i.test(allTimeQuery)).toBe(false);
  });

  it('401s without a valid token, and never queries the database', async () => {
    const db = makeDB({ windowTimestamps: ['2026-08-17T09:00:00Z'], streak: { total_kept: 1 } });
    const res = await buildRouter(db)('GET', '/api/accountability/kept', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.queries.length).toBe(0);
  });
});
