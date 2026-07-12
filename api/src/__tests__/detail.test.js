/**
 * FocusBro — per-word detail view (Contender #10, Phase A).
 *
 * The forward accountability loop (give your word → check-in → kept-word streak)
 * and the cross-word kept log already exist. This slice adds a look at ONE word's
 * momentum: its cadence, the next time the bro shows up, and the timeline of
 * check-ins you KEPT on that word. The DESIGN LAW lives in the query itself —
 * GET /api/commitments/:id/detail reads ONLY status='kept' check-ins for the
 * timeline, so a set-down or missed check-in can never appear. There is no
 * per-word miss list anywhere in the product.
 *
 * This suite drives the real route through itty-router with an in-memory D1
 * double, asserts the momentum-only query shape, and runs the design-LAW scan on
 * the detail copy.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerAccountabilityRoutes, commitmentDetailCopy,
  detailMomentumHeadingCopy, detailMomentumIntroCopy, detailMomentumSummaryCopy,
  detailPeakDayCopy,
} from '../accountability.js';
import { describePeakDay } from '../momentum.js';
import { detailActionLabel, detailKeptHeadingCopy, detailNextLabelCopy } from '../me.js';
import { generateUUID } from '../middleware.js';

// ── router harness (mirrors kept-log.test.js) ────────────────
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

// In-memory D1 double for the detail route. Distinguishes the four queries:
//   • commitment SELECT     → FROM commitments (the row)
//   • kept timeline .all()  → responded_at AS kept_at (status='kept')
//   • kept COUNT .first()   → COUNT(*)
//   • next check-in .first()→ scheduled_for … status IN (…)
// Records every SQL string so the test can assert the momentum-only shape.
function makeDB({ commitment = null, kept = [], keptCount = 0, next = null } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments\b/.test(sql)) return commitment;
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
    const req = new Request('https://x' + path, { method, headers });
    return router.handle(req, env);
  };
}

const ACTIVE = {
  id: 'c1', title: 'start the taxes', details: '', start_at: '2026-07-10T14:00:00Z',
  checkin_at: '2026-07-10T15:00:00Z', channel: 'text', persona: 'ally', timezone: 'UTC',
  recurrence: 'daily', local_time: '14:00', status: 'active', created_at: '2026-07-01T00:00:00Z',
};
const KEPT_ROWS = [
  { kept_at: '2026-07-09T14:00:00Z', note: '' },
  { kept_at: '2026-07-08T14:00:00Z', note: 'knocked it out early' },
];

describe('GET /api/commitments/:id/detail — one word\'s momentum', () => {
  it('returns the word, its cadence, the next check-in, and the kept timeline', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: KEPT_ROWS, keptCount: 2, next: { scheduled_for: '2026-07-11T14:00:00Z' } });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commitment.id).toBe('c1');
    expect(body.cadence).toMatch(/every day/i);       // describeCadence('daily','14:00')
    expect(body.next_checkin).toBe('2026-07-11T14:00:00Z');
    expect(body.kept).toEqual(KEPT_ROWS);
    expect(body.kept_count).toBe(2);
    expect(typeof body.message).toBe('string');
    expect(body.message.trim().length).toBeGreaterThan(0);
  });

  it('the timeline query reads ONLY kept check-ins — never a miss list', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: KEPT_ROWS, keptCount: 2 });
    await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const timeline = db.queries.find((q) => /responded_at AS kept_at/.test(q));
    expect(timeline, 'the kept-timeline query ran').toBeTruthy();
    expect(/status = 'kept'/.test(timeline)).toBe(true);
    // The DESIGN LAW at the query: nothing in the detail flow selects a miss.
    for (const q of db.queries) expect(/'missed'/.test(q), `query selected a miss: ${q}`).toBe(false);
  });

  it('kept_count comes from COUNT(*) — honest past the rendered 50-row window', async () => {
    // Only 2 rows rendered, but the lifetime count for this word is 137.
    const db = makeDB({ commitment: ACTIVE, kept: KEPT_ROWS, keptCount: 137, next: null });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const body = await res.json();
    expect(body.kept.length).toBe(2);
    expect(body.kept_count).toBe(137);
    expect(db.queries.some((q) => /COUNT\(\*\)/.test(q))).toBe(true);
  });

  it('does not surface a next check-in for a word that is not active, and skips that query', async () => {
    const done = { ...ACTIVE, status: 'kept' };
    const db = makeDB({ commitment: done, kept: KEPT_ROWS, keptCount: 2, next: { scheduled_for: '2026-07-11T14:00:00Z' } });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const body = await res.json();
    expect(body.next_checkin).toBeNull();
    // The upcoming-check-in query is active-only; it must not run for a wrapped word.
    expect(db.queries.some((q) => /scheduled_for\b/.test(q) && /status IN/.test(q))).toBe(false);
  });

  it('is empty-safe: a word kept nothing yet → empty timeline, zero count, an invitation', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [], keptCount: 0, next: null });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kept).toEqual([]);
    expect(body.kept_count).toBe(0);
    expect(body.message.trim().length).toBeGreaterThan(0);
  });

  it('404s for a word that is not the caller\'s (or does not exist)', async () => {
    const db = makeDB({ commitment: null });
    const res = await buildRouter(db)('GET', '/api/commitments/nope/detail');
    expect(res.status).toBe(404);
  });

  it('401s without a valid token, and never queries the database', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: KEPT_ROWS });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.queries.length).toBe(0);
  });
});

// ── the per-word momentum block on the detail response ───────
// Kept rows anchored to "now" so the 14-day window is deterministic regardless
// of the wall clock (the endpoint buckets kept instants against the real now).
function keptAgoDays(...deltas) {
  return deltas.map((d) => ({ kept_at: new Date(Date.now() - d * 86400000).toISOString(), note: '' }));
}

describe('GET /api/commitments/:id/detail — per-word momentum sparkline', () => {
  it('attaches a kept-only momentum block: a 14-day bucket axis, a sparkline, and the total', async () => {
    const kept = keptAgoDays(1, 2, 2, 10); // 4 kept, two on the same day 2 days ago
    const db = makeDB({ commitment: ACTIVE, kept, keptCount: 4 });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const body = await res.json();
    expect(body.momentum).toBeTruthy();
    expect(Array.isArray(body.momentum.buckets)).toBe(true);
    expect(body.momentum.buckets.length).toBe(14);           // MOMENTUM_WINDOW_DAYS
    expect(typeof body.momentum.sparkline).toBe('string');
    expect(body.momentum.sparkline.length).toBe(14);          // one glyph per day
    expect(body.momentum.total).toBe(4);                      // all 4 inside the window
    expect(body.momentum.peak.count).toBe(2);                // busiest day had 2
    expect(body.momentum.intro.trim().length).toBeGreaterThan(0);
    expect(body.momentum.summary.trim().length).toBeGreaterThan(0);
    // A genuine standout (2 kept in one day) earns a warm peak-day callout.
    expect(typeof body.momentum.peakDay).toBe('string');
    expect(body.momentum.peakDay).toMatch(/best day on this word so far/i);
    expect(body.momentum.peakDay).toContain('2 kept');
  });

  it('names no "best day" when every kept day is a single — no arbitrary peak', async () => {
    // Four kept, each on a distinct day → peak count 1 → no standout to celebrate.
    const db = makeDB({ commitment: ACTIVE, kept: keptAgoDays(1, 3, 5, 8), keptCount: 4 });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const body = await res.json();
    expect(body.momentum.peak.count).toBe(1);
    expect(body.momentum.peakDay).toBe('');
  });

  it('a never-yet-kept word has no peak-day callout (empty-safe)', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [], keptCount: 0 });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const body = await res.json();
    expect(body.momentum.peakDay).toBe('');
  });

  it('buckets in the word\'s own timezone', async () => {
    const db = makeDB({ commitment: { ...ACTIVE, timezone: 'America/New_York' }, kept: keptAgoDays(1), keptCount: 1 });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const body = await res.json();
    expect(body.momentum.timezone).toBe('America/New_York');
  });

  it('is empty-safe: a never-yet-kept word → total 0, a flat baseline, no NaN', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: [], keptCount: 0 });
    const res = await buildRouter(db)('GET', '/api/commitments/c1/detail');
    const body = await res.json();
    expect(body.momentum.total).toBe(0);
    expect(body.momentum.buckets.length).toBe(14);
    expect(body.momentum.buckets.every((b) => b.count === 0)).toBe(true);
    expect(body.momentum.summary).toMatch(/clean stretch/i); // reads as a fresh page, never "you did nothing"
  });

  it('the momentum block is built from the kept timeline only — no extra miss query', async () => {
    const db = makeDB({ commitment: ACTIVE, kept: keptAgoDays(1, 3), keptCount: 2 });
    await buildRouter(db)('GET', '/api/commitments/c1/detail');
    for (const q of db.queries) expect(/'missed'/.test(q), `query selected a miss: ${q}`).toBe(false);
  });
});

// ── the design LAW on the detail copy ────────────────────────
describe('per-word detail copy — momentum, never a scold', () => {
  const SHAME = [
    /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
    /\bashamed\b/i, /\bshame\b/i, /\bmiss(ed|ing|es)?\b/i, /\bbehind\b/i,
    /\byou (didn.?t|should have|should.?ve)\b/i, /\bexcuse/i, /\bpathetic\b/i, /\bworthless\b/i,
  ];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI = /\bAI\b/;

  const samples = ['ally', 'hype', 'unknown'].flatMap((persona) => [
    commitmentDetailCopy({ keptCount: 0, persona }),
    commitmentDetailCopy({ keptCount: 1, persona }),
    commitmentDetailCopy({ keptCount: 9, persona }),
    commitmentDetailCopy({ persona }), // no count → treated as zero
  ]).concat([
    detailActionLabel(), detailKeptHeadingCopy(), detailNextLabelCopy(),
    detailMomentumHeadingCopy(), detailMomentumIntroCopy(),
    detailMomentumSummaryCopy({ total: 0, days: 14 }),
    detailMomentumSummaryCopy({ total: 1, days: 14, peak: { count: 1 } }),
    detailMomentumSummaryCopy({ total: 6, days: 14, peak: { count: 2 } }),
    detailPeakDayCopy({ count: 2, whenPhrase: 'today' }),
    detailPeakDayCopy({ count: 3, whenPhrase: 'Wednesday' }),
    detailPeakDayCopy({ count: 5, whenPhrase: 'Monday, Jul 2' }),
  ]);

  it('are non-empty strings', () => {
    for (const s of samples) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });
  it('never shame (incl. "miss" / "behind")', () => {
    for (const s of samples) for (const p of SHAME) expect(p.test(s), `"${s}" matched ${p}`).toBe(false);
  });
  it('never say "AI" and never make a clinical claim', () => {
    for (const s of samples) {
      expect(AI.test(s), `"AI" leaked: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical: "${s}" matched ${p}`).toBe(false);
    }
  });
  it('an empty record reads as an invitation, not "you have done nothing"', () => {
    for (const persona of ['ally', 'hype']) {
      const s = commitmentDetailCopy({ keptCount: 0, persona }).toLowerCase();
      expect(/first|yet/.test(s)).toBe(true); // points forward, not at a void
    }
  });
  it('singular vs plural is grammatical', () => {
    expect(commitmentDetailCopy({ keptCount: 1 })).toMatch(/\b1 time\b/);
    expect(commitmentDetailCopy({ keptCount: 4 })).toMatch(/\b4 times\b/);
  });
});

// ── describePeakDay — warm, unambiguous naming of the peak day ─
describe('describePeakDay — names the peak day, never mistakable', () => {
  const now = '2026-07-11T18:00:00Z'; // a Saturday, UTC

  it('says "today" / "yesterday" for the two most recent days', () => {
    expect(describePeakDay('2026-07-11', { nowISO: now, timezone: 'UTC' })).toBe('today');
    expect(describePeakDay('2026-07-10', { nowISO: now, timezone: 'UTC' })).toBe('yesterday');
  });

  it('uses a plain weekday within the last week (2–6 days back)', () => {
    expect(describePeakDay('2026-07-09', { nowISO: now, timezone: 'UTC' })).toBe('Thursday');
    expect(describePeakDay('2026-07-05', { nowISO: now, timezone: 'UTC' })).toBe('Sunday');
  });

  it('pins the date once a week or more has passed, so it cannot read as this week', () => {
    // 7+ days back: weekday alone would be ambiguous, so the calendar date is added.
    expect(describePeakDay('2026-07-02', { nowISO: now, timezone: 'UTC' })).toBe('Thursday, Jul 2');
  });

  it('resolves the day boundary in the given timezone', () => {
    // 02:30Z on the 12th is still the 11th in New York.
    const nyNow = '2026-07-12T02:30:00Z';
    expect(describePeakDay('2026-07-11', { nowISO: nyNow, timezone: 'America/New_York' })).toBe('today');
  });

  it('returns "" for a missing or malformed label (an all-quiet peak has no date)', () => {
    expect(describePeakDay(null, { nowISO: now, timezone: 'UTC' })).toBe('');
    expect(describePeakDay('', { nowISO: now, timezone: 'UTC' })).toBe('');
    expect(describePeakDay('nope', { nowISO: now, timezone: 'UTC' })).toBe('');
  });
});

describe('detailPeakDayCopy — celebrates a standout, never a comparison to now', () => {
  it('names the day and count for a real standout (2+ kept)', () => {
    const s = detailPeakDayCopy({ count: 3, whenPhrase: 'Wednesday' });
    expect(s).toContain('Wednesday');
    expect(s).toContain('3 kept');
    expect(s).toMatch(/so far/); // forward-looking framing, not "you were better before"
  });

  it('is silent below the standout threshold or with no day to name', () => {
    expect(detailPeakDayCopy({ count: 1, whenPhrase: 'Wednesday' })).toBe('');
    expect(detailPeakDayCopy({ count: 3, whenPhrase: '' })).toBe('');
    expect(detailPeakDayCopy({})).toBe('');
  });
});
