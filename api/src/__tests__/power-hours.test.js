/**
 * FocusBro — your power hours (Contender #10, Phase A depth).
 *
 * The per-day momentum sparkline answers "which DAYS did you keep your word";
 * power hours answers the question it can't — "WHEN in the day are you strongest?"
 * It buckets the same status='kept' instants by local wall-clock hour and names
 * the single peak: "you're strongest around 9am — that's where most of your kept
 * words land."
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - It reads a status='kept' histogram ONLY (the route query is kept-only), so it
 *    can only ever point at an hour the person SHOWED UP — there is no "quiet hours"
 *    or "you get nothing done after lunch" surface anywhere in the module.
 *  - It names a peak ONLY when peakKeptHour clears its signal gate (enough kept
 *    history + a peak that leads + a single tallest hour). A thin, flat, or tied
 *    history returns null → '' — never an arbitrary or invented "power hour".
 *  - The copy frames the hour as a strength to lean into, never a deficit, a
 *    comparison, or the hours that were missed.
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import {
  localHourInZone,
  bucketKeptByHour,
  peakKeptHour,
  describeHourBand,
  POWER_HOURS_MIN_TOTAL,
  POWER_HOURS_MIN_PEAK,
} from '../momentum.js';
import {
  powerHoursCopy,
  powerHoursHeadingCopy,
  powerHoursIntroCopy,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── the pure engine: hour-of-day extraction ──────────────────
describe('localHourInZone — the local wall-clock hour of a kept instant', () => {
  it('returns the UTC hour with no zone (or the UTC fallback)', () => {
    expect(localHourInZone('2026-07-09T14:00:00Z')).toBe(14);
    expect(localHourInZone('2026-07-09T00:30:00Z', 'UTC')).toBe(0);
    expect(localHourInZone('2026-07-09T23:59:00Z', 'UTC')).toBe(23);
  });

  it('shifts into the recipient zone (DST-correct via Intl)', () => {
    // 14:00 UTC in July is 10:00 in America/New_York (UTC-4, DST).
    expect(localHourInZone('2026-07-09T14:00:00Z', 'America/New_York')).toBe(10);
    // 02:00 UTC is 03:00 in Europe/Paris (UTC+1 standard? July = UTC+2 → 04:00).
    expect(localHourInZone('2026-07-09T02:00:00Z', 'Europe/Paris')).toBe(4);
    // A zone that crosses midnight backward: 02:00 UTC in America/Los_Angeles (UTC-7 July) = 19:00 prior day.
    expect(localHourInZone('2026-07-09T02:00:00Z', 'America/Los_Angeles')).toBe(19);
  });

  it('is null on an unparseable instant, never a throw', () => {
    expect(localHourInZone('not-a-date')).toBeNull();
    expect(localHourInZone('')).toBeNull();
    expect(localHourInZone(null)).toBeNull();
  });
});

describe('bucketKeptByHour — 24 per-hour counts, kept-only', () => {
  it('buckets each instant into its local hour; empty hours are genuine zeros', () => {
    const buckets = bucketKeptByHour({
      timestamps: [
        '2026-07-09T09:10:00Z', '2026-07-08T09:40:00Z', '2026-07-07T09:05:00Z',
        '2026-07-06T14:00:00Z',
      ],
      timezone: 'UTC',
    });
    expect(buckets).toHaveLength(24);
    expect(buckets[9].count).toBe(3);
    expect(buckets[14].count).toBe(1);
    expect(buckets[0].count).toBe(0); // a quiet hour is a real zero, never a miss
    // every entry is {hour, count}, indexed 0..23
    buckets.forEach((b, i) => expect(b.hour).toBe(i));
  });

  it('is empty/garbage-safe — no timestamps → a flat 24-hour axis of zeros', () => {
    for (const input of [undefined, {}, { timestamps: [] }, { timestamps: 'x' }]) {
      const buckets = bucketKeptByHour(input);
      expect(buckets).toHaveLength(24);
      expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(0);
    }
  });

  it('drops unparseable instants without throwing', () => {
    const buckets = bucketKeptByHour({ timestamps: ['2026-07-09T09:00:00Z', 'junk', null], timezone: 'UTC' });
    expect(buckets[9].count).toBe(1);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });
});

describe('peakKeptHour — the signal gate: name a peak only when it is trustworthy', () => {
  // helper: build a 24-hour histogram from {hour: count} spec
  const hist = (spec) => Array.from({ length: 24 }, (_, hour) => ({ hour, count: spec[hour] || 0 }));

  it('returns the single tallest hour when there is enough signal', () => {
    const peak = peakKeptHour(hist({ 9: 6, 14: 2 })); // total 8, clear single peak at 9
    expect(peak).toBeTruthy();
    expect(peak.hour).toBe(9);
    expect(peak.count).toBe(6);
    expect(peak.total).toBe(8);
    expect(peak.share).toBeCloseTo(6 / 8);
  });

  it('is null below the minimum total (a thin history gets no power hour)', () => {
    // total 5 (< POWER_HOURS_MIN_TOTAL), even with a clear peak
    expect(peakKeptHour(hist({ 9: 4, 14: 1 }))).toBeNull();
    expect(POWER_HOURS_MIN_TOTAL).toBeGreaterThan(5);
  });

  it('is null when the peak itself is too small (flat spread, no real high point)', () => {
    // total 8 but the tallest hour holds only 2 (< POWER_HOURS_MIN_PEAK)
    const flat = hist({ 8: 2, 10: 2, 12: 2, 15: 2 });
    expect(peakKeptHour(flat)).toBeNull();
    expect(POWER_HOURS_MIN_PEAK).toBeGreaterThan(2);
  });

  it('is null on a TIE for the top — no single power hour to name', () => {
    const tied = hist({ 9: 4, 15: 4 }); // total 8, peak 4, but two hours tie
    expect(peakKeptHour(tied)).toBeNull();
  });

  it('is empty/garbage-safe', () => {
    expect(peakKeptHour(undefined)).toBeNull();
    expect(peakKeptHour([])).toBeNull();
    expect(peakKeptHour('x')).toBeNull();
    expect(peakKeptHour([{ hour: 'x', count: 'y' }])).toBeNull();
  });
});

describe('describeHourBand — a warm, plain name for an hour of the day', () => {
  it('names a 12-hour clock time plus its part of day', () => {
    expect(describeHourBand(9)).toBe('9am, in the morning');
    expect(describeHourBand(14)).toBe('2pm, in the afternoon');
    expect(describeHourBand(19)).toBe('7pm, in the evening');
    expect(describeHourBand(22)).toBe('10pm, at night');
    expect(describeHourBand(3)).toBe('3am, at night');
  });

  it('gives midnight and noon their own words (no redundant part-of-day)', () => {
    expect(describeHourBand(0)).toBe('midnight');
    expect(describeHourBand(12)).toBe('noon');
  });

  it('is empty for a non-hour, never a throw', () => {
    for (const bad of [-1, 24, 9.5, NaN, 'x', null, undefined]) {
      expect(describeHourBand(bad)).toBe('');
    }
  });
});

// ── the copy ─────────────────────────────────────────────────
describe('powerHoursCopy — the warm "you\'re strongest around N" read', () => {
  it('fires with a non-empty line naming the hour when given a peak', () => {
    const line = powerHoursCopy({ peak: { hour: 9, count: 6 } });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line.toLowerCase()).toContain('9am');
    expect(line.toLowerCase()).toContain('strongest');
  });

  it('is SILENT when there is no trustworthy peak (gate returned null)', () => {
    expect(powerHoursCopy({ peak: null })).toBe('');
    expect(powerHoursCopy({ peak: undefined })).toBe('');
    expect(powerHoursCopy({})).toBe('');
    expect(powerHoursCopy()).toBe('');
  });

  it('is garbage-safe — a peak with a junk hour returns \'\', never a throw', () => {
    expect(powerHoursCopy({ peak: { hour: 'x' } })).toBe('');
    expect(powerHoursCopy({ peak: { hour: 99, count: 5 } })).toBe('');
    expect(powerHoursCopy({ peak: {} })).toBe('');
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw("you're always behind after lunch, you failed again").length).toBeGreaterThan(0);
  });

  it('every power-hours line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [powerHoursHeadingCopy(), powerHoursIntroCopy()];
    for (let h = 0; h < 24; h++) surface.push(powerHoursCopy({ peak: { hour: h, count: 5 } }));
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a deficit, a comparison, or the hours that were missed — only the strength', () => {
    for (const h of [0, 6, 9, 12, 14, 19, 22]) {
      const line = powerHoursCopy({ peak: { hour: h, count: 5 } }).toLowerCase();
      if (!line) continue;
      expect(
        /\bworst\b|\bweak(est)?\b|\bnever\b|\bavoid\b|\bstruggle\b|\bslump\b|\bafter\b.*\bmiss/.test(line),
        line,
      ).toBe(false);
    }
  });
});

// ── route wiring: GET /api/accountability/kept carries `power_hours` ──
// Mirrors kept-log.test.js's momentum double: any windowed (non-JOIN)
// commitment_checkins query returns `windowTimestamps`, so the power-hours read is
// assembled from timestamps the test controls.
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

describe('GET /api/accountability/kept — your power hours ride alongside momentum', () => {
  it('returns a non-empty power-hours line naming the peak hour when there is enough kept history', async () => {
    // 6 kept at 14:00 UTC + 2 at 09:00 UTC → total 8, clear single peak at 2pm.
    const windowTimestamps = [
      '2026-08-14T14:05:00Z', '2026-08-13T14:20:00Z', '2026-08-12T14:40:00Z',
      '2026-08-11T14:00:00Z', '2026-08-10T14:30:00Z', '2026-08-09T14:15:00Z',
      '2026-08-08T09:10:00Z', '2026-08-07T09:50:00Z',
    ];
    const db = makeDB({ windowTimestamps, streak: { total_kept: 8 }, timezone: 'UTC' });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.power_hours).toBe('string');
    expect(body.power_hours.trim().length).toBeGreaterThan(0);
    expect(body.power_hours.toLowerCase()).toContain('2pm');
    expect(scanDesignLaw(body.power_hours)).toEqual([]);
  });

  it('respects the recipient timezone: the same instants shift the named hour', async () => {
    const windowTimestamps = [
      '2026-08-14T14:05:00Z', '2026-08-13T14:20:00Z', '2026-08-12T14:40:00Z',
      '2026-08-11T14:00:00Z', '2026-08-10T14:30:00Z', '2026-08-09T14:15:00Z',
      '2026-08-08T09:10:00Z', '2026-08-07T09:50:00Z',
    ];
    // America/New_York (UTC-4 in August): 14:00 UTC → 10am.
    const db = makeDB({ windowTimestamps, streak: { total_kept: 8 }, timezone: 'America/New_York' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.power_hours.toLowerCase()).toContain('10am');
  });

  it('sends an EMPTY power-hours line when the history is too thin to trust (card stays hidden)', async () => {
    const windowTimestamps = ['2026-08-14T14:00:00Z', '2026-08-13T14:00:00Z', '2026-08-12T09:00:00Z']; // total 3 < min
    const db = makeDB({ windowTimestamps, streak: { total_kept: 3 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.power_hours).toBe('');
  });

  it('is empty-safe: no kept words at all → \'\' (never a blank panel, never a guess)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.power_hours).toBe('');
    expect(res.status).toBe(200);
  });

  it('the power-hours window reads status=\'kept\' ONLY — never a miss series', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    await buildRouter(db)('GET', '/api/accountability/kept');
    const windowQueries = db.queries.filter((q) => /FROM commitment_checkins/.test(q) && !/JOIN commitments/.test(q) && /responded_at >=/.test(q));
    expect(windowQueries.length).toBeGreaterThanOrEqual(2); // momentum window + power-hours window
    for (const q of windowQueries) {
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
