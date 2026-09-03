/**
 * FocusBro — coach client-DETAIL next-check-in honors a passed-but-open moment
 * (Contender #10, Phase A).
 *
 * The coach's client-detail rhythm panel (GET /api/coach/clients/:id →
 * active_commitments, rendered by index.js renderRhythm) prints a per-commitment
 * `next_checkin_label` for the soonest OUTSTANDING check-in. That check-in comes
 * from `MIN(scheduled_for)` over statuses pending/sent/deferred/awaiting_time —
 * and because a slipped, quiet-hours-, or night-deferred delivery is left pending
 * with its `scheduled_for` UNCHANGED (in the past — the #338 behavior), that MIN
 * can already be past.
 *
 * The roster (rosterNextCheckinLine, R-234) and the person's own per-word detail
 * panel (me.js renderDetail, R-339) already fall to the warm "still here whenever
 * they're ready" line once that moment has passed but the check-in is still open.
 * The coach client-DETAIL label was the last surface still calling nextCheckinCopy
 * directly — which names the time unconditionally — so a passed-but-open moment
 * printed a stale "Next up <time already gone>", reading as the ally having
 * no-showed on that word. THE DESIGN LAW forbids exactly that reliability-
 * undermining signal.
 *
 * This slice routes that label through the new `detailNextCheckinCopy`, which
 * branches passed-but-open→warm / future→named / nothing-queued→"lining up",
 * reusing rosterNextCheckinWaitingCopy() and nextCheckinCopy() verbatim so the
 * roster, this detail label, and the person's detail panel can never diverge.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerCoachRoutes,
  detailNextCheckinCopy,
  rosterNextCheckinWaitingCopy,
  nextCheckinCopy,
} from '../coach.js';
import { generateUUID } from '../middleware.js';
import { scanDesignLaw } from '../design-law.js';

// One canonical design-LAW lexicon + the per-surface scheduling extras this line
// must never use (miss-framing / app-name "slack" — this label never names the
// app / bare "should have"). Mirrors the roster next-check-in surface (R-234).
const localExtras = /\b(late|overdue|slack(ing)?|should have)\b/i;
const hasBanned = (s) => scanDesignLaw(String(s)).length > 0 || localExtras.test(String(s));

// ── pure helper: detailNextCheckinCopy ───────────────────────
describe('detailNextCheckinCopy — the coach client-detail next-check-in label', () => {
  const NOW = '2026-07-12T12:00:00Z';

  it('a FUTURE outstanding check-in is still named outright ("Next up …")', () => {
    const s = detailNextCheckinCopy({ iso: '2026-07-12T15:00:00Z', timezone: 'UTC', nowISO: NOW });
    expect(s.startsWith('Next up')).toBe(true);
    // Identical to the plain time-naming copy for a future moment — same voice.
    expect(s).toBe(nextCheckinCopy({ iso: '2026-07-12T15:00:00Z', timezone: 'UTC', nowISO: NOW }));
  });

  it('a PASSED-but-open check-in reads as the warm waiting line, never a stale time', () => {
    const s = detailNextCheckinCopy({ iso: '2026-07-12T09:00:00Z', timezone: 'UTC', nowISO: NOW });
    expect(s).toBe(rosterNextCheckinWaitingCopy());
    expect(s.startsWith('Next up')).toBe(false);
    expect(/late|overdue|miss|behind|09:|9:00/i.test(s)).toBe(false);
  });

  it('nothing queued (null / invalid) stays warmly forward ("lining up"), never blank', () => {
    expect(detailNextCheckinCopy({ iso: null, nowISO: NOW })).toBe(nextCheckinCopy({ iso: null }));
    expect(detailNextCheckinCopy({ iso: 'not-a-date', nowISO: NOW })).toBe(nextCheckinCopy({ iso: null }));
    expect(detailNextCheckinCopy({})).toBe(nextCheckinCopy({ iso: null }));
    // Unlike the roster's at-a-glance line, the detail panel keeps a warm line.
    expect(detailNextCheckinCopy({ iso: null }).length).toBeGreaterThan(0);
  });

  it('defaults nowISO to the real clock when omitted (a past iso still reads warm)', () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    expect(detailNextCheckinCopy({ iso: past, timezone: 'UTC' })).toBe(rosterNextCheckinWaitingCopy());
    expect(detailNextCheckinCopy({ iso: future, timezone: 'UTC' }).startsWith('Next up')).toBe(true);
  });

  it('every branch obeys THE DESIGN LAW (no shame, "AI", clinical, or miss-framing)', () => {
    for (const s of [
      detailNextCheckinCopy({ iso: '2026-07-12T15:00:00Z', timezone: 'UTC', nowISO: NOW }),
      detailNextCheckinCopy({ iso: '2026-07-12T09:00:00Z', timezone: 'UTC', nowISO: NOW }),
      detailNextCheckinCopy({ iso: null }),
    ]) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
      expect(hasBanned(s), `banned word in: "${s}"`).toBe(false);
    }
  });
});

// ── integration: GET /api/coach/clients/:clientId → active_commitments ───
// The load-bearing proof-of-rejection: drive the REAL route and assert the
// rendered per-commitment label, not just the extracted helper.
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (request) => {
    const h = request.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (token) => (token === 'good' ? { sub: 'coach1' } : null),
  jsonResponse,
  generateUUID,
};

// In-memory D1 double for the client-detail route (mirrors coach-client-weekly).
function makeDB({ link, streak, commitments = [], nextRows = [], tz = 'UTC', kept = [], delivered = [] } = {}) {
  return {
    prepare(sql) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM coach_clients/.test(sql)) return link || null;
          if (/FROM accountability_streaks/.test(sql)) return streak || null;
          if (/SELECT timezone\s+FROM commitments/.test(sql)) return tz ? { timezone: tz } : null;
          return null;
        },
        async all() {
          if (/FROM commitments/.test(sql) && /status = 'active'/.test(sql)) return { results: commitments };
          if (/MIN\(scheduled_for\)/.test(sql)) return { results: nextRows };
          if (/status = 'kept'/.test(sql)) return { results: kept.map((t) => ({ responded_at: t })) };
          if (/FROM analytics_events/.test(sql)) return { results: delivered.map((t) => ({ created_at: t })) };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
}

function call(db, path, { token = 'good' } = {}) {
  const router = Router();
  registerCoachRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  const req = new Request('https://x' + path, { method: 'GET', headers });
  return router.handle(req, env);
}

const H = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const activeWord = (over = {}) => ({
  id: 'c1', title: 'Taxes', start_at: iso(2 * H), checkin_at: iso(2 * H),
  status: 'active', recurrence: 'none', local_time: null, timezone: 'UTC', ...over,
});

describe('GET /api/coach/clients/:clientId — the per-word next-check-in label honors a passed-but-open moment', () => {
  it('a PASSED-but-open check-in renders the warm waiting line, NOT a stale "Next up <past>"', async () => {
    const pastMoment = iso(1 * H); // scheduled_for one hour in the PAST, still open
    const db = makeDB({
      link: { client_label: 'Alex', status: 'active' },
      streak: { current_streak: 3, longest_streak: 5, total_kept: 12 },
      commitments: [activeWord()],
      nextRows: [{ commitment_id: 'c1', next_for: pastMoment }],
    });
    const res = await call(db, '/api/coach/clients/u-a');
    expect(res.status).toBe(200);
    const body = await res.json();
    const word = body.active_commitments.find((c) => c.title === 'Taxes');
    expect(word.next_checkin).toBe(pastMoment); // the raw past moment is still carried
    // The RENDERED label is warm, never the stale past time. This is the whole slice:
    expect(word.next_checkin_label).toBe(rosterNextCheckinWaitingCopy());
    expect(word.next_checkin_label.startsWith('Next up')).toBe(false);
    expect(hasBanned(word.next_checkin_label)).toBe(false);
  });

  it('a FUTURE check-in is still named outright ("Next up …")', async () => {
    const db = makeDB({
      link: { client_label: 'Alex', status: 'active' },
      streak: { current_streak: 1, longest_streak: 2, total_kept: 4 },
      commitments: [activeWord()],
      nextRows: [{ commitment_id: 'c1', next_for: new Date(Date.now() + 2 * H).toISOString() }],
    });
    const res = await call(db, '/api/coach/clients/u-a');
    const body = await res.json();
    const word = body.active_commitments.find((c) => c.title === 'Taxes');
    expect(word.next_checkin_label.startsWith('Next up')).toBe(true);
    expect(hasBanned(word.next_checkin_label)).toBe(false);
  });

  it('a commitment with nothing outstanding queued stays warmly forward ("lining up")', async () => {
    const db = makeDB({
      link: { client_label: 'Alex', status: 'active' },
      streak: { current_streak: 0, longest_streak: 0, total_kept: 0 },
      commitments: [activeWord()],
      nextRows: [], // nothing outstanding for c1
    });
    const res = await call(db, '/api/coach/clients/u-a');
    const body = await res.json();
    const word = body.active_commitments.find((c) => c.title === 'Taxes');
    expect(word.next_checkin).toBeNull();
    expect(word.next_checkin_label).toBe(nextCheckinCopy({ iso: null }));
    expect(hasBanned(word.next_checkin_label)).toBe(false);
  });
});
