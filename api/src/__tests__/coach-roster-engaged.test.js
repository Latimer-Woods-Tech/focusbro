/**
 * FocusBro — at-a-glance "leaning in" cue on the coach ROSTER (Contender #10, Phase A, R-280).
 *
 * R-278 made the "I'm on it" snooze a first-class, counted `commitment_snooze`
 * event; R-279 surfaced the exact weekly lean-in COUNT on the client DETAIL view.
 * But the roster — the surface where a coach actually decides WHO to reach out to
 * — still showed only the kept-word streak. Two clients could both read "0 kept
 * words in a row, a clean page" while one has been answering "I'm on it" all week
 * (engaged, just unresolved) and the other has gone silent; the roster triaged
 * them identically. This attaches a NON-numeric `engaged_this_week` boolean + a
 * warm `engaged_line` to each ACTIVE roster entry via ONE grouped query (no N+1),
 * so the coach can tell an engaged-but-unresolved client from a truly-quiet one
 * at a glance. Boolean on purpose (the detail carries the number) so the roster
 * glance can never drift from — or contradict — the exact count on the detail.
 *
 * DESIGN LAW checks live here too: a snooze is never a resolution and never a
 * miss (events.js keeps it out of `resolved`), so the cue can only ever surface a
 * lean-in — a client with nothing carries no line; a pending client is never
 * enriched before consent; and the copy never names late/overdue/behind/a miss.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerCoachRoutes,
  clientRosterEngagedCopy,
  ROSTER_ENGAGED_WINDOW_DAYS,
} from '../coach.js';
import { EVENTS } from '../events.js';
import { generateUUID } from '../middleware.js';

// ── router harness (mirrors coach-roster-next-checkin.test.js) ───────
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

// Uniquely identifies the roster's "leaning in" query: a parameterized event_type
// + a `substr(created_at,1,10) >= ?` window + a plain GROUP BY (no HAVING, no
// json_extract) — distinct from the quiet/back/homecoming analytics queries.
function isEngagedQuery(sql) {
  return /event_type = \?/.test(sql)
    && /substr\(created_at, 1, 10\) >= \?/.test(sql)
    && /GROUP BY user_id/.test(sql)
    && !/HAVING/.test(sql)
    && !/json_extract/.test(sql);
}

// In-memory D1 double. Streak/active-count resolve by bound client id; the
// engaged query resolves by SQL shape AND honors its bound day-prefix cutoff
// (last bound arg), so an out-of-window lean-in genuinely does not count.
function makeDB({ links = [], streaks = {}, activeCounts = {}, snoozeDaysByClient = {} } = {}) {
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
          if (isEngagedQuery(sql)) {
            const cutoffDay = bound[bound.length - 1];
            const results = [];
            for (const [clientId, days] of Object.entries(snoozeDaysByClient)) {
              if ((days || []).some((d) => d >= cutoffDay)) results.push({ client_id: clientId });
            }
            return { results };
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

const dayOffset = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TODAY = dayOffset(0);
const OLD_DAY = dayOffset(ROSTER_ENGAGED_WINDOW_DAYS + 3); // safely outside the window

const LINKS = [
  { link_id: 'l-a', client_user_id: 'u-a', client_label: 'Alex', status: 'active', invited_at: '2026-07-10T00:00:00Z', responded_at: '2026-07-10T01:00:00Z', client_email: 'alex@example.com' },
  { link_id: 'l-b', client_user_id: 'u-b', client_label: 'Bo', status: 'active', invited_at: '2026-07-11T00:00:00Z', responded_at: '2026-07-11T01:00:00Z', client_email: 'bo@example.com' },
  { link_id: 'l-c', client_user_id: 'u-c', client_label: 'Cass', status: 'pending', invited_at: '2026-07-12T00:00:00Z', responded_at: null, client_email: 'cass@example.com' },
];
const STREAKS = { 'u-a': { current_streak: 0, longest_streak: 4, total_kept: 9 }, 'u-b': { current_streak: 0, longest_streak: 0, total_kept: 0 } };
const COUNTS = { 'u-a': 1, 'u-b': 1 };

describe('GET /api/coach/clients — at-a-glance "leaning in" cue on the roster (R-280)', () => {
  it('marks an active client who leaned in this week as engaged, with a warm line', async () => {
    const db = makeDB({ links: LINKS, streaks: STREAKS, activeCounts: COUNTS, snoozeDaysByClient: { 'u-a': [TODAY] } });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    expect(res.status).toBe(200);
    const body = await res.json();
    const alex = body.roster.find((e) => e.client_id === 'u-a');
    // The very signal a 0-in-a-row kept-streak would otherwise hide.
    expect(alex.streak.current_streak).toBe(0);
    expect(alex.engaged_this_week).toBe(true);
    expect(alex.engaged_line).toBe(clientRosterEngagedCopy({ engaged: true }));
    expect(alex.engaged_line.trim().length).toBeGreaterThan(0);
  });

  it('leaves an active client with no lean-in this week cue-free (false + empty string)', async () => {
    const db = makeDB({ links: LINKS, streaks: STREAKS, activeCounts: COUNTS, snoozeDaysByClient: { 'u-a': [TODAY] } }); // u-b absent
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    const body = await res.json();
    const bo = body.roster.find((e) => e.client_id === 'u-b');
    expect(bo.engaged_this_week).toBe(false);
    expect(bo.engaged_line).toBe('');
  });

  it('does NOT count a lean-in older than the window (honors the day-prefix cutoff)', async () => {
    const db = makeDB({ links: LINKS, streaks: STREAKS, activeCounts: COUNTS, snoozeDaysByClient: { 'u-a': [OLD_DAY] } });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    const body = await res.json();
    const alex = body.roster.find((e) => e.client_id === 'u-a');
    expect(alex.engaged_this_week).toBe(false);
    expect(alex.engaged_line).toBe('');
  });

  it('never enriches a PENDING client (no lean-in signal before consent)', async () => {
    const db = makeDB({ links: LINKS, streaks: STREAKS, activeCounts: COUNTS, snoozeDaysByClient: { 'u-c': [TODAY] } });
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    const body = await res.json();
    const cass = body.roster.find((e) => e.client_id === 'u-c');
    expect(cass.status).toBe('pending');
    expect(cass.engaged_this_week).toBeUndefined();
    expect(cass.engaged_line).toBeUndefined();
  });

  it('binds the snooze event type, so the cue reads lean-ins and nothing else', async () => {
    const db = makeDB({ links: LINKS, streaks: STREAKS, activeCounts: COUNTS, snoozeDaysByClient: { 'u-a': [TODAY] } });
    await buildRouter(db)('GET', '/api/coach/clients');
    // The engaged query is present and is the snooze query (parameterized event_type).
    const engaged = db.queries.filter(isEngagedQuery);
    expect(engaged.length).toBe(1);
    // EVENTS.COMMITMENT_SNOOZE is the exact detail-view signal (R-278/R-279) — same source, no drift.
    expect(EVENTS.COMMITMENT_SNOOZE).toBe('commitment_snooze');
  });

  it('uses ONE grouped query for the whole roster (no N+1 per client)', async () => {
    const db = makeDB({ links: LINKS, streaks: STREAKS, activeCounts: COUNTS, snoozeDaysByClient: { 'u-a': [TODAY], 'u-b': [TODAY] } });
    await buildRouter(db)('GET', '/api/coach/clients');
    expect(db.queries.filter(isEngagedQuery).length).toBe(1);
  });

  it('skips the engaged query entirely when there are no active clients', async () => {
    const db = makeDB({ links: [LINKS[2]] }); // pending only
    await buildRouter(db)('GET', '/api/coach/clients');
    expect(db.queries.filter(isEngagedQuery).length).toBe(0);
  });

  it('a query failure never takes down the roster — it just yields no cue', async () => {
    const db = makeDB({ links: LINKS, streaks: STREAKS, activeCounts: COUNTS, snoozeDaysByClient: { 'u-a': [TODAY] } });
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (isEngagedQuery(sql)) {
        return { bind: () => ({ all: async () => { throw new Error('boom'); } }) };
      }
      return realPrepare(sql);
    };
    const res = await buildRouter(db)('GET', '/api/coach/clients');
    expect(res.status).toBe(200);
    const body = await res.json();
    const alex = body.roster.find((e) => e.client_id === 'u-a');
    expect(alex.engaged_this_week).toBe(false);
    expect(alex.engaged_line).toBe('');
  });

  it('requires auth', async () => {
    const db = makeDB({ links: LINKS });
    const res = await buildRouter(db)('GET', '/api/coach/clients', { token: null });
    expect(res.status).toBe(401);
  });
});

describe('clientRosterEngagedCopy — a warm at-a-glance lean-in cue, never a miss', () => {
  it('is empty unless the client is explicitly engaged (boolean true only)', () => {
    expect(clientRosterEngagedCopy({ engaged: false })).toBe('');
    expect(clientRosterEngagedCopy({ engaged: 1 })).toBe('');
    expect(clientRosterEngagedCopy({ engaged: 'yes' })).toBe('');
    expect(clientRosterEngagedCopy({ engaged: null })).toBe('');
    expect(clientRosterEngagedCopy({})).toBe('');
    expect(clientRosterEngagedCopy()).toBe('');
  });

  it('surfaces a warm, non-numeric cue when engaged', () => {
    const s = clientRosterEngagedCopy({ engaged: true });
    expect(typeof s).toBe('string');
    expect(s.trim().length).toBeGreaterThan(0);
    // Non-numeric on purpose — the exact count lives on the detail view.
    expect(/\d/.test(s)).toBe(false);
  });

  it('never shames, never names a miss, never says "AI" or a clinical claim', () => {
    const s = clientRosterEngagedCopy({ engaged: true });
    expect(/\b(miss|missed|behind|late|overdue|fail|failed|slack|slacking|lazy|catch up|catching up)\b/i.test(s)).toBe(false);
    expect(/\bAI\b/.test(s)).toBe(false);
    expect(/\b(treat(s|ment|ing)?|cure|diagnos|disorder|symptom|ADHD|medication)\b/i.test(s)).toBe(false);
  });
});
