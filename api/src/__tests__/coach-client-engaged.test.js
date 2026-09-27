/**
 * FocusBro — the coach sees a client's "I'm on it" engagement (Contender #10, Phase A · R-279).
 *
 * R-278 made the snooze — the "I'm on it" third answer the whole two-way moat is
 * built on — a first-class, COUNTED outcome (`commitment_snooze` events) on every
 * surface. But nothing READ that count: it existed in the ledger and appeared in
 * no view. This slice surfaces it where it earns its keep — the coach's
 * client-detail weekly snapshot (GET /api/coach/clients/:id) — as a warm "actively
 * in it" line beside the kept-word count and the ally's showings-up.
 *
 * Why it matters: a low kept-count can hide an engaged client. A person who keeps
 * answering "I'm on it" is showing up to the conversation even when they haven't
 * resolved the word yet. Without this, a coach reads a quiet kept-count as a
 * disengaged client and might reach out with the wrong tone. With it, the coach
 * sees the lean-ins and knows the client is still in it.
 *
 * DESIGN LAW checks live here too: a snooze is never a resolution and never a miss
 * (events.js keeps it out of `resolved`), so the line can only ever count lean-ins
 * — engagement, never a shortfall — and it never merges into the kept-word count.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerCoachRoutes, clientWeeklyEngagedCopy } from '../coach.js';
import { EVENTS } from '../events.js';
import { generateUUID } from '../middleware.js';
import { scanDesignLaw } from '../design-law.js';

// THE DESIGN LAW is one lexicon now (design-law.js). This surface used to
// hand-roll its own banned-word union, which had drifted WEAKER than canonical:
// it missed `disappoint`, `ashamed`, `pathetic`, `worthless`, `unrespons`, the
// incredulous `again?!`, `therapy`, and the fuller shame/clinical stems the terse
// union missed — `failing`/`fails` (its `fail|failed|failure` never caught the
// `-ing`/`-s` forms), `laziness` (only `lazy`), and `treats`/`treating` (only
// `treat`/`treatment`). Route the guard through `scanDesignLaw` (shame + clinical
// + "AI" + consumer-ADHD in one pass) so this coach-visible engagement line is
// held to the same bar as every other surface — while preserving the genuine
// per-surface extras the canonical list intentionally does NOT carry:
//   • `late` / `overdue` — miss-framing this line must never use
//   • bare `slack(ing)` — canonical only bans "slack off" (so "Slack" the app
//     stays sayable elsewhere); this line never names the app, so the stricter
//     form is kept here
//   • bare `should have` — canonical anchors it to "you should have"
const localExtras = /\b(late|overdue|slack(ing)?|should have)\b/i;
const hasBanned = (s) => scanDesignLaw(String(s)).length > 0 || localExtras.test(String(s));

// ── pure helper: the coach-voice "actively in it" line ───────
describe('clientWeeklyEngagedCopy — the client\'s "I\'m on it" lean-ins (engagement signal)', () => {
  it('is empty when there are no lean-ins yet this week (a quiet page, never "0")', () => {
    expect(clientWeeklyEngagedCopy({ snoozedThisWeek: 0 })).toBe('');
    expect(clientWeeklyEngagedCopy({ snoozedThisWeek: -2 })).toBe('');
    expect(clientWeeklyEngagedCopy()).toBe('');
    expect(clientWeeklyEngagedCopy({ snoozedThisWeek: 'x' })).toBe('');
  });
  it('names the count, singular for exactly one', () => {
    const s = clientWeeklyEngagedCopy({ snoozedThisWeek: 1 });
    expect(s).toContain('leaned in 1 time this week');
    expect(s).not.toContain('1 times');
    expect(s).toContain('I’m on it');
  });
  it('names the count, plural for many', () => {
    expect(clientWeeklyEngagedCopy({ snoozedThisWeek: 4 })).toContain('leaned in 4 times this week');
  });
});

// ── THE DESIGN LAW — the engagement line never reads shame, "AI", or a clinical claim ──
describe('copy law — the "actively in it" line is clean', () => {
  const samples = [
    clientWeeklyEngagedCopy({ snoozedThisWeek: 1 }),
    clientWeeklyEngagedCopy({ snoozedThisWeek: 7 }),
  ];
  it('every non-empty engagement line is clean', () => {
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
// fire, and — the load-bearing one — that the warm "I'm on it" lean-in copy stays
// clean, so the anti-shame LAW is protected by construction, not by luck.
describe('the engagement line is guarded by the ONE canonical design-LAW scanner (never shame)', () => {
  it('catches shame/clinical framings the old per-surface union silently missed', () => {
    // None of these were in the old `banned` union; all are caught by scanDesignLaw now.
    for (const bad of [
      'you disappointed me',           // disappoint
      'that was pathetic',             // pathetic
      'you feel worthless',            // worthless
      'not this again?!',              // the incredulous again?! (the R-331 dead-regex class)
      'this is therapy for you',       // therapy (clinical)
      'a quiet, unresponsive client',  // unrespons
      'you keep failing',              // failing (the -ing stem the terse union missed)
      'sheer laziness',                // laziness (only `lazy` was guarded)
      'it treats the condition',       // treats (only `treat`/`treatment` was guarded)
    ]) {
      expect(hasBanned(bad), `should be caught: ${bad}`).toBe(true);
    }
  });

  it('still fires on the genuine per-surface extras kept out of the canonical list', () => {
    for (const bad of ['you are late', 'the taxes are overdue', 'stop slacking', 'you should have started']) {
      expect(hasBanned(bad), `per-surface extra should fire: ${bad}`).toBe(true);
    }
  });

  it('leaves the warm "I\'m on it" lean-in copy clean (the anti-shame LAW survives)', () => {
    for (const good of [
      clientWeeklyEngagedCopy({ snoozedThisWeek: 1 }),
      clientWeeklyEngagedCopy({ snoozedThisWeek: 5 }),
      'leaned in 3 times this week',
      'I’m on it',
      'when do you want to try again?', // single "?" — the warm reschedule, NOT the eye-roll
    ]) {
      expect(hasBanned(good), `warm copy must stay clean: ${good}`).toBe(false);
    }
  });
});

// ── integration: GET /api/coach/clients/:id surfaces the engagement count ──
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

// In-memory D1 double. The client-detail route runs TWO analytics_events reads
// with IDENTICAL SQL, distinguished ONLY by the bound `event_type` (delivered vs
// snooze), so this double captures the bound args and dispatches on event_type —
// the real point of divergence — rather than on SQL shape alone.
function makeDB({ link, streak, commitments = [], kept = [], delivered = [], snoozed = [], tz = 'UTC' } = {}) {
  return {
    prepare(sql) {
      let boundArgs = [];
      const stmt = {
        bind(...args) { boundArgs = args; return stmt; },
        async first() {
          if (/FROM coach_clients/.test(sql)) return link || null;
          if (/FROM accountability_streaks/.test(sql)) return streak || null;
          if (/FROM coach_note_consent/.test(sql)) return null; // opt-in OFF
          if (/SELECT timezone\s+FROM commitments/.test(sql)) return tz ? { timezone: tz } : null;
          return null;
        },
        async all() {
          if (/FROM commitments/.test(sql) && /status = 'active'/.test(sql)) return { results: commitments };
          if (/MIN\(scheduled_for\)/.test(sql)) return { results: [] };
          if (/status = 'kept'/.test(sql)) return { results: kept.map((t) => ({ responded_at: t })) };
          if (/FROM analytics_events/.test(sql)) {
            const eventType = boundArgs[1];
            const src = eventType === EVENTS.COMMITMENT_SNOOZE ? snoozed : delivered;
            return { results: src.map((t) => ({ created_at: t })) };
          }
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

describe('GET /api/coach/clients/:clientId — the "I\'m on it" engagement count', () => {
  it('surfaces the client\'s lean-ins this week, apart from the kept-word count', async () => {
    const db = makeDB({
      link: { client_label: 'Alex', status: 'active' },
      streak: { current_streak: 1, longest_streak: 5, total_kept: 12 },
      commitments: [{ id: 'c1', title: 'Taxes', start_at: iso(-H), checkin_at: iso(-H), status: 'active', recurrence: 'none', local_time: null, timezone: 'UTC' }],
      kept: [iso(1 * H)],                         // 1 kept word this week
      delivered: [iso(2 * H), iso(27 * H)],        // bro showed up twice
      snoozed: [iso(3 * H), iso(28 * H), iso(52 * H)], // 3 "I'm on it" lean-ins this week
    });
    const res = await call(db, '/api/coach/clients/u-a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.week).toBeTruthy();
    // The lean-ins are surfaced, independent of the kept-word count.
    expect(body.week.engaged_this_week).toBe(3);
    expect(body.week.kept_this_week).toBe(1);
    expect(body.week.engaged_line).toContain('leaned in 3 times this week');
    // ...and never merged into the ally's showings-up either.
    expect(body.week.showed_up_this_week).toBe(2);
  });

  it('hides the engagement line entirely when there are no lean-ins yet (no "0", never a miss)', async () => {
    const db = makeDB({
      link: { client_label: 'Bo', status: 'active' },
      streak: { current_streak: 0, longest_streak: 0, total_kept: 0 },
      commitments: [],
      kept: [],
      delivered: [],
      snoozed: [],
    });
    const res = await call(db, '/api/coach/clients/u-b');
    const body = await res.json();
    expect(body.week.engaged_this_week).toBe(0);
    expect(body.week.engaged_line).toBe('');
  });
});
