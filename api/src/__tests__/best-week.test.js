/**
 * FocusBro — your best week (Contender #10, Phase A depth).
 *
 * The best-DAY record crowns the tallest single day; this is its week-scale peer —
 * the Monday-anchored local week the person strung the most kept words together in.
 * A bigger canvas that can tell a different story: a steady week spread across many
 * days can crown a week no single one of those days would. It reads the same
 * status='kept' history the other record reads use.
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - The week is folded from status='kept' instants ONLY, so it can only ever crown
 *    a week the person SHOWED UP — never a "worst week", never a week-over-week
 *    comparison, never a decline.
 *  - It crowns a record ONLY past the signal floor (BEST_WEEK_MIN_COUNT); a thin
 *    history returns null → ''.
 *  - It stays SILENT unless the best week is strictly BIGGER than the best single
 *    day, so it never just echoes the best-day card.
 *  - On a tie it names the MOST RECENT such week (the freshest high-water mark).
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import {
  allTimeBestWeek,
  weekStartLabel,
  describeBestWeek,
  BEST_WEEK_MIN_COUNT,
} from '../momentum.js';
import {
  bestWeekCopy,
  bestWeekHeadingCopy,
  bestWeekIntroCopy,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── weekStartLabel: fold a local day into its Monday-anchored week ──
describe('weekStartLabel — the Monday-anchored week label for a local day', () => {
  it('maps a Monday to itself', () => {
    expect(weekStartLabel('2026-08-10')).toBe('2026-08-10');
    expect(weekStartLabel('2026-08-03')).toBe('2026-08-03');
  });

  it('folds a mid-week day back to that week’s Monday', () => {
    expect(weekStartLabel('2026-08-14')).toBe('2026-08-10'); // Fri → Mon of that week
    expect(weekStartLabel('2026-08-11')).toBe('2026-08-10'); // Tue
    expect(weekStartLabel('2026-07-02')).toBe('2026-06-29'); // Thu
  });

  it('folds a Sunday back to the PRIOR Monday (ISO-8601 weeks start Monday)', () => {
    expect(weekStartLabel('2026-08-09')).toBe('2026-08-03'); // Sun → prior Mon
  });

  it('crosses a year boundary correctly (a Jan Sunday belongs to a Dec Monday)', () => {
    expect(weekStartLabel('2026-01-04')).toBe('2025-12-29'); // Sun Jan 4 → Mon Dec 29, 2025
  });

  it('is garbage-safe — a malformed label returns null, never throws', () => {
    for (const bad of [undefined, null, 'x', '2026-8-1', 42, {}]) {
      expect(weekStartLabel(bad)).toBeNull();
    }
  });
});

// ── the pure engine: allTimeBestWeek ────────────────────────
describe('allTimeBestWeek — the biggest week in a kept-word history', () => {
  // Week of Aug 3 (Mon): 2 kept words on each of Aug 3–6 = 8 total, no single day > 2.
  // Week of Aug 10 (Mon): 1 word on each of Aug 10–11 = 2 total.
  const twoWeeks = [
    '2026-08-03T09:00:00Z', '2026-08-03T15:00:00Z',
    '2026-08-04T09:00:00Z', '2026-08-04T15:00:00Z',
    '2026-08-05T09:00:00Z', '2026-08-05T15:00:00Z',
    '2026-08-06T09:00:00Z', '2026-08-06T15:00:00Z',
    '2026-08-10T09:00:00Z',
    '2026-08-11T09:00:00Z',
  ];

  it('crowns the local week with the most kept words', () => {
    const best = allTimeBestWeek({ timestamps: twoWeeks, timezone: 'UTC' });
    expect(best).not.toBeNull();
    expect(best.weekStart).toBe('2026-08-03');
    expect(best.count).toBe(8);
  });

  it('on a TIE names the MOST RECENT week (the freshest high-water mark)', () => {
    // Two weeks tie at 6; the later Monday (Aug 10) wins.
    const tied = [
      '2026-08-03T09:00:00Z', '2026-08-03T15:00:00Z', '2026-08-04T09:00:00Z',
      '2026-08-05T09:00:00Z', '2026-08-06T09:00:00Z', '2026-08-07T09:00:00Z',
      '2026-08-10T09:00:00Z', '2026-08-10T15:00:00Z', '2026-08-11T09:00:00Z',
      '2026-08-12T09:00:00Z', '2026-08-13T09:00:00Z', '2026-08-14T09:00:00Z',
    ];
    const best = allTimeBestWeek({ timestamps: tied, timezone: 'UTC' });
    expect(best.count).toBe(6);
    expect(best.weekStart).toBe('2026-08-10');
  });

  it('is null below the floor — a thin week gets no hollow record', () => {
    // 3 kept words in the best week < BEST_WEEK_MIN_COUNT.
    const thin = ['2026-08-03T09:00:00Z', '2026-08-04T09:00:00Z', '2026-08-05T09:00:00Z'];
    expect(thin.length).toBeLessThan(BEST_WEEK_MIN_COUNT);
    expect(allTimeBestWeek({ timestamps: thin, timezone: 'UTC' })).toBeNull();
  });

  it('buckets by LOCAL week — a zone shift across the Sun→Mon boundary changes the week', () => {
    // Mon 02:00 UTC is still Sunday (prior week) in LA (UTC-7).
    const ts = ['2026-08-10T02:00:00Z'];
    const opts = { minCount: 1 };
    const utc = allTimeBestWeek({ timestamps: ts, timezone: 'UTC', ...opts });
    expect(utc.weekStart).toBe('2026-08-10'); // Mon Aug 10 UTC
    const la = allTimeBestWeek({ timestamps: ts, timezone: 'America/Los_Angeles', ...opts });
    expect(la.weekStart).toBe('2026-08-03'); // Sun Aug 9 LA → week of Aug 3
  });

  it('is empty/garbage-safe — bad input never throws, returns null below the gate', () => {
    for (const bad of [undefined, null, 'x', [123, null, {}], ['not-a-date']]) {
      expect(allTimeBestWeek({ timestamps: bad, timezone: 'UTC' })).toBeNull();
    }
  });
});

// ── describeBestWeek: the warm, relative-aware week name ─────
describe('describeBestWeek — this week / last week / the week of …', () => {
  const anchor = { nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC' }; // this week = Mon Aug 17

  it('names the current and prior weeks relatively', () => {
    expect(describeBestWeek('2026-08-17', anchor)).toBe('this week');
    expect(describeBestWeek('2026-08-10', anchor)).toBe('last week');
  });

  it('names older weeks by their Monday date', () => {
    expect(describeBestWeek('2026-08-03', anchor)).toBe('the week of Aug 3');
    expect(describeBestWeek('2026-06-29', anchor)).toBe('the week of Jun 29');
  });

  it('qualifies the year past a rollover so an old record can’t read as this year', () => {
    expect(describeBestWeek('2025-12-29', anchor)).toBe('the week of Dec 29, 2025');
  });

  it('is garbage-safe — a malformed label returns \'\', never throws', () => {
    for (const bad of [undefined, null, 'x', '2026-8-1', 42, {}]) {
      expect(describeBestWeek(bad, anchor)).toBe('');
    }
  });
});

// ── the copy: bestWeekCopy ──────────────────────────────────
describe('bestWeekCopy — the warm "your best week so far" record read', () => {
  const anchor = { nowISO: '2026-08-17T12:00:00Z', timezone: 'UTC' };

  it('fires with a non-empty line naming the record count and the week', () => {
    const line = bestWeekCopy({ best: { weekStart: '2026-06-29', count: 18 }, bestDayCount: 7, ...anchor });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line.toLowerCase()).toContain('best week');
    expect(line).toContain('18 kept words');
    expect(line).toContain('the week of Jun 29');
  });

  it('is SILENT unless the week is strictly BIGGER than the best single day (no echo of best-day)', () => {
    // A week no larger than one already-crowned day adds nothing.
    expect(bestWeekCopy({ best: { weekStart: '2026-08-03', count: 5 }, bestDayCount: 5, ...anchor })).toBe('');
    expect(bestWeekCopy({ best: { weekStart: '2026-08-03', count: 5 }, bestDayCount: 6, ...anchor })).toBe('');
    // Strictly bigger → it speaks.
    expect(bestWeekCopy({ best: { weekStart: '2026-08-03', count: 5 }, bestDayCount: 4, ...anchor }).trim().length)
      .toBeGreaterThan(0);
  });

  it('is SILENT below the floor even with no best day to beat', () => {
    expect(bestWeekCopy({ best: { weekStart: '2026-08-03', count: 3 }, bestDayCount: 0, ...anchor })).toBe('');
    expect(BEST_WEEK_MIN_COUNT).toBeGreaterThan(3);
  });

  it('is SILENT when there is no record to crown (engine returned null)', () => {
    expect(bestWeekCopy({ best: null, ...anchor })).toBe('');
    expect(bestWeekCopy({ best: undefined })).toBe('');
    expect(bestWeekCopy({})).toBe('');
    expect(bestWeekCopy()).toBe('');
  });

  it('is garbage-safe — a junk record returns \'\', never a throw', () => {
    expect(bestWeekCopy({ best: { count: 'x' }, bestDayCount: 0, ...anchor })).toBe('');
    expect(bestWeekCopy({ best: { weekStart: 'nope', count: 12 }, bestDayCount: 0, ...anchor })).toBe('');
    expect(bestWeekCopy({ best: {}, ...anchor })).toBe('');
  });

  it('reads in both personas', () => {
    const base = { best: { weekStart: '2026-06-29', count: 20 }, bestDayCount: 6, ...anchor };
    const ally = bestWeekCopy({ ...base, persona: 'ally' });
    const hype = bestWeekCopy({ ...base, persona: 'hype' });
    expect(ally).toContain('20 kept words');
    expect(hype).toContain('20 kept words');
    expect(hype).not.toBe(ally);
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('your worst week you fell behind and kept almost nothing').length)
      .toBeGreaterThan(0);
  });

  it('every best-week line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [bestWeekHeadingCopy(), bestWeekIntroCopy()];
    for (const count of [5, 9, 18, 40]) {
      for (const persona of ['ally', 'hype']) {
        surface.push(bestWeekCopy({ best: { weekStart: '2026-06-29', count }, bestDayCount: 2, ...anchor, persona }));
      }
    }
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a worst week, a deficit, a comparison, or a target — only the record', () => {
    for (const count of [5, 12, 30]) {
      for (const persona of ['ally', 'hype']) {
        const line = bestWeekCopy({ best: { weekStart: '2026-06-29', count }, bestDayCount: 2, ...anchor, persona }).toLowerCase();
        if (!line) continue;
        expect(
          /\bworst\b|\bweak(est)?\b|\bnever\b|\bavoid\b|\bstruggle\b|\bslump\b|\bmiss|\bgoal\b|\btarget\b|\bshould\b|\bmore than\b|\bless than\b|\bfell behind\b|\bbehind\b/.test(line),
          line,
        ).toBe(false);
      }
    }
  });
});

// ── route wiring: GET /api/accountability/kept carries `best_week` ──
// Mirrors typical-day.test.js: any non-JOIN commitment_checkins query returns
// `windowTimestamps`, so the all-time scan the best-week read reuses is assembled
// from timestamps the test controls.
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

// Week of Aug 3: 2 kept words on each of Aug 3–6 = 8 total, no single day > 2.
const BIG_WEEK_TIMESTAMPS = [
  '2026-08-03T09:00:00Z', '2026-08-03T15:00:00Z',
  '2026-08-04T09:00:00Z', '2026-08-04T15:00:00Z',
  '2026-08-05T09:00:00Z', '2026-08-05T15:00:00Z',
  '2026-08-06T09:00:00Z', '2026-08-06T15:00:00Z',
];

describe('GET /api/accountability/kept — your best week rides alongside the other reads', () => {
  it('returns a non-empty best-week line when a week beats the best single day', async () => {
    const db = makeDB({ windowTimestamps: BIG_WEEK_TIMESTAMPS, streak: { total_kept: 8 }, timezone: 'UTC' });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.best_week).toBe('string');
    expect(body.best_week.trim().length).toBeGreaterThan(0);
    expect(body.best_week).toContain('8 kept words');
    expect(body.best_week.toLowerCase()).toContain('best week');
    expect(body.best_week).toContain('the week of Aug 3');
    expect(scanDesignLaw(body.best_week)).toEqual([]);
  });

  it('sends an EMPTY best-week line when the biggest week only echoes the best day', async () => {
    // 6 kept words all on ONE day → best day 6 AND best week 6 → the week adds
    // nothing past the best-day card, so it stays silent.
    const oneDay = [];
    for (let i = 0; i < 6; i++) oneDay.push(`2026-08-03T${String(9 + i).padStart(2, '0')}:00:00Z`);
    const db = makeDB({ windowTimestamps: oneDay, streak: { total_kept: 6 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.best_week).toBe('');
  });

  it('sends an EMPTY best-week line when the history is below the floor', async () => {
    const thin = ['2026-08-03T09:00:00Z', '2026-08-04T09:00:00Z', '2026-08-05T09:00:00Z'];
    const db = makeDB({ windowTimestamps: thin, streak: { total_kept: 3 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.best_week).toBe('');
  });

  it('is empty-safe: no kept words at all → \'\' (never a blank panel, never a guess)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.best_week).toBe('');
    expect(res.status).toBe(200);
  });

  it('the best-week read comes from a status=\'kept\' scan ONLY — never a miss series', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    await buildRouter(db)('GET', '/api/accountability/kept');
    const checkinQueries = db.queries.filter((q) => /FROM commitment_checkins/.test(q) && !/JOIN commitments/.test(q));
    expect(checkinQueries.length).toBeGreaterThanOrEqual(1);
    for (const q of checkinQueries) {
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
