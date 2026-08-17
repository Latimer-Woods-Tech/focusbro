/**
 * FocusBro — your all-time best day (Contender #10, Phase A depth).
 *
 * The per-day momentum sparkline shows the last two weeks; power hours show the
 * time of day; the per-word detail view has its own best day. None of them could
 * answer "the most I ever kept across ALL my words in ONE day". This does — a
 * standing record crowned from the person's full status='kept' history.
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - It reads a status='kept' histogram ONLY (the route query is kept-only, no
 *    date cutoff), so it can only ever crown a day the person SHOWED UP — there is
 *    no "worst day" or "days you kept nothing" anywhere in the module.
 *  - It is a record that only ever climbs: a past kept day never disappears, so no
 *    reset, miss, or quiet stretch can lower the number it names.
 *  - It fires ONLY when a day clears BEST_DAY_MIN_COUNT — a thin history returns
 *    null → '' → the card stays hidden, never a hollow "your best day: 1".
 *  - The copy frames the day as a standing high-water mark, never a bar to clear,
 *    a comparison to today, or a decline.
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import { allTimeBestDay, BEST_DAY_MIN_COUNT } from '../momentum.js';
import {
  bestDayCopy,
  bestDayHeadingCopy,
  bestDayIntroCopy,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── the pure engine: the single most-kept local day ──────────
describe('allTimeBestDay — the day you kept the most words, ever', () => {
  it('crowns the single tallest local day and counts every kept instant on it', () => {
    const best = allTimeBestDay({
      timestamps: [
        '2026-07-02T09:00:00Z', '2026-07-02T13:00:00Z', '2026-07-02T20:00:00Z', // 3 on Jul 2
        '2026-07-05T10:00:00Z', '2026-07-05T11:00:00Z',                          // 2 on Jul 5
        '2026-07-09T14:00:00Z',                                                  // 1 on Jul 9
      ],
      timezone: 'UTC',
    });
    expect(best).toEqual({ date: '2026-07-02', count: 3 });
  });

  it('on a TIE for the top count, names the MOST RECENT such day (never an older ghost)', () => {
    const best = allTimeBestDay({
      timestamps: [
        '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z', // 2 on the older day
        '2026-08-14T09:00:00Z', '2026-08-14T10:00:00Z', // 2 on the newer day — same count
      ],
      timezone: 'UTC',
    });
    expect(best).toEqual({ date: '2026-08-14', count: 2 });
  });

  it('is null below the floor — a history of only single-kept days gets no "best day"', () => {
    const best = allTimeBestDay({
      timestamps: ['2026-07-02T09:00:00Z', '2026-07-05T10:00:00Z', '2026-07-09T14:00:00Z'],
      timezone: 'UTC',
    });
    expect(best).toBeNull();
    expect(BEST_DAY_MIN_COUNT).toBeGreaterThan(1);
  });

  it('is DST-correct and timezone-aware: the same instants can regroup across midnight', () => {
    // Three instants clustered around a UTC midnight boundary.
    const timestamps = ['2026-08-14T01:00:00Z', '2026-08-14T02:00:00Z', '2026-08-14T23:00:00Z'];
    // UTC: all three fall on Aug 14 → a 3-count best day.
    expect(allTimeBestDay({ timestamps, timezone: 'UTC' })).toEqual({ date: '2026-08-14', count: 3 });
    // America/New_York (UTC-4 in Aug): 01:00 & 02:00 → Aug 13 (21:00/22:00), 23:00 → Aug 14 (19:00).
    // Aug 13 now holds 2, Aug 14 holds 1 → best day shifts to Aug 13 with count 2.
    expect(allTimeBestDay({ timestamps, timezone: 'America/New_York' })).toEqual({ date: '2026-08-13', count: 2 });
  });

  it('is empty/garbage-safe — no throw, null when there is nothing to crown', () => {
    for (const input of [undefined, {}, { timestamps: [] }, { timestamps: 'x' }]) {
      expect(allTimeBestDay(input)).toBeNull();
    }
    // unparseable instants are dropped, not counted
    const best = allTimeBestDay({ timestamps: ['junk', null, '2026-07-02T09:00:00Z', '2026-07-02T10:00:00Z'], timezone: 'UTC' });
    expect(best).toEqual({ date: '2026-07-02', count: 2 });
  });
});

// ── the copy ─────────────────────────────────────────────────
describe('bestDayCopy — the warm "your best day so far" record', () => {
  const NOW = '2026-08-17T12:00:00Z';

  it('fires with a line naming the record count and the day it happened', () => {
    const line = bestDayCopy({ best: { date: '2026-07-02', count: 7 }, nowISO: NOW, timezone: 'UTC' });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line).toContain('7 kept words');
    expect(line.toLowerCase()).toContain('best day');
    // an older record pins the calendar date so it can't read as this week's same weekday
    expect(line).toContain('Jul 2');
  });

  it('reads naturally with a relative day name (today / yesterday) — colon phrasing, never "on today"', () => {
    const today = bestDayCopy({ best: { date: '2026-08-17', count: 4 }, nowISO: NOW, timezone: 'UTC' });
    expect(today.toLowerCase()).toContain('today');
    expect(today.toLowerCase()).not.toContain('on today');
    const yesterday = bestDayCopy({ best: { date: '2026-08-16', count: 3 }, nowISO: NOW, timezone: 'UTC' });
    expect(yesterday.toLowerCase()).toContain('yesterday');
  });

  it('is SILENT when there is no record to crown (engine returned null, or below the floor)', () => {
    expect(bestDayCopy({ best: null, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(bestDayCopy({ best: undefined })).toBe('');
    expect(bestDayCopy({ best: { date: '2026-07-02', count: 1 }, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(bestDayCopy({})).toBe('');
    expect(bestDayCopy()).toBe('');
  });

  it('is garbage-safe — a best with an unnameable date returns \'\', never a throw', () => {
    expect(bestDayCopy({ best: { date: 'not-a-date', count: 5 }, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(bestDayCopy({ best: { count: 5 }, nowISO: NOW, timezone: 'UTC' })).toBe('');
    expect(bestDayCopy({ best: {} })).toBe('');
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('your best day was ages ago; you keep failing and falling behind').length).toBeGreaterThan(0);
  });

  it('every best-day line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [bestDayHeadingCopy(), bestDayIntroCopy()];
    // a spread of records: recent, this-week, and old, across a range of counts
    for (const spec of [
      { date: '2026-08-17', count: 2 }, { date: '2026-08-16', count: 5 },
      { date: '2026-08-13', count: 9 }, { date: '2026-07-02', count: 12 },
      { date: '2026-01-01', count: 40 },
    ]) surface.push(bestDayCopy({ best: spec, nowISO: NOW, timezone: 'UTC' }));
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a deficit, a comparison to today, or a decline — only the standing record', () => {
    for (const spec of [{ date: '2026-08-17', count: 3 }, { date: '2026-07-02', count: 8 }]) {
      const line = bestDayCopy({ best: spec, nowISO: NOW, timezone: 'UTC' }).toLowerCase();
      expect(
        /\bworst\b|\bweak(est)?\b|\bbetter before\b|\bused to\b|\bnot anymore\b|\bslipp|\bdown from\b|\bbelow\b/.test(line),
        line,
      ).toBe(false);
    }
  });
});

// ── route wiring: GET /api/accountability/kept carries `best_day` ──
// Mirrors power-hours.test.js's double: any non-JOIN commitment_checkins query
// returns `windowTimestamps`, so the all-time best-day read is assembled from
// timestamps the test controls.
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
function makeDB({ keptLog = [], windowTimestamps = [], streak = null, timezone = null } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM accountability_streaks/.test(sql)) return streak;
          if (/SELECT timezone FROM commitments/.test(sql)) return timezone ? { timezone } : null;
          return null;
        },
        async all() {
          if (/FROM commitment_checkins/.test(sql) && /JOIN commitments/.test(sql)) return { results: keptLog };
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

describe('GET /api/accountability/kept — your best day rides alongside momentum', () => {
  it('returns a non-empty best-day line naming the record when a day cleared the floor', async () => {
    // 3 kept on 2026-08-14 (a clear best day), singles elsewhere.
    const windowTimestamps = [
      '2026-08-14T09:00:00Z', '2026-08-14T13:00:00Z', '2026-08-14T20:00:00Z',
      '2026-08-12T10:00:00Z', '2026-08-10T11:00:00Z',
    ];
    const db = makeDB({ windowTimestamps, streak: { total_kept: 5 }, timezone: 'UTC' });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.best_day).toBe('string');
    expect(body.best_day.trim().length).toBeGreaterThan(0);
    expect(body.best_day).toContain('3 kept words');
    expect(scanDesignLaw(body.best_day)).toEqual([]);
  });

  it('respects the recipient timezone: the same instants regroup and the record count shifts', async () => {
    // Clustered around a UTC midnight: UTC → 3 on Aug 14; NY (UTC-4) → 2 on Aug 13.
    const windowTimestamps = ['2026-08-14T01:00:00Z', '2026-08-14T02:00:00Z', '2026-08-14T23:00:00Z'];
    const utcBody = await (await buildRouter(
      makeDB({ windowTimestamps, streak: { total_kept: 3 }, timezone: 'UTC' }),
    )('GET', '/api/accountability/kept')).json();
    expect(utcBody.best_day).toContain('3 kept words');
    const nyBody = await (await buildRouter(
      makeDB({ windowTimestamps, streak: { total_kept: 3 }, timezone: 'America/New_York' }),
    )('GET', '/api/accountability/kept')).json();
    expect(nyBody.best_day).toContain('2 kept words');
  });

  it('sends an EMPTY best-day line when no day cleared the floor (card stays hidden)', async () => {
    const windowTimestamps = ['2026-08-14T09:00:00Z', '2026-08-12T10:00:00Z', '2026-08-10T11:00:00Z']; // all singles
    const db = makeDB({ windowTimestamps, streak: { total_kept: 3 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.best_day).toBe('');
  });

  it('is empty-safe: no kept words at all → \'\' (never a blank panel, never a guess)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.best_day).toBe('');
    expect(res.status).toBe(200);
  });

  it('the all-time best-day read is status=\'kept\' ONLY — never a miss series', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    await buildRouter(db)('GET', '/api/accountability/kept');
    // the all-time read: a non-JOIN commitment_checkins query with NO responded_at cutoff
    const allTimeQueries = db.queries.filter(
      (q) => /FROM commitment_checkins/.test(q) && !/JOIN commitments/.test(q) && !/responded_at >=/.test(q),
    );
    expect(allTimeQueries.length).toBeGreaterThanOrEqual(1);
    for (const q of allTimeQueries) {
      expect(/status = 'kept'/.test(q)).toBe(true);
      expect(/missed/i.test(q)).toBe(false);
    }
  });

  it('401s without a valid token, and never queries the database', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.queries.length).toBe(0);
  });
});
