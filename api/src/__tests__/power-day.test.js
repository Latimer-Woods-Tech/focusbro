/**
 * FocusBro — your power day (Contender #10, Phase A depth).
 *
 * Power hours answers "WHEN in the day are you strongest?"; power day answers the
 * weekday question beside it — "which DAY OF THE WEEK do you come through most?" It
 * buckets the same status='kept' instants by local weekday and names the single
 * peak: "you're strongest on Tuesdays — that's the day of the week most of your
 * kept words land."
 *
 * Anti-shame by CONSTRUCTION, and this suite pins each guarantee:
 *  - It reads a status='kept' histogram ONLY (the route scan is kept-only), so it
 *    can only ever point at a weekday the person SHOWED UP — there is no "your weak
 *    day" or "you never keep words on Mondays" surface anywhere in the module.
 *  - It names a peak ONLY when peakKeptWeekday clears its signal gate (enough kept
 *    history + a peak that leads + a single tallest weekday). A thin, flat, or tied
 *    history returns null → '' — never an arbitrary or invented "power day".
 *  - The copy frames the weekday as a strength to lean into, never a deficit, a
 *    comparison, or the days that were missed.
 *
 * Proof-of-rejection (Standing Law #1): the scanner used for the "clean" assertions
 * is shown able to FAIL first, so those assertions are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { scanDesignLaw } from '../design-law.js';
import {
  localWeekdayInZone,
  bucketKeptByWeekday,
  peakKeptWeekday,
  describeWeekday,
  POWER_DAY_MIN_TOTAL,
  POWER_DAY_MIN_PEAK,
} from '../momentum.js';
import {
  powerDayCopy,
  powerDayHeadingCopy,
  powerDayIntroCopy,
  registerAccountabilityRoutes,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── the pure engine: weekday extraction ──────────────────────
describe('localWeekdayInZone — the local calendar weekday of a kept instant', () => {
  it('returns the UTC weekday with no zone (0=Sunday..6=Saturday)', () => {
    // 2026-08-11 is a Tuesday (jsidx 2); 2026-08-16 is a Sunday (jsidx 0).
    expect(localWeekdayInZone('2026-08-11T14:00:00Z')).toBe(2);
    expect(localWeekdayInZone('2026-08-16T09:00:00Z', 'UTC')).toBe(0);
    expect(localWeekdayInZone('2026-08-15T23:59:00Z', 'UTC')).toBe(6); // Saturday
  });

  it('shifts into the recipient zone (DST-correct via the local calendar day)', () => {
    // 2026-08-11T02:00Z is Tuesday in UTC, but 2026-08-10T19:00 (Monday) in LA (UTC-7).
    expect(localWeekdayInZone('2026-08-11T02:00:00Z')).toBe(2); // Tue in UTC
    expect(localWeekdayInZone('2026-08-11T02:00:00Z', 'America/Los_Angeles')).toBe(1); // Mon in LA
    // The other direction: 2026-08-11T23:00Z is Tuesday, but Wednesday in Tokyo (UTC+9).
    expect(localWeekdayInZone('2026-08-11T23:00:00Z', 'Asia/Tokyo')).toBe(3); // Wed in Tokyo
  });

  it('is null on an unparseable instant, never a throw', () => {
    expect(localWeekdayInZone('not-a-date')).toBeNull();
    expect(localWeekdayInZone(null)).toBeNull();
    expect(localWeekdayInZone(undefined)).toBeNull();
  });
});

describe('bucketKeptByWeekday — 7 per-weekday kept counts', () => {
  it('buckets each kept instant into its local weekday, quiet weekdays are genuine zeros', () => {
    const buckets = bucketKeptByWeekday({
      timestamps: [
        '2026-08-11T14:00:00Z', '2026-08-18T14:00:00Z', // two Tuesdays
        '2026-08-16T14:00:00Z', // one Sunday
      ],
      timezone: 'UTC',
    });
    expect(buckets).toHaveLength(7);
    expect(buckets[2].count).toBe(2); // Tuesday
    expect(buckets[0].count).toBe(1); // Sunday
    expect(buckets[1].count).toBe(0); // Monday — quiet, a genuine zero
    // every entry is a plain {weekday,count}; the index is the weekday.
    buckets.forEach((b, i) => expect(b.weekday).toBe(i));
  });

  it('is empty/garbage-safe — bad input never throws, quiet everywhere', () => {
    for (const bad of [undefined, null, 'x', [123, null, {}]]) {
      const buckets = bucketKeptByWeekday({ timestamps: bad, timezone: 'UTC' });
      expect(buckets).toHaveLength(7);
      expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(0);
    }
  });
});

describe('peakKeptWeekday — the single trustworthy peak weekday, or null', () => {
  // a small helper: build a 7-bucket histogram from {weekday: count}.
  const hist = (m) => Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: m[weekday] || 0 }));

  it('names the single tallest weekday once the signal clears the gate', () => {
    const peak = peakKeptWeekday(hist({ 2: 6, 1: 2, 3: 2, 4: 2 })); // total 12, Tue=6 leads
    expect(peak).not.toBeNull();
    expect(peak.weekday).toBe(2);
    expect(peak.count).toBe(6);
    expect(peak.total).toBe(12);
    expect(peak.share).toBeCloseTo(0.5, 5);
  });

  it('is null when the total history is too thin to trust', () => {
    const thin = hist({ 2: 4, 3: 2 }); // total 6 < POWER_DAY_MIN_TOTAL
    expect(peakKeptWeekday(thin)).toBeNull();
    expect(POWER_DAY_MIN_TOTAL).toBeGreaterThan(6);
  });

  it('is null when the peak weekday itself is below the peak floor', () => {
    // total clears the min, but every weekday is short → no peak worth naming.
    const flat = hist({ 0: 3, 1: 3, 2: 3, 3: 3 }); // total 12, peak only 3
    expect(peakKeptWeekday(flat)).toBeNull();
    expect(POWER_DAY_MIN_PEAK).toBeGreaterThan(3);
  });

  it('is null on a TIE for the top — no single power day to name', () => {
    const tied = hist({ 2: 6, 5: 6 }); // total 12, peak 6, but two weekdays tie
    expect(peakKeptWeekday(tied)).toBeNull();
  });

  it('is empty/garbage-safe', () => {
    expect(peakKeptWeekday(undefined)).toBeNull();
    expect(peakKeptWeekday([])).toBeNull();
    expect(peakKeptWeekday('x')).toBeNull();
    expect(peakKeptWeekday([{ weekday: 'x', count: 'y' }])).toBeNull();
  });
});

describe('describeWeekday — the warm long name of a weekday', () => {
  it('names each weekday (0=Sunday..6=Saturday)', () => {
    expect(describeWeekday(0)).toBe('Sunday');
    expect(describeWeekday(1)).toBe('Monday');
    expect(describeWeekday(2)).toBe('Tuesday');
    expect(describeWeekday(6)).toBe('Saturday');
  });

  it('is empty for a non-weekday, never a throw', () => {
    for (const bad of [-1, 7, 2.5, NaN, 'x', null, undefined]) {
      expect(describeWeekday(bad)).toBe('');
    }
  });
});

// ── the copy ─────────────────────────────────────────────────
describe('powerDayCopy — the warm "you\'re strongest on X" read', () => {
  it('fires with a non-empty line naming the weekday when given a peak', () => {
    const line = powerDayCopy({ peak: { weekday: 2, count: 6 } });
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line).toContain('Tuesday');
    expect(line.toLowerCase()).toContain('strongest');
  });

  it('reads in both personas, each naming the weekday', () => {
    const ally = powerDayCopy({ peak: { weekday: 5, count: 5 }, persona: 'ally' });
    expect(ally).toContain('Friday');
    const hype = powerDayCopy({ peak: { weekday: 5, count: 5 }, persona: 'hype' });
    expect(hype).toContain('Friday');
    expect(hype).not.toBe(ally);
  });

  it('is SILENT when there is no trustworthy peak (gate returned null)', () => {
    expect(powerDayCopy({ peak: null })).toBe('');
    expect(powerDayCopy({ peak: undefined })).toBe('');
    expect(powerDayCopy({})).toBe('');
    expect(powerDayCopy()).toBe('');
  });

  it('is garbage-safe — a peak with a junk weekday returns \'\', never a throw', () => {
    expect(powerDayCopy({ peak: { weekday: 'x' } })).toBe('');
    expect(powerDayCopy({ peak: { weekday: 99, count: 5 } })).toBe('');
    expect(powerDayCopy({ peak: {} })).toBe('');
  });

  // proof-of-rejection: the scanner can actually FAIL, so "clean" below isn't vacuous.
  it('the design-LAW scanner can reject shame — it is not a vacuous guard', () => {
    expect(scanDesignLaw('you always fail on Mondays, you fell behind again').length).toBeGreaterThan(0);
  });

  it('every power-day line is design-LAW clean (no shame, no "AI", no clinical claim)', () => {
    const surface = [powerDayHeadingCopy(), powerDayIntroCopy()];
    for (let w = 0; w < 7; w++) {
      surface.push(powerDayCopy({ peak: { weekday: w, count: 5 } }));
      surface.push(powerDayCopy({ peak: { weekday: w, count: 5 }, persona: 'hype' }));
    }
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(scanDesignLaw(s), `${JSON.stringify(s)} must be design-LAW clean`).toEqual([]);
    }
  });

  it('never names a deficit, a comparison, or the days that were missed — only the strength', () => {
    for (const w of [0, 1, 2, 3, 4, 5, 6]) {
      for (const persona of ['ally', 'hype']) {
        const line = powerDayCopy({ peak: { weekday: w, count: 5 }, persona }).toLowerCase();
        if (!line) continue;
        expect(
          /\bworst\b|\bweak(est)?\b|\bnever\b|\bavoid\b|\bstruggle\b|\bslump\b|\bmiss/.test(line),
          line,
        ).toBe(false);
      }
    }
  });
});

// ── route wiring: GET /api/accountability/kept carries `power_day` ──
// Mirrors power-hours.test.js: any non-JOIN commitment_checkins query returns
// `windowTimestamps`, so the all-time scan the power-day read reuses is assembled
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

// 6 Tuesdays lead; 2 Mondays + 2 Wednesdays + 2 Thursdays fill (total 12). All at
// 02:00 UTC, so in America/Los_Angeles (UTC-7) each instant falls on the PRIOR
// weekday — the Tuesday peak becomes a Monday peak, proving the zone shift.
const TUE_PEAK_TIMESTAMPS = [
  '2026-07-21T02:00:00Z', '2026-07-28T02:00:00Z', '2026-08-04T02:00:00Z',
  '2026-08-11T02:00:00Z', '2026-08-18T02:00:00Z', '2026-08-25T02:00:00Z', // 6 Tuesdays
  '2026-08-03T02:00:00Z', '2026-08-10T02:00:00Z', // 2 Mondays
  '2026-08-05T02:00:00Z', '2026-08-12T02:00:00Z', // 2 Wednesdays
  '2026-08-06T02:00:00Z', '2026-08-13T02:00:00Z', // 2 Thursdays
];

describe('GET /api/accountability/kept — your power day rides alongside the other reads', () => {
  it('returns a non-empty power-day line naming the peak weekday when there is enough kept history', async () => {
    const db = makeDB({ windowTimestamps: TUE_PEAK_TIMESTAMPS, streak: { total_kept: 12 }, timezone: 'UTC' });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.power_day).toBe('string');
    expect(body.power_day.trim().length).toBeGreaterThan(0);
    expect(body.power_day).toContain('Tuesday');
    expect(scanDesignLaw(body.power_day)).toEqual([]);
  });

  it('respects the recipient timezone: the same instants shift the named weekday', async () => {
    // America/Los_Angeles (UTC-7 in August): each 02:00Z instant → prior day → Monday peak.
    const db = makeDB({ windowTimestamps: TUE_PEAK_TIMESTAMPS, streak: { total_kept: 12 }, timezone: 'America/Los_Angeles' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.power_day).toContain('Monday');
    expect(body.power_day).not.toContain('Tuesday');
  });

  it('sends an EMPTY power-day line when the history is too thin to trust (card stays hidden)', async () => {
    const windowTimestamps = ['2026-08-11T14:00:00Z', '2026-08-18T14:00:00Z', '2026-08-25T14:00:00Z']; // 3 < min
    const db = makeDB({ windowTimestamps, streak: { total_kept: 3 }, timezone: 'UTC' });
    const body = await (await buildRouter(db)('GET', '/api/accountability/kept')).json();
    expect(body.power_day).toBe('');
  });

  it('is empty-safe: no kept words at all → \'\' (never a blank panel, never a guess)', async () => {
    const db = makeDB({ windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.power_day).toBe('');
    expect(res.status).toBe(200);
  });

  it('the power-day read comes from a status=\'kept\' scan ONLY — never a miss series', async () => {
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
