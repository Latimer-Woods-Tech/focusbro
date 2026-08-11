/**
 * FocusBro — coach-visible WEEKLY snapshot on the client detail (Contender #10, Phase A).
 *
 * A person can already generate a /me/report and copy/mail it to their coach
 * (report.js, R-237). This slice surfaces the SAME seven-day kept-word summary
 * natively inside the coach's client-detail view (GET /api/coach/clients/:id),
 * so a report becomes coach-visible without the person having to hand it over —
 * the concrete surface the Phase 3 coach-GTM gate ("≥5 real coach-visible
 * reports", docs/IMPROVEMENT_PLAN.md L5) needs. The numbers come from the SAME
 * pure buildWeeklyReport the person's report uses, so a coach's "this week" count
 * can never drift from what the client sees; only the VOICE is re-framed to the
 * coach's third person.
 *
 * DESIGN LAW checks live here too: the snapshot is KEPT-word framed (a quiet week
 * is a clean page, never a shortfall) and the "showed up" line counts only the
 * ally keeping ITS word — never a client miss, for the coach or the client.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerCoachRoutes,
  clientWeeklyKeptCopy,
  clientWeeklyShowedUpCopy,
} from '../coach.js';
import { generateUUID } from '../middleware.js';
import { scanDesignLaw } from '../design-law.js';

// THE DESIGN LAW is one lexicon now (design-law.js). This surface used to
// hand-roll its own banned-word union, which had drifted WEAKER than canonical:
// it missed `disappoint`, `ashamed`, `pathetic`, `worthless`, `unrespons`, the
// incredulous `again?!`, `therapy`, and the fuller shame/clinical stems
// (`failing`/`fails`, `laziness`, `treats`/`treating`). Route the guard through
// `scanDesignLaw` (shame + clinical + "AI" + consumer-ADHD in one pass) so this
// coach-visible weekly snapshot is held to the same bar as every other surface —
// while preserving the three genuine per-surface extras the canonical list
// intentionally does NOT carry:
//   • `late` / `overdue` — miss-framing this weekly snapshot must never use
//   • bare `slack(ing)` — canonical only bans "slack off" (so "Slack" the app
//     stays sayable elsewhere); this snapshot never names the app, so the
//     stricter form is kept here
//   • bare `should have` — canonical anchors it to "you should have"
const localExtras = /\b(late|overdue|slack(ing)?|should have)\b/i;
const hasBanned = (s) => scanDesignLaw(String(s)).length > 0 || localExtras.test(String(s));

// ── pure helper: the coach-voice weekly kept-word summary ────
describe('clientWeeklyKeptCopy — the coach-voice seven-day kept-word line', () => {
  it('a quiet week reads as a clean page, never a shortfall', () => {
    const s = clientWeeklyKeptCopy({ keptThisWeek: 0 });
    expect(s.toLowerCase()).toContain('clean page');
    expect(s).not.toMatch(/\b0\b/); // never a bare "0 kept"
  });
  it('names the count, singular for one', () => {
    expect(clientWeeklyKeptCopy({ keptThisWeek: 1 })).toBe('This week: 1 kept word.');
  });
  it('names the count, plural for many', () => {
    expect(clientWeeklyKeptCopy({ keptThisWeek: 4 })).toBe('This week: 4 kept words.');
  });
  it('is defensive about missing/garbage input (always a non-empty string)', () => {
    expect(typeof clientWeeklyKeptCopy()).toBe('string');
    expect(clientWeeklyKeptCopy().length).toBeGreaterThan(0);
    expect(clientWeeklyKeptCopy({ keptThisWeek: -3 }).toLowerCase()).toContain('clean page');
    expect(clientWeeklyKeptCopy({ keptThisWeek: 'x' }).toLowerCase()).toContain('clean page');
  });
});

// ── pure helper: the coach-voice mutual-accountability line ──
describe('clientWeeklyShowedUpCopy — how many times the bro showed up (support signal)', () => {
  it('is empty when the bro has not had a moment to show up yet this week', () => {
    expect(clientWeeklyShowedUpCopy({ showedUp: 0 })).toBe('');
    expect(clientWeeklyShowedUpCopy({ showedUp: -1 })).toBe('');
    expect(clientWeeklyShowedUpCopy()).toBe('');
  });
  it('names the count, singular for one', () => {
    expect(clientWeeklyShowedUpCopy({ showedUp: 1 })).toContain('1 time this week');
  });
  it('names the count, plural for many', () => {
    expect(clientWeeklyShowedUpCopy({ showedUp: 3 })).toContain('3 times this week');
  });
});

// ── THE DESIGN LAW extends to the coach's weekly snapshot ────
describe('copy law — the weekly snapshot never reads shame, "AI", or a clinical claim', () => {
  const samples = [
    clientWeeklyKeptCopy({ keptThisWeek: 0 }),
    clientWeeklyKeptCopy({ keptThisWeek: 1 }),
    clientWeeklyKeptCopy({ keptThisWeek: 9 }),
    clientWeeklyShowedUpCopy({ showedUp: 1 }),
    clientWeeklyShowedUpCopy({ showedUp: 6 }),
  ];
  it('every non-empty weekly line is clean', () => {
    for (const s of samples) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
      expect(hasBanned(s), `banned word in: "${s}"`).toBe(false);
    }
  });
});

// ── proof-of-rejection (Standing Law #1): the fold STRENGTHENS this surface ──
// Pins that routing through scanDesignLaw catches shame/clinical framings the old
// hand-rolled union silently missed, that the preserved per-surface extras still
// fire, and — the load-bearing one — that the warm kept-word / clean-page copy
// stays clean, so the anti-shame LAW is protected by construction, not by luck.
describe('the weekly snapshot is guarded by the ONE canonical design-LAW scanner (never shame)', () => {
  it('catches shame/clinical framings the old per-surface union silently missed', () => {
    // None of these were in the old `banned` union; all are caught by scanDesignLaw now.
    for (const bad of [
      'you disappointed me',           // disappoint
      'that was pathetic',             // pathetic
      'you feel worthless',            // worthless
      'not this again?!',              // the incredulous again?! (the R-331 dead-regex class)
      'this is therapy for you',       // therapy (clinical)
      'a quiet, unresponsive client',  // unrespons
      'you keep failing',              // failing (the fuller stem the union missed)
    ]) {
      expect(hasBanned(bad), `should be caught: ${bad}`).toBe(true);
    }
  });

  it('still fires on the genuine per-surface extras kept out of the canonical list', () => {
    for (const bad of ['you are late', 'the taxes are overdue', 'stop slacking', 'you should have started']) {
      expect(hasBanned(bad), `per-surface extra should fire: ${bad}`).toBe(true);
    }
  });

  it('leaves the warm kept-word + clean-page copy clean (the anti-shame LAW survives)', () => {
    for (const good of [
      'This week: 3 kept words.',
      'A quiet week is a clean page',
      'The bro showed up 2 times this week',
      'when do you want to try again?', // single "?" — the warm reschedule, NOT the eye-roll
    ]) {
      expect(hasBanned(good), `warm copy must stay clean: ${good}`).toBe(false);
    }
  });
});

// ── integration: GET /api/coach/clients/:clientId returns the week block ──
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

// In-memory D1 double for the client-detail route. Dispatches by SQL shape and
// the .first()/.all() distinction (the tz probe and the commitments list both
// read `commitments`, but one is a .first() and the other an .all()).
function makeDB({ link, streak, commitments = [], nextRows = [], tz = 'UTC', kept = [], delivered = [] } = {}) {
  return {
    prepare(sql) {
      const stmt = {
        // The route binds by clientId, but this double dispatches purely by SQL
        // shape (one client per call), so the bound args are not needed here.
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

// Instants safely inside the trailing-7-local-day window (UTC day boundaries).
const H = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

describe('GET /api/coach/clients/:clientId — the coach-visible weekly snapshot', () => {
  it('attaches a `week` block with kept + showed-up counts from the client data', async () => {
    const db = makeDB({
      link: { client_label: 'Alex', status: 'active' },
      streak: { current_streak: 3, longest_streak: 5, total_kept: 12 },
      commitments: [{ id: 'c1', title: 'Taxes', start_at: iso(-H), checkin_at: iso(-H), status: 'active', recurrence: 'none', local_time: null, timezone: 'UTC' }],
      nextRows: [{ commitment_id: 'c1', next_for: iso(-H) }],
      kept: [iso(1 * H), iso(26 * H), iso(50 * H)],  // 3 kept words this week
      delivered: [iso(2 * H), iso(27 * H)],          // bro showed up twice this week
    });
    const res = await call(db, '/api/coach/clients/u-a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.week).toBeTruthy();
    expect(body.week.kept_this_week).toBe(3);
    expect(body.week.showed_up_this_week).toBe(2);
    expect(body.week.summary_line).toBe('This week: 3 kept words.');
    expect(body.week.showed_up_line).toContain('2 times this week');
    // The window bounds come straight from buildWeeklyReport.
    expect(typeof body.week.since).toBe('string');
    expect(typeof body.week.until).toBe('string');
  });

  it('a quiet week is a clean page and the showed-up line is absent (never a miss)', async () => {
    const db = makeDB({
      link: { client_label: 'Bo', status: 'active' },
      streak: { current_streak: 0, longest_streak: 0, total_kept: 0 },
      commitments: [],
      kept: [],
      delivered: [],
    });
    const res = await call(db, '/api/coach/clients/u-b');
    const body = await res.json();
    expect(body.week.kept_this_week).toBe(0);
    expect(body.week.showed_up_this_week).toBe(0);
    expect(body.week.summary_line.toLowerCase()).toContain('clean page');
    expect(body.week.showed_up_line).toBe('');
  });

  it('does not leak a week block for a link that is not active (consent gate)', async () => {
    const db = makeDB({ link: { client_label: 'Cass', status: 'pending' } });
    const res = await call(db, '/api/coach/clients/u-c');
    expect(res.status).toBe(404);
  });
});
