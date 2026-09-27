/**
 * FocusBro — warm triage ordering on the coach ROSTER (Contender #10, Phase A, R-281).
 *
 * The roster is the surface where a coach scans top-down to decide WHO to reach
 * out to. R-224→R-280 attached the cues (next check-in, reach-out, back-and-
 * moving, shares, leaning-in) to each card — but the ORDER stayed frozen at the
 * SQL default (active first, then most-recent-invite first), so the two clients a
 * touch would help most could sit anywhere in the list. This floats them to where
 * the eye lands first, using ONLY the cues already resolved on each entry
 * (`rosterTriageRank`): a live reach-out cue (gone quiet — a note lands now) rises
 * above a leaning-in-but-unresolved client, which rises above a calm clean page.
 *
 * Pure reorder — no new query, no new data (this test asserts that too). Stable
 * within equal rank (keeps the SQL's most-recent-first order); PENDING links keep
 * their place after every active client (they carry no data, so no triage).
 *
 * DESIGN LAW checks live here too: the order is an INVITATION map, never a failure
 * ranking — a calm client scores 0 and holds its spot, is never sunk for being
 * calm, never annotated, never flagged; and no entry is ever lost or duplicated
 * by the reorder.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerCoachRoutes, rosterTriageRank } from '../coach.js';
import { generateUUID } from '../middleware.js';

// ── router harness (mirrors coach-roster-engaged.test.js) ───────
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

// The roster's "leaning in" query (R-280): parameterized event_type + a forward
// day-prefix window + a plain GROUP BY (no HAVING, no json_extract).
function isEngagedQuery(sql) {
  return /event_type = \?/.test(sql)
    && /substr\(created_at, 1, 10\) >= \?/.test(sql)
    && /GROUP BY user_id/.test(sql)
    && !/HAVING/.test(sql)
    && !/json_extract/.test(sql);
}
// The roster's reach-out (gone-quiet) query: a GROUP BY user_id with a
// `HAVING substr(MAX(created_at), 1, 10) <= ?` cutoff — uniquely distinct from
// the back/homecoming/engaged analytics queries.
function isQuietQuery(sql) {
  return /HAVING\s+substr\(MAX\(created_at\), 1, 10\) <= \?/.test(sql);
}
// The roster's "back and moving" (once-quiet-now-active) query: the only one that
// reads `return_nudge_sent` via `json_extract` — distinct from quiet (HAVING) and
// engaged (no json_extract).
function isBackQuery(sql) {
  return /return_nudge_sent/.test(sql) && /json_extract/.test(sql);
}

// In-memory D1 double. Streak/active-count resolve by bound client id; the quiet
// and engaged queries resolve by SQL shape, returning the configured client sets;
// every other analytics query (back / shares / homecoming / next-checkin) yields
// nothing, so the ONLY ordering signals under test are quiet + engaged.
function makeDB({ links = [], streaks = {}, activeCounts = {}, quietClients = [], engagedClients = [], backClients = [] } = {}) {
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
          if (isQuietQuery(sql)) return { results: quietClients.map((id) => ({ client_id: id })) };
          if (isEngagedQuery(sql)) return { results: engagedClients.map((id) => ({ client_id: id })) };
          if (isBackQuery(sql)) return { results: backClients.map((id) => ({ client_id: id })) };
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

const active = (id, label, invited_at) => ({
  link_id: 'l-' + id, client_user_id: id, client_label: label, status: 'active',
  invited_at, responded_at: '2026-07-01T01:00:00Z', client_email: id + '@example.com',
});
const pending = (id, label, invited_at) => ({
  link_id: 'l-' + id, client_user_id: id, client_label: label, status: 'pending',
  invited_at, responded_at: null, client_email: id + '@example.com',
});

// SQL-order baseline (what the route builds pre-triage): active first, then
// most-recent-invite first. Cal is calmest+newest, so on the OLD frozen code it
// sat at the very top — this is the exact ordering the reorder must overturn.
const CAL = active('u-cal', 'Cal', '2026-07-14T00:00:00Z'); // rank 0
const EVE = active('u-eve', 'Eve', '2026-07-13T00:00:00Z'); // rank 1 (engaged)
const QUI = active('u-qui', 'Quinn', '2026-07-12T00:00:00Z'); // rank 2 (quiet)
const PAT = pending('u-pat', 'Pat', '2026-07-15T00:00:00Z'); // newest overall, but pending
const STREAKS = { 'u-cal': { current_streak: 0, longest_streak: 3, total_kept: 5 } };
const COUNTS = { 'u-cal': 1, 'u-eve': 1, 'u-qui': 1 };

const idsOf = (body) => body.roster.map((e) => e.client_id);

describe('GET /api/coach/clients — warm triage ordering (R-281)', () => {
  it('floats a reach-out client above an engaged one above a calm one, ignoring invite order', async () => {
    const db = makeDB({
      links: [CAL, EVE, QUI, PAT], streaks: STREAKS, activeCounts: COUNTS,
      quietClients: ['u-qui'], engagedClients: ['u-eve'],
    });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    expect(res.status).toBe(200);
    const body = await res.json();
    // OLD frozen code yields [u-cal, u-eve, u-qui, u-pat]; the reorder overturns it.
    expect(idsOf(body)).toEqual(['u-qui', 'u-eve', 'u-cal', 'u-pat']);
  });

  it('keeps every PENDING link after all active clients, even the newest-invited', async () => {
    const db = makeDB({
      links: [CAL, PAT, EVE, QUI], streaks: STREAKS, activeCounts: COUNTS,
      quietClients: ['u-qui'], engagedClients: ['u-eve'],
    });
    const body = await (await buildRouter(db)('GET', '/api/coach/clients')).json();
    const lastActive = body.roster.filter((e) => e.status === 'active').length;
    expect(idsOf(body).slice(0, lastActive)).toEqual(['u-qui', 'u-eve', 'u-cal']);
    expect(body.roster[body.roster.length - 1].status).toBe('pending');
  });

  it('a client both quiet AND leaning in outranks a quiet-only client', async () => {
    const both = active('u-both', 'Bo', '2026-07-10T00:00:00Z');
    const db = makeDB({
      links: [QUI, both], activeCounts: { 'u-qui': 1, 'u-both': 1 },
      quietClients: ['u-qui', 'u-both'], engagedClients: ['u-both'],
    });
    const body = await (await buildRouter(db)('GET', '/api/coach/clients')).json();
    expect(idsOf(body)).toEqual(['u-both', 'u-qui']); // rank 3 above rank 2
  });

  it('is a STABLE tiebreak: two calm clients keep the SQL most-recent-first order', async () => {
    const a = active('u-a', 'A', '2026-07-14T00:00:00Z');
    const b = active('u-b', 'B', '2026-07-11T00:00:00Z');
    const db = makeDB({ links: [a, b], activeCounts: { 'u-a': 1, 'u-b': 1 } });
    const body = await (await buildRouter(db)('GET', '/api/coach/clients')).json();
    expect(idsOf(body)).toEqual(['u-a', 'u-b']); // untouched — neither carries triage weight
  });

  it('never loses or duplicates an entry, and never annotates the calm client', async () => {
    const db = makeDB({
      links: [CAL, EVE, QUI, PAT], streaks: STREAKS, activeCounts: COUNTS,
      quietClients: ['u-qui'], engagedClients: ['u-eve'],
    });
    const body = await (await buildRouter(db)('GET', '/api/coach/clients')).json();
    expect(new Set(idsOf(body)).size).toBe(4); // no dupes
    expect(idsOf(body).slice().sort()).toEqual(['u-cal', 'u-eve', 'u-pat', 'u-qui']); // same set
    const cal = body.roster.find((e) => e.client_id === 'u-cal');
    expect(cal.engaged_this_week).toBe(false); // sunk by no one — just not floated
    expect(cal.engaged_line).toBe('');
    expect(cal.reach_out_line).toBe('');
  });

  it('adds NO extra query for ordering — it is a pure reorder of resolved cues', async () => {
    const db = makeDB({
      links: [CAL, EVE, QUI], streaks: STREAKS, activeCounts: COUNTS,
      quietClients: ['u-qui'], engagedClients: ['u-eve'],
    });
    await buildRouter(db)('GET', '/api/coach/clients');
    // Exactly one quiet query and one engaged query drive the order — the reorder
    // itself issues none of its own.
    expect(db.queries.filter(isQuietQuery).length).toBe(1);
    expect(db.queries.filter(isEngagedQuery).length).toBe(1);
  });

  it('does not choke on a single active client (guard: nothing to reorder)', async () => {
    const db = makeDB({ links: [QUI, PAT], activeCounts: { 'u-qui': 1 }, quietClients: ['u-qui'] });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(idsOf(body)).toEqual(['u-qui', 'u-pat']);
  });

  it('requires auth', async () => {
    const db = makeDB({ links: [CAL, EVE] });
    const res = await buildRouter(db)('GET', '/api/coach/clients', { token: null });
    expect(res.status).toBe(401);
  });
});

// ── R-289: a live celebration MOMENT floats too ────────────────────────────
// R-281 floated the reach-out (quiet) and leaning-in cues, but two equally
// time-bounded warm-touch cues — a kept-word milestone just landing
// (`milestone_line`) and a client coming back and moving again (`back_line`) —
// still sat frozen at their invite-recency spot, so a coach scanning top-down
// could scroll right past the exact moment each copy invites ("a great moment to
// send a word / reconnect"). This floats them, +1, same tier as leaning-in and
// strictly below a client who has gone quiet. Still a pure reorder of resolved
// cues — the milestone rides the streak already loaded per card, the back cue the
// same return query already run. DESIGN LAW: both inputs are invitations to
// CELEBRATE, never a miss; a calm client still scores 0 and holds its spot.
describe('GET /api/coach/clients — a live celebration moment floats too (R-289)', () => {
  it('floats a milestone-just-landed client above a calm, newer-invited one', async () => {
    const calm = active('u-calm', 'Calm', '2026-07-14T00:00:00Z'); // newest → top pre-triage, rank 0
    const mile = active('u-mile', 'Mel', '2026-07-10T00:00:00Z'); // older, but a milestone just landed
    const db = makeDB({
      links: [calm, mile], activeCounts: { 'u-calm': 1, 'u-mile': 1 },
      // current_streak EXACTLY a milestone (STREAK_MILESTONES: 3/7/14/30/100) → milestone_line set
      streaks: { 'u-mile': { current_streak: 7, longest_streak: 7, total_kept: 12 } },
    });
    const body = await (await buildRouter(db)('GET', '/api/coach/clients')).json();
    // OLD (frozen / reverted) code keeps SQL order [u-calm, u-mile]; the reorder overturns it.
    expect(idsOf(body)).toEqual(['u-mile', 'u-calm']);
    // The floated card carries the milestone cue; the calm one is untouched (never annotated).
    expect(body.roster.find((e) => e.client_id === 'u-mile').milestone_line).toContain('milestone just landed');
    expect(body.roster.find((e) => e.client_id === 'u-calm').milestone_line).toBe('');
  });

  it('floats a back-and-moving client above a calm, newer-invited one', async () => {
    const calm = active('u-calm', 'Calm', '2026-07-14T00:00:00Z'); // newest → top pre-triage, rank 0
    const back = active('u-back', 'Bea', '2026-07-10T00:00:00Z'); // older, but just came back
    const db = makeDB({
      links: [calm, back], activeCounts: { 'u-calm': 1, 'u-back': 1 },
      backClients: ['u-back'], // once quiet, nudged, now active again → back_line set (not quiet)
    });
    const body = await (await buildRouter(db)('GET', '/api/coach/clients')).json();
    expect(idsOf(body)).toEqual(['u-back', 'u-calm']);
    expect(body.roster.find((e) => e.client_id === 'u-back').back_line).not.toBe('');
  });

  it('a gone-quiet client (reach-out, +2) still outranks a milestone client (+1)', async () => {
    const mile = active('u-mile', 'Mel', '2026-07-14T00:00:00Z'); // newest, milestone → +1
    const qui = active('u-qui2', 'Quinn', '2026-07-10T00:00:00Z'); // older, quiet → +2
    const db = makeDB({
      links: [mile, qui], activeCounts: { 'u-mile': 1, 'u-qui2': 1 },
      streaks: { 'u-mile': { current_streak: 7 } }, quietClients: ['u-qui2'],
    });
    const body = await (await buildRouter(db)('GET', '/api/coach/clients')).json();
    // The client who has gone quiet — the one a warm note helps most — leads.
    expect(idsOf(body)).toEqual(['u-qui2', 'u-mile']);
  });

  it('adds NO extra query for the new signals — milestone rides the streak, back the return query', async () => {
    const db = makeDB({
      links: [active('u-mile', 'Mel', '2026-07-12T00:00:00Z'), active('u-back', 'Bea', '2026-07-11T00:00:00Z')],
      activeCounts: { 'u-mile': 1, 'u-back': 1 },
      streaks: { 'u-mile': { current_streak: 7 } }, backClients: ['u-back'],
    });
    await buildRouter(db)('GET', '/api/coach/clients');
    // Exactly one back/return query drives the back cue; the reorder issues none of its own.
    expect(db.queries.filter(isBackQuery).length).toBe(1);
  });
});

describe('rosterTriageRank — warm, invisible triage weight, never a failure ranking', () => {
  it('scores a quiet client (reach-out live) at 2', () => {
    expect(rosterTriageRank({ reach_out_line: 'Might be a good time to check in.' })).toBe(2);
  });
  it('scores a leaning-in client at 1', () => {
    expect(rosterTriageRank({ engaged_this_week: true })).toBe(1);
  });
  it('scores a quiet AND leaning-in client at 3', () => {
    expect(rosterTriageRank({ reach_out_line: 'reach', engaged_this_week: true })).toBe(3);
  });
  it('scores a milestone-just-landed client at 1 (a celebration moment floats)', () => {
    expect(rosterTriageRank({ milestone_line: '🎯 7 kept words in a row — a milestone just landed.' })).toBe(1);
  });
  it('scores a back-and-moving client at 1 (a return floats)', () => {
    expect(rosterTriageRank({ back_line: 'Back and moving again — a great moment to say you noticed.' })).toBe(1);
  });
  it('counts a milestone AND a return once, not twice (one warm-moment dimension)', () => {
    expect(rosterTriageRank({ milestone_line: 'm', back_line: 'b' })).toBe(1);
  });
  it('stacks the celebration moment above leaning-in, but never past a gone-quiet client', () => {
    // milestone (+1) + leaning-in (+1) = 2 — a strong positive-touch card…
    expect(rosterTriageRank({ milestone_line: 'm', engaged_this_week: true })).toBe(2);
    // …yet a gone-quiet client (+2) alone still matches it, and outranks the moment alone.
    expect(rosterTriageRank({ reach_out_line: 'reach' })).toBe(2);
    expect(rosterTriageRank({ reach_out_line: 'reach', milestone_line: 'm', engaged_this_week: true })).toBe(4);
  });
  it('ignores an empty-string milestone/back cue (the copy returns "" off-moment)', () => {
    expect(rosterTriageRank({ milestone_line: '', back_line: '' })).toBe(0);
  });
  it('scores a calm, clean-page client at 0 (never negative — never demoted for calm)', () => {
    expect(rosterTriageRank({ reach_out_line: '', engaged_this_week: false })).toBe(0);
    expect(rosterTriageRank({})).toBe(0);
    expect(rosterTriageRank()).toBe(0);
  });
  it('counts engagement only on the exact boolean true (never a truthy near-miss)', () => {
    expect(rosterTriageRank({ engaged_this_week: 1 })).toBe(0);
    expect(rosterTriageRank({ engaged_this_week: 'yes' })).toBe(0);
  });
});
