/**
 * FocusBro — per-word "kept since" longevity anchor (Contender #10, Phase A depth).
 *
 * The per-word momentum sparkline shows the recent shape and the best-day callout
 * names the peak; neither says how LONG a word has been a practice. This adds that
 * read to the detail panel: the day you FIRST kept this word, so a long-standing
 * rhythm reads as the practice it is ("keeping this since Jul 8") rather than a
 * bare count.
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - It reads the FIRST status='kept' instant ONLY (the route's MIN is over kept
 *    rows — no miss row is ever read or surfaced), so it can only ever anchor to a
 *    day the person SHOWED UP. The detail flow selects no miss anywhere.
 *  - It is a standing fact that only ages forward — a quiet stretch or a reset
 *    never moves the "since" date or erases the practice.
 *  - It fires ONLY once the word is a real practice (KEPT_SINCE_MIN_COUNT+ kept AND
 *    KEPT_SINCE_MIN_DAYS+ of history) → a young or thin word returns '' and nothing
 *    shows, never a "since today", never a "0 days".
 *  - The copy frames the span as a practice being built, never a lapse, a gap
 *    since, a comparison, or a miss.
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import { formatCalendarDay, calendarDaysAgo } from '../momentum.js';
import {
  keptSinceCopy,
  KEPT_SINCE_MIN_COUNT,
  KEPT_SINCE_MIN_DAYS,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── the pure date helpers ────────────────────────────────────
describe('formatCalendarDay — the absolute day, for a far-back anchor', () => {
  const NOW = '2026-08-17T12:00:00Z';

  it('names the day without a year when it falls in the current local year', () => {
    expect(formatCalendarDay('2026-07-08T14:00:00Z', { nowISO: NOW, timezone: 'UTC' })).toBe('Jul 8');
    expect(formatCalendarDay('2026-01-01T00:30:00Z', { nowISO: NOW, timezone: 'UTC' })).toBe('Jan 1');
  });

  it('pins the year when the anchor is in a DIFFERENT year (never reads as this year)', () => {
    expect(formatCalendarDay('2025-11-20T09:00:00Z', { nowISO: NOW, timezone: 'UTC' })).toBe('Nov 20, 2025');
  });

  it('resolves the day boundary in the given timezone', () => {
    // 01:30Z on Jul 9 is still Jul 8 in New York (UTC-4 in July).
    expect(formatCalendarDay('2026-07-09T01:30:00Z', { nowISO: NOW, timezone: 'America/New_York' })).toBe('Jul 8');
  });

  it('is garbage-safe — \'\' for an unparseable instant, never a throw', () => {
    expect(formatCalendarDay('not-a-date', { nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(formatCalendarDay(null, { nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(formatCalendarDay(undefined)).toBe('');
  });
});

describe('calendarDaysAgo — whole local days between an instant and today', () => {
  const NOW = '2026-08-17T12:00:00Z';

  it('counts today as 0, yesterday as 1, and older days by whole calendar days', () => {
    expect(calendarDaysAgo('2026-08-17T00:05:00Z', { nowISO: NOW, timezone: 'UTC' })).toBe(0);
    expect(calendarDaysAgo('2026-08-16T23:00:00Z', { nowISO: NOW, timezone: 'UTC' })).toBe(1);
    expect(calendarDaysAgo('2026-08-07T09:00:00Z', { nowISO: NOW, timezone: 'UTC' })).toBe(10);
  });

  it('is DST-agnostic across a span (calendar-label math, not elapsed hours)', () => {
    // A span that crosses the US spring-forward transition still counts whole days.
    expect(calendarDaysAgo('2026-03-01T12:00:00Z', { nowISO: '2026-04-01T12:00:00Z', timezone: 'America/New_York' })).toBe(31);
  });

  it('is negative for a future day and null for garbage', () => {
    expect(calendarDaysAgo('2026-08-20T09:00:00Z', { nowISO: NOW, timezone: 'UTC' })).toBe(-3);
    expect(calendarDaysAgo('nope', { nowISO: NOW, timezone: 'UTC' })).toBeNull();
    expect(calendarDaysAgo(null)).toBeNull();
  });
});

// ── the copy ─────────────────────────────────────────────────
describe('keptSinceCopy — the warm "you\'ve been keeping this since …" anchor', () => {
  const NOW = '2026-08-17T12:00:00Z';
  const OLD = '2026-07-08T14:00:00Z'; // 40 days back — a standing practice

  it('fires with a line naming the day the practice began', () => {
    const line = keptSinceCopy({ firstKeptISO: OLD, count: 5, nowISO: NOW, timezone: 'UTC' });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line.toLowerCase()).toContain('since');
    expect(line).toContain('Jul 8');
  });

  it('the hype persona names the count and stays warm; the ally persona reads as a practice', () => {
    const hype = keptSinceCopy({ firstKeptISO: OLD, count: 7, nowISO: NOW, timezone: 'UTC', persona: 'hype' });
    expect(hype).toContain('7');
    expect(hype.toLowerCase()).toContain('since');
    const ally = keptSinceCopy({ firstKeptISO: OLD, count: 7, nowISO: NOW, timezone: 'UTC', persona: 'ally' });
    expect(ally.toLowerCase()).toContain('practice');
  });

  it('is SILENT below the count floor — a word kept only a couple of times shows nothing', () => {
    for (let c = 0; c < KEPT_SINCE_MIN_COUNT; c++) {
      expect(keptSinceCopy({ firstKeptISO: OLD, count: c, nowISO: NOW, timezone: 'UTC' })).toBe('');
    }
    // exactly at the floor, with enough history, it speaks
    expect(keptSinceCopy({ firstKeptISO: OLD, count: KEPT_SINCE_MIN_COUNT, nowISO: NOW, timezone: 'UTC' }).length)
      .toBeGreaterThan(0);
  });

  it('is SILENT below the span floor — a young word never reads "since today"', () => {
    const young = '2026-08-16T09:00:00Z'; // 1 day back
    expect(keptSinceCopy({ firstKeptISO: young, count: 9, nowISO: NOW, timezone: 'UTC' })).toBe('');
    // a day short of the floor is still silent; the floor itself speaks
    const dayBeforeFloor = '2026-08-11T09:00:00Z'; // 6 days back (< 7)
    expect(keptSinceCopy({ firstKeptISO: dayBeforeFloor, count: 9, nowISO: NOW, timezone: 'UTC' })).toBe('');
    const atFloor = '2026-08-10T09:00:00Z'; // exactly 7 days back
    expect(calendarDaysAgo(atFloor, { nowISO: NOW, timezone: 'UTC' })).toBe(KEPT_SINCE_MIN_DAYS);
    expect(keptSinceCopy({ firstKeptISO: atFloor, count: 9, nowISO: NOW, timezone: 'UTC' }).length).toBeGreaterThan(0);
  });

  it('is garbage-safe — a missing or unparseable anchor returns \'\', never a throw', () => {
    expect(keptSinceCopy({ firstKeptISO: null, count: 5, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(keptSinceCopy({ firstKeptISO: 'not-a-date', count: 5, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(keptSinceCopy({ count: 5 })).toBe('');
    expect(keptSinceCopy({})).toBe('');
    expect(keptSinceCopy()).toBe('');
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('you keep failing this one and falling behind since day one').length).toBeGreaterThan(0);
  });

  it('every kept-since line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [];
    for (const persona of ['ally', 'hype', 'unknown']) {
      for (const spec of [
        { firstKeptISO: OLD, count: 3 }, { firstKeptISO: OLD, count: 12 },
        { firstKeptISO: '2025-11-20T09:00:00Z', count: 40 }, // prior-year anchor
        { firstKeptISO: '2026-08-10T09:00:00Z', count: 3 },  // exactly at the span floor
      ]) surface.push(keptSinceCopy({ ...spec, nowISO: NOW, timezone: 'UTC', persona }));
    }
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a lapse, a gap-since, a comparison, or a decline — only the practice', () => {
    for (const persona of ['ally', 'hype']) {
      const line = keptSinceCopy({ firstKeptISO: OLD, count: 8, nowISO: NOW, timezone: 'UTC', persona }).toLowerCase();
      expect(
        /\bgap\b|\blapse\b|\bwas better\b|\bused to\b|\bnot anymore\b|\bslipp|\bbehind\b|\bdays? since you\b|\bhaven.?t\b/.test(line),
        line,
      ).toBe(false);
    }
  });
});

// ── route wiring: GET /api/commitments/:id/detail carries `kept_since` ──
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
// In-memory D1 double for the detail route. Distinguishes the queries the route
// runs, adding the new first-kept MIN over status='kept'.
function makeDB({ commitment = null, kept = [], keptCount = 0, next = null, firstKept = null } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM commitments\b/.test(sql)) return commitment;
          if (/MIN\(responded_at\)/.test(sql)) return { first_kept: firstKept };
          if (/COUNT\(\*\)/.test(sql)) return { n: keptCount };
          if (/scheduled_for\b/.test(sql) && /status IN/.test(sql)) return next;
          return null;
        },
        async all() {
          if (/responded_at AS kept_at/.test(sql)) return { results: kept };
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
const ACTIVE = {
  id: 'c1', title: 'morning pages', details: '', start_at: '2026-07-01T14:00:00Z',
  checkin_at: '2026-07-01T15:00:00Z', channel: 'text', persona: 'ally', timezone: 'UTC',
  recurrence: 'daily', local_time: '14:00', status: 'active', created_at: '2026-07-01T00:00:00Z',
};
// Anchor relative to the REAL clock the route uses, so the span gate is deterministic.
const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString();

describe('GET /api/commitments/:id/detail — kept_since rides alongside momentum', () => {
  it('returns a non-empty kept_since line for a standing practice (3+ kept, a week+ back)', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [{ kept_at: daysAgoISO(1), note: '' }], keptCount: 5, firstKept: daysAgoISO(40) });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.kept_since).toBe('string');
    expect(body.kept_since.trim().length).toBeGreaterThan(0);
    expect(body.kept_since.toLowerCase()).toContain('since');
    expect(scanDesignLaw(body.kept_since)).toEqual([]);
  });

  it('sends an EMPTY kept_since for a YOUNG word (first kept only a day ago) — nothing shows', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [{ kept_at: daysAgoISO(1), note: '' }], keptCount: 9, firstKept: daysAgoISO(2) });
    const body = await (await buildRouter(db)('GET', '/api/commitments/c1/detail')).json();
    expect(body.kept_since).toBe('');
  });

  it('sends an EMPTY kept_since for a THIN word (kept only twice), even if long ago', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [{ kept_at: daysAgoISO(30), note: '' }], keptCount: 2, firstKept: daysAgoISO(40) });
    const body = await (await buildRouter(db)('GET', '/api/commitments/c1/detail')).json();
    expect(body.kept_since).toBe('');
  });

  it('a never-yet-kept word sends \'\' AND never runs the first-kept query (nothing to anchor to)', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [], keptCount: 0 });
    const body = await (await buildRouter(db)('GET', '/api/commitments/c1/detail')).json();
    expect(body.kept_since).toBe('');
    expect(db.queries.some((q) => /MIN\(responded_at\)/.test(q))).toBe(false);
  });

  it('the first-kept read is status=\'kept\' ONLY — and the whole detail flow selects no miss', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [{ kept_at: daysAgoISO(1), note: '' }], keptCount: 5, firstKept: daysAgoISO(40) });
    await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const firstKeptQuery = db.queries.find((q) => /MIN\(responded_at\)/.test(q));
    expect(firstKeptQuery, 'the first-kept query ran').toBeTruthy();
    expect(/status = 'kept'/.test(firstKeptQuery)).toBe(true);
    // The DESIGN LAW at the query: nothing in the detail flow selects a miss.
    for (const q of db.queries) expect(/'missed'/.test(q), `query selected a miss: ${q}`).toBe(false);
  });

  it('401s without a valid token, and never queries the database', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [], keptCount: 5, firstKept: daysAgoISO(40) });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.queries.length).toBe(0);
  });
});
