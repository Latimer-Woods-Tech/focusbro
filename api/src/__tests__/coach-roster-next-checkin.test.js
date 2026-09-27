/**
 * FocusBro — at-a-glance next check-in on the coach ROSTER (Contender #10, Phase A, R-234).
 *
 * R-224 gave a coach the concrete next check-in per client, but only INSIDE the
 * "View rhythm" drill-in — you had to open every client one at a time to answer
 * "when does the bro next show up for them?". This slice attaches `next_checkin`
 * + a warm `next_checkin_line` to each ACTIVE client in `GET /api/coach/clients`
 * via ONE grouped join query (no N+1 across the roster), so a coach sees it for
 * the whole roster at a glance — the coach-side twin of the person's own
 * next-check-in on `/me/` (R-233).
 *
 * DESIGN LAW checks live here too: the grouped query JOINs to ACTIVE commitments
 * so a stray outstanding row on a released word never leaks in; a client with
 * nothing queued carries no line; and the already-past-but-open copy is warm
 * ("still here"), never a "late"/"overdue"/miss scold.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerCoachRoutes,
  rosterNextCheckinLine,
  rosterNextCheckinWaitingCopy,
  nextCheckinCopy,
} from '../coach.js';
import { generateUUID } from '../middleware.js';
import { scanDesignLaw } from '../design-law.js';

// THE DESIGN LAW is one lexicon now (design-law.js). This coach-facing roster
// next-check-in surface (R-234) used to hand-roll its own banned-word union,
// which had drifted WEAKER than canonical: it missed `disappoint`, `ashamed`,
// `pathetic`, `worthless`, `unrespons`, `slipping`, the incredulous `again?!`,
// `disorder`, `symptom`, `medication`, `therapy`, the bare word `ADHD` (banned in
// consumer copy), and the fuller shame/clinical stems the terse union missed —
// `failing`/`fails` (its `fail|failed|failure` never caught the `-ing`/`-s`
// forms), `laziness` (only `lazy`), and `treats`/`treating` (only
// `treat`/`treatment`). Route the guard through `scanDesignLaw` (shame + clinical
// + "AI" branding + consumer-ADHD in one pass) so this roster next-check-in copy
// is held to the same bar as every other surface — while preserving the genuine
// per-surface extras the canonical list intentionally does NOT carry:
//   • `late` / `overdue` — the miss-framing this line must never use
//   • bare `slack(ing)` — canonical only bans "slack off" (so "Slack" the app
//     stays sayable elsewhere); this line never names the app, so the stricter
//     form is kept here
//   • bare `should have` — canonical anchors it to "you should have"
// Coach-facing, but the scan runs with the default (allowAdhd=false) exactly like
// the sibling coach engagement line (R-335): this scheduling copy never
// legitimately names ADHD, so the stricter consumer bar is the right default.
const localExtras = /\b(late|overdue|slack(ing)?|should have)\b/i;
const hasBanned = (s) => scanDesignLaw(String(s)).length > 0 || localExtras.test(String(s));

// ── router harness (mirrors next-checkin-list.test.js) ───────
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

// In-memory D1 double. `bind` captures args so per-client `.first()` lookups
// (streak, active count) resolve by the bound client id; the roster links and
// the grouped next-check-in query resolve by SQL shape.
function makeDB({ links = [], streaks = {}, activeCounts = {}, nextRows = [] } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      let bound = [];
      const stmt = {
        bind(...args) { bound = args; return stmt; },
        async first() {
          if (/FROM accountability_streaks/.test(sql)) {
            return streaks[bound[0]] || { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };
          }
          if (/COUNT\(\*\) AS n FROM commitments/.test(sql)) {
            return { n: activeCounts[bound[0]] || 0 };
          }
          return null;
        },
        async all() {
          if (/FROM coach_clients cc/.test(sql)) return { results: links };
          if (/FROM commitment_checkins cc/.test(sql) && /GROUP BY c\.user_id/.test(sql)) {
            return { results: nextRows };
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
  registerCoachRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  return (method, path, { token = 'good' } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = new Request('https://x' + path, { method, headers });
    return router.handle(req, env);
  };
}

// Times relative to the real clock — the route compares against `new Date()`.
const FUTURE = new Date(Date.now() + 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

const LINKS = [
  { link_id: 'l-a', client_user_id: 'u-a', client_label: 'Alex', status: 'active', invited_at: '2026-07-10T00:00:00Z', responded_at: '2026-07-10T01:00:00Z', client_email: 'alex@example.com' },
  { link_id: 'l-b', client_user_id: 'u-b', client_label: 'Bo', status: 'active', invited_at: '2026-07-11T00:00:00Z', responded_at: '2026-07-11T01:00:00Z', client_email: 'bo@example.com' },
  { link_id: 'l-c', client_user_id: 'u-c', client_label: 'Cass', status: 'pending', invited_at: '2026-07-12T00:00:00Z', responded_at: null, client_email: 'cass@example.com' },
];
const STREAKS = { 'u-a': { current_streak: 3, longest_streak: 5, total_kept: 12 }, 'u-b': { current_streak: 0, longest_streak: 0, total_kept: 0 } };
const COUNTS = { 'u-a': 2, 'u-b': 1 };

describe('GET /api/coach/clients — next check-in attached to active roster entries (R-234)', () => {
  it('attaches next_checkin + a warm forward line to an active client with an outstanding check-in', async () => {
    const db = makeDB({
      links: LINKS, streaks: STREAKS, activeCounts: COUNTS,
      nextRows: [{ client_id: 'u-a', next_for: FUTURE, timezone: 'UTC' }],
    });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.roster.map((e) => [e.client_id, e]));
    expect(byId['u-a'].next_checkin).toBe(FUTURE);
    expect(byId['u-a'].next_checkin_line).toBe(nextCheckinCopy({ iso: FUTURE, timezone: 'UTC' }));
    expect(byId['u-a'].next_checkin_line.startsWith('Next up')).toBe(true);
  });

  it('leaves an active client with nothing queued line-free (null + empty string)', async () => {
    const db = makeDB({
      links: LINKS, streaks: STREAKS, activeCounts: COUNTS,
      nextRows: [{ client_id: 'u-a', next_for: FUTURE, timezone: 'UTC' }], // u-b absent
    });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    const body = await res.json();
    const bo = body.roster.find((e) => e.client_id === 'u-b');
    expect(bo.next_checkin).toBeNull();
    expect(bo.next_checkin_line).toBe('');
  });

  it('never attaches a next check-in to a PENDING client (no data before consent)', async () => {
    const db = makeDB({
      links: LINKS, streaks: STREAKS, activeCounts: COUNTS,
      nextRows: [{ client_id: 'u-a', next_for: FUTURE, timezone: 'UTC' }],
    });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    const body = await res.json();
    const cass = body.roster.find((e) => e.client_id === 'u-c');
    expect(cass.status).toBe('pending');
    expect(cass.next_checkin).toBeUndefined();
    expect(cass.next_checkin_line).toBeUndefined();
  });

  it('a passed-but-open check-in reads as warm "still here", never "late"/"overdue"', async () => {
    const db = makeDB({
      links: LINKS, streaks: STREAKS, activeCounts: COUNTS,
      nextRows: [{ client_id: 'u-a', next_for: PAST, timezone: 'UTC' }],
    });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    const body = await res.json();
    const alex = body.roster.find((e) => e.client_id === 'u-a');
    expect(alex.next_checkin).toBe(PAST);
    expect(alex.next_checkin_line).toBe(rosterNextCheckinWaitingCopy());
    expect(/late|overdue|miss|behind/i.test(alex.next_checkin_line)).toBe(false);
  });

  it('uses ONE grouped query for the whole roster (no N+1 per client)', async () => {
    const db = makeDB({
      links: LINKS, streaks: STREAKS, activeCounts: COUNTS,
      nextRows: [{ client_id: 'u-a', next_for: FUTURE, timezone: 'UTC' }],
    });
    await buildRouter(db)('GET', '/api/coach/clients');
    const grouped = db.queries.filter((q) => /FROM commitment_checkins cc/.test(q) && /GROUP BY c\.user_id/.test(q));
    expect(grouped.length).toBe(1);
  });

  it('skips the grouped query entirely when there are no active clients', async () => {
    const db = makeDB({ links: [LINKS[2]] }); // pending only
    await buildRouter(db)('GET', '/api/coach/clients');
    const grouped = db.queries.filter((q) => /FROM commitment_checkins cc/.test(q) && /GROUP BY c\.user_id/.test(q));
    expect(grouped.length).toBe(0);
  });

  it('requires auth', async () => {
    const db = makeDB({ links: LINKS });
    const res = await buildRouter(db)('GET', '/api/coach/clients', { token: null });
    expect(res.status).toBe(401);
  });
});

describe('rosterNextCheckinLine — pure helper', () => {
  const NOW = '2026-07-12T12:00:00Z';
  it('a future outstanding check-in reads as a forward "Next up …"', () => {
    const line = rosterNextCheckinLine({ iso: '2026-07-12T15:00:00Z', timezone: 'UTC', nowISO: NOW });
    expect(line.startsWith('Next up')).toBe(true);
  });
  it('a passed-but-open check-in reads as the warm waiting line', () => {
    const line = rosterNextCheckinLine({ iso: '2026-07-12T09:00:00Z', timezone: 'UTC', nowISO: NOW });
    expect(line).toBe(rosterNextCheckinWaitingCopy());
  });
  it('nothing queued (null / invalid) renders nothing', () => {
    expect(rosterNextCheckinLine({ iso: null, nowISO: NOW })).toBe('');
    expect(rosterNextCheckinLine({ iso: 'not-a-date', nowISO: NOW })).toBe('');
    expect(rosterNextCheckinLine({})).toBe('');
  });
});

describe('R-234 copy obeys the design LAW (never shame)', () => {
  it('the waiting line carries no shame, no miss tally, no "AI", no clinical claim', () => {
    const s = rosterNextCheckinWaitingCopy();
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
    expect(hasBanned(s), `banned word in: "${s}"`).toBe(false);
  });
  it('the waiting line is warmly forward, third-person, not a scold about time passing', () => {
    expect(rosterNextCheckinWaitingCopy().toLowerCase()).toContain('still here');
  });
  it('a rendered future line carries no shame either', () => {
    const line = rosterNextCheckinLine({ iso: '2026-07-12T15:00:00Z', timezone: 'UTC', nowISO: '2026-07-12T12:00:00Z' });
    expect(hasBanned(line), `banned word in: "${line}"`).toBe(false);
  });
});

// ── proof-of-rejection (Standing Law #1): the fold STRENGTHENS this surface ──
// Pins that routing through scanDesignLaw catches shame/clinical framings the old
// hand-rolled union silently missed, that the preserved per-surface extras still
// fire, and — the load-bearing one — that the warm roster next-check-in copy stays
// clean, so the anti-shame LAW is protected by construction, not by luck.
describe('the coach roster next-check-in copy is guarded by the ONE canonical design-LAW scanner (never shame)', () => {
  it('catches shame/clinical framings the old per-surface union silently missed', () => {
    // None of these were in the old `banned` union; all are caught by scanDesignLaw now.
    for (const bad of [
      'you disappointed me',           // disappoint
      'that was pathetic',             // pathetic
      'they feel worthless',           // worthless
      "they're slipping",              // slipping (never guarded here before)
      'not this again?!',              // the incredulous again?! (the R-331 dead-regex class)
      'this is therapy for them',      // therapy (clinical)
      'a diagnosed disorder',          // disorder (clinical, unguarded before)
      'take your medication',          // medication (clinical, unguarded before)
      'built for their ADHD',          // ADHD in consumer copy (unguarded before)
      'they keep failing',             // failing (the -ing stem the terse union missed)
      'sheer laziness',                // laziness (only `lazy` was guarded)
      'it treats the condition',       // treats (only `treat`/`treatment` was guarded)
    ]) {
      expect(hasBanned(bad), `should be caught: ${bad}`).toBe(true);
    }
  });

  it('still fires on the genuine per-surface extras kept out of the canonical list', () => {
    for (const bad of ['the check-in is late', 'the check-in is overdue', 'stop slacking', 'they should have started']) {
      expect(hasBanned(bad), `per-surface extra should fire: ${bad}`).toBe(true);
    }
  });

  it('leaves the warm roster next-check-in copy clean (the anti-shame LAW survives)', () => {
    for (const good of [
      rosterNextCheckinWaitingCopy(),
      rosterNextCheckinLine({ iso: '2026-07-12T15:00:00Z', timezone: 'UTC', nowISO: '2026-07-12T12:00:00Z' }),
      'Still here whenever they’re ready',
      'when do you want to try again?', // single "?" — the warm reschedule, NOT the eye-roll
    ]) {
      expect(hasBanned(good), `warm copy must stay clean: ${good}`).toBe(false);
    }
  });
});
