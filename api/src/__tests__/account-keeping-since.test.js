/**
 * FocusBro — account-level "keeping your word since …" anchor (Contender #10, Phase A depth).
 *
 * The per-word "kept since" (per-word-kept-since.test.js) names how long ONE word
 * has been a practice. This is the same longevity read one level up, on /me/: the
 * day the person kept their VERY FIRST word here, across ALL their commitments —
 * a standing anchor for the whole account. Where the lifetime landmark counts HOW
 * MANY and the best day crowns the tallest single day, this names WHEN it began.
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - It reads the FIRST status='kept' instant ONLY (the route's MIN is over kept
 *    rows — no miss row is ever read or surfaced), so it can only ever anchor to a
 *    day the person SHOWED UP.
 *  - It is a standing fact that only ages forward — a quiet stretch or a reset
 *    never moves the "since" date or erases the practice.
 *  - It fires ONLY once there's a real practice (ACCOUNT_SINCE_MIN_COUNT+ lifetime
 *    kept AND ACCOUNT_SINCE_MIN_DAYS+ of history) → a young or thin account returns
 *    '' and nothing shows, never a "since today", never a "0 days". Below the count
 *    floor the route never even runs the first-kept query.
 *  - The copy frames the span as a practice being built, never a lapse, a
 *    gap-since, a comparison, or a miss.
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import { calendarDaysAgo } from '../momentum.js';
import {
  keepingSinceCopy,
  keepingSinceHeadingCopy,
  keepingSinceIntroCopy,
  ACCOUNT_SINCE_MIN_COUNT,
  ACCOUNT_SINCE_MIN_DAYS,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── the copy ─────────────────────────────────────────────────
describe('keepingSinceCopy — the warm account-level "you\'ve been keeping your word since …" anchor', () => {
  const NOW = '2026-08-17T12:00:00Z';
  const OLD = '2026-07-08T14:00:00Z'; // 40 days back — a standing practice

  it('fires with a line naming the day the practice began, across all words', () => {
    const line = keepingSinceCopy({ firstKeptISO: OLD, count: 6, nowISO: NOW, timezone: 'UTC' });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line.toLowerCase()).toContain('since');
    expect(line).toContain('Jul 8');
    // it is account-wide, not about one word — never says "this one"
    expect(line.toLowerCase()).not.toContain('this one');
    expect(line.toLowerCase()).toContain('your word');
  });

  it('both personas read as a practice being built and name the day', () => {
    const ally = keepingSinceCopy({ firstKeptISO: OLD, count: 12, nowISO: NOW, timezone: 'UTC', persona: 'ally' });
    expect(ally.toLowerCase()).toContain('practice');
    expect(ally).toContain('Jul 8');
    const hype = keepingSinceCopy({ firstKeptISO: OLD, count: 40, nowISO: NOW, timezone: 'UTC', persona: 'hype' });
    expect(hype.toLowerCase()).toContain('practice');
    expect(hype.toLowerCase()).toContain('since');
  });

  it('is SILENT below the count floor — a barely-started account shows nothing', () => {
    for (let c = 0; c < ACCOUNT_SINCE_MIN_COUNT; c++) {
      expect(keepingSinceCopy({ firstKeptISO: OLD, count: c, nowISO: NOW, timezone: 'UTC' })).toBe('');
    }
    // exactly at the floor, with enough history, it speaks
    expect(keepingSinceCopy({ firstKeptISO: OLD, count: ACCOUNT_SINCE_MIN_COUNT, nowISO: NOW, timezone: 'UTC' }).length)
      .toBeGreaterThan(0);
  });

  it('is SILENT below the span floor — a fresh account never reads "since today"', () => {
    const young = '2026-08-16T09:00:00Z'; // 1 day back
    expect(keepingSinceCopy({ firstKeptISO: young, count: 20, nowISO: NOW, timezone: 'UTC' })).toBe('');
    const dayBeforeFloor = '2026-08-11T09:00:00Z'; // 6 days back (< 7)
    expect(keepingSinceCopy({ firstKeptISO: dayBeforeFloor, count: 20, nowISO: NOW, timezone: 'UTC' })).toBe('');
    const atFloor = '2026-08-10T09:00:00Z'; // exactly 7 days back
    expect(calendarDaysAgo(atFloor, { nowISO: NOW, timezone: 'UTC' })).toBe(ACCOUNT_SINCE_MIN_DAYS);
    expect(keepingSinceCopy({ firstKeptISO: atFloor, count: 20, nowISO: NOW, timezone: 'UTC' }).length).toBeGreaterThan(0);
  });

  it('resolves the anchor day in the recipient timezone, and pins a prior year', () => {
    // 01:30Z on Jul 9 is still Jul 8 in New York (UTC-4 in July).
    const ny = keepingSinceCopy({ firstKeptISO: '2026-07-09T01:30:00Z', count: 9, nowISO: NOW, timezone: 'America/New_York' });
    expect(ny).toContain('Jul 8');
    // a first-kept in a prior year names the year so it can't read as this year
    const priorYear = keepingSinceCopy({ firstKeptISO: '2025-11-20T09:00:00Z', count: 120, nowISO: NOW, timezone: 'UTC' });
    expect(priorYear).toContain('Nov 20, 2025');
  });

  it('is garbage-safe — a missing or unparseable anchor returns \'\', never a throw', () => {
    expect(keepingSinceCopy({ firstKeptISO: null, count: 9, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(keepingSinceCopy({ firstKeptISO: 'not-a-date', count: 9, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(keepingSinceCopy({ count: 9 })).toBe('');
    expect(keepingSinceCopy({})).toBe('');
    expect(keepingSinceCopy()).toBe('');
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('you keep failing and falling behind since day one').length).toBeGreaterThan(0);
  });

  it('every keeping-since line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [keepingSinceHeadingCopy(), keepingSinceIntroCopy()];
    for (const persona of ['ally', 'hype', 'unknown']) {
      for (const spec of [
        { firstKeptISO: OLD, count: 5 }, { firstKeptISO: OLD, count: 50 },
        { firstKeptISO: '2025-11-20T09:00:00Z', count: 300 }, // prior-year anchor
        { firstKeptISO: '2026-08-10T09:00:00Z', count: 6 },   // exactly at the span floor
      ]) surface.push(keepingSinceCopy({ ...spec, nowISO: NOW, timezone: 'UTC', persona }));
    }
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a lapse, a gap-since, a comparison, or a decline — only the practice', () => {
    for (const persona of ['ally', 'hype']) {
      const line = keepingSinceCopy({ firstKeptISO: OLD, count: 30, nowISO: NOW, timezone: 'UTC', persona }).toLowerCase();
      expect(
        /\bgap\b|\blapse\b|\bwas better\b|\bused to\b|\bnot anymore\b|\bslipp|\bbehind\b|\bdays? since you\b|\bhaven.?t\b/.test(line),
        line,
      ).toBe(false);
    }
  });
});

// ── route wiring: GET /api/accountability/kept carries `keeping_since` ──
// Mirrors best-day.test.js's double: any non-JOIN commitment_checkins .all() query
// returns `windowTimestamps`; the new MIN(responded_at) .first() query returns the
// controlled `firstKept`; the streak .first() drives the lifetime count.
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
// A first-kept anchored relative to the REAL clock the route uses, so the span gate
// is deterministic regardless of when the suite runs.
const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString();

describe('GET /api/accountability/kept — keeping_since rides alongside best day', () => {
  it('returns a non-empty keeping_since line for a standing practice (5+ lifetime kept, a week+ back)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: { total_kept: 8 }, timezone: 'UTC', firstKept: daysAgoISO(40) });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.keeping_since).toBe('string');
    expect(body.keeping_since.trim().length).toBeGreaterThan(0);
    expect(body.keeping_since.toLowerCase()).toContain('since');
    expect(scanDesignLaw(body.keeping_since)).toEqual([]);
  });

  it('sends an EMPTY keeping_since for a YOUNG account (first kept only a day ago) — nothing shows', async () => {
    const db = makeDB({ windowTimestamps: [], streak: { total_kept: 20 }, timezone: 'UTC', firstKept: daysAgoISO(2) });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.keeping_since).toBe('');
  });

  it('sends an EMPTY keeping_since below the count floor AND never runs the first-kept query', async () => {
    const db = makeDB({ windowTimestamps: [], streak: { total_kept: ACCOUNT_SINCE_MIN_COUNT - 1 }, timezone: 'UTC', firstKept: daysAgoISO(40) });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.keeping_since).toBe('');
    expect(db.queries.some((q) => /MIN\(responded_at\)/.test(q))).toBe(false);
  });

  it('is empty-safe: a brand-new account with no streak → \'\' (never a blank panel)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.keeping_since).toBe('');
    expect(res.status).toBe(200);
  });

  it('the first-kept read is status=\'kept\' ONLY — never a miss series', async () => {
    const db = makeDB({ windowTimestamps: [], streak: { total_kept: 8 }, timezone: 'UTC', firstKept: daysAgoISO(40) });
    await buildRouter(db)('GET', '/api/accountability/kept');
    const firstKeptQuery = db.queries.find((q) => /MIN\(responded_at\)/.test(q));
    expect(firstKeptQuery, 'the first-kept query ran').toBeTruthy();
    expect(/status = 'kept'/.test(firstKeptQuery)).toBe(true);
    expect(/missed/i.test(firstKeptQuery)).toBe(false);
  });

  it('401s without a valid token, and never queries the database', async () => {
    const db = makeDB({ windowTimestamps: [], streak: { total_kept: 8 }, firstKept: daysAgoISO(40) });
    const res = await buildRouter(db)('GET', '/api/accountability/kept', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.queries.length).toBe(0);
  });
});
