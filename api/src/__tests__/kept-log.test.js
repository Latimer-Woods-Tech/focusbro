/**
 * FocusBro — kept-word log (Contender #10, Phase A).
 *
 * The one surface a to-do app turns into a guilt engine is the history view: a
 * scrollable wall of past misses in red. This slice adds the OPPOSITE — a record
 * of every word the person KEPT, most recent first. The DESIGN LAW lives in the
 * query itself: GET /api/accountability/kept reads ONLY status='kept' check-ins,
 * so a set-down or moved word can never appear here. There is deliberately no
 * "missed" list anywhere in the product.
 *
 * This suite drives the real route through itty-router with an in-memory D1
 * double, asserts the momentum-only query shape, and runs the design-LAW scan on
 * the kept-log copy.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerAccountabilityRoutes, keptLogCopy } from '../accountability.js';
import { keptLogHeadingCopy, keptLogEmptyCopy } from '../me.js';
import { generateUUID } from '../middleware.js';

// ── router harness (mirrors pause-resume.test.js) ────────────
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

// In-memory D1 double. `.all()` on the kept JOIN query returns `kept`; `.first()`
// on the streak row returns `streak`. Records the SQL of every query so the test
// can assert the momentum-only shape (status = 'kept', no 'missed').
function makeDB({ kept = [], streak = null } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM accountability_streaks/.test(sql)) return streak;
          return null;
        },
        async all() {
          if (/FROM commitment_checkins/.test(sql) && /JOIN commitments/.test(sql)) {
            return { results: kept };
          }
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

const KEPT_ROWS = [
  { kept_at: '2026-07-09T14:00:00Z', title: 'start the taxes' },
  { kept_at: '2026-07-08T09:00:00Z', title: 'call the dentist' },
];

describe('GET /api/accountability/kept — the record of words you kept', () => {
  it('returns the kept list, the lifetime total, and a warm message', async () => {
    const db = makeDB({ kept: KEPT_ROWS, streak: { current_streak: 2, longest_streak: 5, total_kept: 12, last_kept_date: '2026-07-09' } });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kept).toEqual(KEPT_ROWS);
    expect(body.total_kept).toBe(12); // lifetime, from the streak row (honest past the window)
    expect(typeof body.message).toBe('string');
    expect(body.message.trim().length).toBeGreaterThan(0);
  });

  it('reads ONLY kept check-ins — momentum-only by construction (never a miss list)', async () => {
    const db = makeDB({ kept: KEPT_ROWS, streak: null });
    await buildRouter(db)('GET', '/api/accountability/kept');
    const joinQuery = db.queries.find((q) => /FROM commitment_checkins/.test(q) && /JOIN commitments/.test(q));
    expect(joinQuery, 'the kept-log query ran').toBeTruthy();
    expect(/status = 'kept'/.test(joinQuery)).toBe(true);
    // The DESIGN LAW, enforced at the query: no 'missed' anywhere in the log query.
    expect(/missed/i.test(joinQuery)).toBe(false);
  });

  it('is empty-safe: no kept words, no streak row → empty list, zero total', async () => {
    const db = makeDB({ kept: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kept).toEqual([]);
    expect(body.total_kept).toBe(0);
    expect(body.message.trim().length).toBeGreaterThan(0); // an invitation, never blank
  });

  it('401s without a valid token, and never queries the database', async () => {
    const db = makeDB({ kept: KEPT_ROWS });
    const res = await buildRouter(db)('GET', '/api/accountability/kept', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.queries.length).toBe(0);
  });
});

// ── the design LAW on the kept-log copy ──────────────────────
describe('kept-log copy — a positive record, never a scold', () => {
  const SHAME = [
    /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
    /\bashamed\b/i, /\bshame\b/i, /\bmiss(ed|ing|es)?\b/i, /\bbehind\b/i,
    /\byou (didn.?t|should have|should.?ve)\b/i, /\bexcuse/i, /\bpathetic\b/i, /\bworthless\b/i,
  ];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI = /\bAI\b/;

  const samples = ['ally', 'hype', 'unknown'].flatMap((persona) => [
    keptLogCopy({ total: 0, persona }),
    keptLogCopy({ total: 1, persona }),
    keptLogCopy({ total: 12, persona }),
    keptLogCopy({ persona }), // no total → treated as zero
  ]).concat([keptLogHeadingCopy(), keptLogEmptyCopy()]);

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
      const s = keptLogCopy({ total: 0, persona }).toLowerCase();
      expect(/first/.test(s)).toBe(true); // points forward to the first kept word
    }
  });
  it('singular vs plural is grammatical', () => {
    expect(keptLogCopy({ total: 1 })).toMatch(/\b1 word\b/);
    expect(keptLogCopy({ total: 3 })).toMatch(/\b3 words\b/);
  });
});

// ── the kept endpoint also returns your own momentum block ───
// The same sparkline the coach sees, turned around for the person's own eyes.
// A richer D1 double that answers the windowed momentum query (non-JOIN) and the
// representative-timezone lookup, so the assembled block can be asserted.
function makeMomentumDB({ keptLog = [], windowTimestamps = [], streak = null, timezone = null } = {}) {
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

describe('GET /api/accountability/kept — your own momentum block', () => {
  it('returns a momentum block: buckets, a sparkline, a first-person summary', async () => {
    const db = makeMomentumDB({
      keptLog: KEPT_ROWS,
      windowTimestamps: ['2026-07-09T14:00:00Z', '2026-07-09T18:00:00Z', '2026-07-08T09:00:00Z'],
      streak: { total_kept: 3 },
      timezone: 'UTC',
    });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.momentum, 'momentum block present').toBeTruthy();
    expect(Array.isArray(body.momentum.buckets)).toBe(true);
    expect(body.momentum.buckets.length).toBeGreaterThan(0);
    expect(typeof body.momentum.sparkline).toBe('string');
    expect(body.momentum.sparkline.length).toBeGreaterThan(0);
    expect(typeof body.momentum.summary).toBe('string');
    // First-person voice (the person's own eyes), never the coach's third person.
    expect(body.momentum.intro.toLowerCase()).toContain('you');
    expect(/their/i.test(body.momentum.summary + body.momentum.intro)).toBe(false);
  });

  it('the momentum window reads status=\'kept\' ONLY — never a miss series', async () => {
    const db = makeMomentumDB({ keptLog: KEPT_ROWS, windowTimestamps: [], streak: null });
    await buildRouter(db)('GET', '/api/accountability/kept');
    const windowQuery = db.queries.find((q) => /FROM commitment_checkins/.test(q) && !/JOIN commitments/.test(q) && /responded_at >=/.test(q));
    expect(windowQuery, 'the windowed momentum query ran').toBeTruthy();
    expect(/status = 'kept'/.test(windowQuery)).toBe(true);
    expect(/missed/i.test(windowQuery)).toBe(false);
  });

  it('a person with no kept words gets a quiet momentum block, never a miss grid', async () => {
    const db = makeMomentumDB({ keptLog: [], windowTimestamps: [], streak: null });
    const res = await buildRouter(db)('GET', '/api/accountability/kept');
    const body = await res.json();
    expect(body.momentum.total).toBe(0);
    expect(body.momentum.summary.toLowerCase()).toMatch(/clean page|fresh start/);
    expect(/\bmiss(ed|es|ing)?\b/i.test(body.momentum.summary)).toBe(false);
  });
});
