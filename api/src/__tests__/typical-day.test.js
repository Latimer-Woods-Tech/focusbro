/**
 * FocusBro — your typical day (Contender #10, Phase A depth).
 *
 * The count/peak/breadth reads answer HOW MANY (lifetime total), the PEAK (best
 * day / power hour / power day), and the BREADTH (days you showed up). None names
 * the INTENSITY of a normal active day. This does: "on a day you show up, you keep
 * about 3 words — that's your rhythm." The average is built from the same
 * status='kept' history the record reads use.
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - BOTH halves of the average — the kept total and the count of distinct active
 *    days — are drawn from status='kept' instants ONLY, so a quiet day is in
 *    NEITHER and can never be averaged in. It can only ever describe the days the
 *    person SHOWED UP.
 *  - It names an average ONLY when the history clears the signal gate (enough
 *    active days + enough kept words). A thin history returns null → ''.
 *  - Even past the gate, a ~1-a-day average stays SILENT (that story is already
 *    told by "days you showed up"), so it never reads as a hollow "about 1 a day".
 *  - The copy frames a rhythm, never a deficit, a comparison, or the days missed.
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import {
  typicalKeptPerActiveDay,
  TYPICAL_DAY_MIN_DAYS,
  TYPICAL_DAY_MIN_TOTAL,
} from '../momentum.js';
import {
  typicalDayCopy,
  typicalDayHeadingCopy,
  typicalDayIntroCopy,
  TYPICAL_DAY_MIN_PER_DAY,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── the pure engine ──────────────────────────────────────────
describe('typicalKeptPerActiveDay — the average kept words per active day', () => {
  // 6 distinct days × 2 kept words each = 12 total → perDay 2.0, clears the gate.
  const twoADay = [
    '2026-08-01T09:00:00Z', '2026-08-01T15:00:00Z',
    '2026-08-02T09:00:00Z', '2026-08-02T15:00:00Z',
    '2026-08-03T09:00:00Z', '2026-08-03T15:00:00Z',
    '2026-08-04T09:00:00Z', '2026-08-04T15:00:00Z',
    '2026-08-05T09:00:00Z', '2026-08-05T15:00:00Z',
    '2026-08-06T09:00:00Z', '2026-08-06T15:00:00Z',
  ];

  it('divides the kept total by the distinct active days once the gate clears', () => {
    const t = typicalKeptPerActiveDay({ timestamps: twoADay, timezone: 'UTC' });
    expect(t).not.toBeNull();
    expect(t.total).toBe(12);
    expect(t.days).toBe(6);
    expect(t.perDay).toBeCloseTo(2, 5);
  });

  it('is null when there are too few active days to trust (below the day floor)', () => {
    // 20 kept words but all on 3 days → clears the total floor, fails the day floor.
    const threeBusyDays = [];
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03']) {
      for (let i = 0; i < 7; i++) threeBusyDays.push(`${d}T${String(9 + i).padStart(2, '0')}:00:00Z`);
    }
    expect(threeBusyDays.length).toBeGreaterThanOrEqual(TYPICAL_DAY_MIN_TOTAL);
    expect(typicalKeptPerActiveDay({ timestamps: threeBusyDays, timezone: 'UTC' })).toBeNull();
    expect(TYPICAL_DAY_MIN_DAYS).toBeGreaterThan(3);
  });

  it('is null when there are too few kept words to trust (below the total floor)', () => {
    // 6 distinct days but only 1 word each = 6 total → clears the day floor, fails total.
    const oneEach = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']
      .map((d) => `${d}T09:00:00Z`);
    expect(oneEach.length).toBeGreaterThanOrEqual(TYPICAL_DAY_MIN_DAYS);
    expect(typicalKeptPerActiveDay({ timestamps: oneEach, timezone: 'UTC' })).toBeNull();
    expect(TYPICAL_DAY_MIN_TOTAL).toBeGreaterThan(6);
  });

  it('buckets by LOCAL day — a zone shift that splits a day changes the average', () => {
    // Two instants on one UTC day; in LA (UTC-7) the 02:00Z one falls on the prior
    // day, so the same words spread across TWO local days. Gate lowered to isolate
    // the bucketing effect.
    const opts = { minDays: 1, minTotal: 1 };
    const ts = ['2026-08-11T02:00:00Z', '2026-08-11T20:00:00Z'];
    const utc = typicalKeptPerActiveDay({ timestamps: ts, timezone: 'UTC', ...opts });
    expect(utc.days).toBe(1); // both land on 2026-08-11 UTC
    expect(utc.perDay).toBeCloseTo(2, 5);
    const la = typicalKeptPerActiveDay({ timestamps: ts, timezone: 'America/Los_Angeles', ...opts });
    expect(la.days).toBe(2); // 02:00Z → Aug 10, 20:00Z → Aug 11
    expect(la.perDay).toBeCloseTo(1, 5);
  });

  it('is empty/garbage-safe — bad input never throws, returns null below the gate', () => {
    for (const bad of [undefined, null, 'x', [123, null, {}], ['not-a-date']]) {
      expect(typicalKeptPerActiveDay({ timestamps: bad, timezone: 'UTC' })).toBeNull();
    }
  });
});

// ── the copy ─────────────────────────────────────────────────
describe('typicalDayCopy — the warm "on a day you show up, about N words" read', () => {
  it('fires with a non-empty line naming the rounded rhythm', () => {
    const line = typicalDayCopy({ typical: { perDay: 3, total: 30, days: 10 } });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line).toContain('about 3 words');
    expect(line.toLowerCase()).toContain('rhythm');
  });

  it('rounds to a warm "about N" (2.6 → 3), and pluralizes correctly', () => {
    expect(typicalDayCopy({ typical: { perDay: 2.6, total: 26, days: 10 } })).toContain('about 3 words');
    expect(typicalDayCopy({ typical: { perDay: 2.2, total: 22, days: 10 } })).toContain('about 2 words');
  });

  it('reads in both personas', () => {
    const ally = typicalDayCopy({ typical: { perDay: 4, total: 40, days: 10 }, persona: 'ally' });
    const hype = typicalDayCopy({ typical: { perDay: 4, total: 40, days: 10 }, persona: 'hype' });
    expect(ally).toContain('about 4 words');
    expect(hype).toContain('about 4 words');
    expect(hype).not.toBe(ally);
  });

  it('is SILENT below the ~2-a-day floor — a ~1-a-day rhythm adds nothing past "days you showed up"', () => {
    expect(typicalDayCopy({ typical: { perDay: 1, total: 12, days: 12 } })).toBe('');
    expect(typicalDayCopy({ typical: { perDay: 1.4, total: 14, days: 10 } })).toBe('');
    expect(TYPICAL_DAY_MIN_PER_DAY).toBe(2);
  });

  it('is SILENT when there is no trustworthy average (gate returned null)', () => {
    expect(typicalDayCopy({ typical: null })).toBe('');
    expect(typicalDayCopy({ typical: undefined })).toBe('');
    expect(typicalDayCopy({})).toBe('');
    expect(typicalDayCopy()).toBe('');
  });

  it('is garbage-safe — a junk average returns \'\', never a throw', () => {
    expect(typicalDayCopy({ typical: { perDay: 'x' } })).toBe('');
    expect(typicalDayCopy({ typical: { perDay: NaN } })).toBe('');
    expect(typicalDayCopy({ typical: { perDay: Infinity } })).toBe('');
    expect(typicalDayCopy({ typical: {} })).toBe('');
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('on a typical day you fail and fall behind, you keep almost nothing').length)
      .toBeGreaterThan(0);
  });

  it('every typical-day line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [typicalDayHeadingCopy(), typicalDayIntroCopy()];
    for (const perDay of [2, 3, 4, 7, 12]) {
      surface.push(typicalDayCopy({ typical: { perDay, total: perDay * 10, days: 10 } }));
      surface.push(typicalDayCopy({ typical: { perDay, total: perDay * 10, days: 10 }, persona: 'hype' }));
    }
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a deficit, a comparison, a target, or the days that were missed — only the rhythm', () => {
    for (const perDay of [2, 3, 5, 9]) {
      for (const persona of ['ally', 'hype']) {
        const line = typicalDayCopy({ typical: { perDay, total: perDay * 10, days: 10 }, persona }).toLowerCase();
        if (!line) continue;
        expect(
          /\bworst\b|\bweak(est)?\b|\bnever\b|\bavoid\b|\bstruggle\b|\bslump\b|\bmiss|\bgoal\b|\btarget\b|\bshould\b|\bmore than\b|\bless than\b/.test(line),
          line,
        ).toBe(false);
      }
    }
  });
});

// ── route wiring: GET /api/accountability/kept carries `typical_day` ──
// Mirrors power-day.test.js: any non-JOIN commitment_checkins query returns
// `windowTimestamps`, so the all-time scan the typical-day read reuses is assembled
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

// 6 distinct days, 2 kept words each = 12 total → perDay 2.0 → "about 2 words".
const TWO_A_DAY_TIMESTAMPS = [
  '2026-08-01T09:00:00Z', '2026-08-01T15:00:00Z',
  '2026-08-02T09:00:00Z', '2026-08-02T15:00:00Z',
  '2026-08-03T09:00:00Z', '2026-08-03T15:00:00Z',
  '2026-08-04T09:00:00Z', '2026-08-04T15:00:00Z',
  '2026-08-05T09:00:00Z', '2026-08-05T15:00:00Z',
  '2026-08-06T09:00:00Z', '2026-08-06T15:00:00Z',
];

describe('GET /api/accountability/kept — your typical day rides alongside the other reads', () => {
  it('returns a non-empty typical-day line naming the rhythm when there is enough kept history', async () => {
    const db = makeDB({ windowTimestamps: TWO_A_DAY_TIMESTAMPS, streak: { total_kept: 12 }, timezone: 'UTC' });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.typical_day).toBe('string');
    expect(body.typical_day.trim().length).toBeGreaterThan(0);
    expect(body.typical_day).toContain('about 2 words');
    expect(scanDesignLaw(body.typical_day)).toEqual([]);
  });

  it('sends an EMPTY typical-day line when the history is too thin in DAYS (card stays hidden)', async () => {
    // 12 words but all on 3 days → clears the total floor, fails the day floor.
    const windowTimestamps = [];
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03']) {
      for (let i = 0; i < 4; i++) windowTimestamps.push(`${d}T${String(9 + i).padStart(2, '0')}:00:00Z`);
    }
    const db = makeDB({ windowTimestamps, streak: { total_kept: 12 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.typical_day).toBe('');
  });

  it('stays SILENT at a ~1-a-day rhythm even past the gate — never duplicates "days you showed up"', async () => {
    // 12 distinct days, 1 word each → clears BOTH engine floors, but perDay 1.0 <
    // the copy floor → '' (the "showed up on 12 days" story is its own card).
    const windowTimestamps = [];
    for (let day = 1; day <= 12; day++) windowTimestamps.push(`2026-08-${String(day).padStart(2, '0')}T09:00:00Z`);
    const db = makeDB({ windowTimestamps, streak: { total_kept: 12 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.typical_day).toBe('');
  });

  it('is empty-safe: no kept words at all → \'\' (never a blank panel, never a guess)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.typical_day).toBe('');
    expect(res.status).toBe(200);
  });

  it('the typical-day read comes from a status=\'kept\' scan ONLY — never a miss series', async () => {
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
