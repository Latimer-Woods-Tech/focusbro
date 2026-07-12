/**
 * FocusBro — person-facing next check-in on the /me/ list (Contender #10, Phase A, R-233).
 *
 * The /me/ list showed each word's original start time + cadence, but the
 * concrete NEXT moment the bro shows up lived only in the per-word detail panel
 * (R-222). This slice attaches `next_checkin` to every ACTIVE word in
 * `GET /api/commitments` — one grouped query, no N+1 — so the person sees it
 * across their whole list at a glance (the person-side twin of the coach's
 * next-check-in, R-224).
 *
 * DESIGN LAW checks live here too: a resolved/kept/moved word carries no
 * next_checkin, and the copy for an already-past-but-open check-in is warm
 * ("still here"), never a "late"/"overdue"/miss scold.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerAccountabilityRoutes } from '../accountability.js';
import { listNextCheckinLabelCopy, listNextCheckinWaitingCopy } from '../me.js';
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

// In-memory D1 double. The commitments list query returns `commitments`; the
// grouped outstanding-check-in query returns `outstanding` rows shaped
// { commitment_id, next_checkin }.
function makeDB({ commitments = [], outstanding = [] } = {}) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      queries.push(sql);
      const stmt = {
        bind() { return stmt; },
        async first() { return null; },
        async all() {
          if (/FROM commitments\b/.test(sql)) return { results: commitments };
          if (/FROM commitment_checkins/.test(sql) && /GROUP BY commitment_id/.test(sql)) {
            return { results: outstanding };
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

const ACTIVE = { id: 'c-active', title: 'start the taxes', status: 'active', start_at: '2026-07-12T14:00:00Z', recurrence: 'none' };
const RECUR = { id: 'c-recur', title: 'morning pages', status: 'active', start_at: '2026-07-12T08:00:00Z', recurrence: 'daily' };
const KEPT = { id: 'c-kept', title: 'call the dentist', status: 'kept', start_at: '2026-07-10T09:00:00Z', recurrence: 'none' };

describe('GET /api/commitments — next check-in attached to active words (R-233)', () => {
  it('attaches next_checkin to each active word from the grouped outstanding query', async () => {
    const db = makeDB({
      commitments: [ACTIVE, RECUR, KEPT],
      outstanding: [
        { commitment_id: 'c-active', next_checkin: '2026-07-12T15:00:00Z' },
        { commitment_id: 'c-recur', next_checkin: '2026-07-13T08:00:00Z' },
      ],
    });
    const res = await buildRouter(db)('GET', '/api/commitments');
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.commitments.map((c) => [c.id, c]));
    expect(byId['c-active'].next_checkin).toBe('2026-07-12T15:00:00Z');
    expect(byId['c-recur'].next_checkin).toBe('2026-07-13T08:00:00Z');
  });

  it('never attaches a next_checkin to a non-active (kept/moved/released) word', async () => {
    const db = makeDB({
      commitments: [KEPT],
      // Even if a stray outstanding row existed for it, a non-active word stays null.
      outstanding: [{ commitment_id: 'c-kept', next_checkin: '2026-07-12T15:00:00Z' }],
    });
    const res = await buildRouter(db)('GET', '/api/commitments');
    const body = await res.json();
    expect(body.commitments[0].next_checkin).toBeNull();
  });

  it('leaves next_checkin null for an active word with nothing queued', async () => {
    const db = makeDB({ commitments: [ACTIVE], outstanding: [] });
    const res = await buildRouter(db)('GET', '/api/commitments');
    const body = await res.json();
    expect(body.commitments[0].next_checkin).toBeNull();
  });

  it('uses ONE grouped query for outstanding check-ins (no N+1 per commitment)', async () => {
    const db = makeDB({
      commitments: [ACTIVE, RECUR],
      outstanding: [{ commitment_id: 'c-active', next_checkin: '2026-07-12T15:00:00Z' }],
    });
    await buildRouter(db)('GET', '/api/commitments');
    const grouped = db.queries.filter((q) => /FROM commitment_checkins/.test(q) && /GROUP BY commitment_id/.test(q));
    expect(grouped.length).toBe(1);
  });

  it('requires auth', async () => {
    const db = makeDB({ commitments: [ACTIVE] });
    const res = await buildRouter(db)('GET', '/api/commitments', { token: null });
    expect(res.status).toBe(401);
  });
});

describe('R-233 copy obeys the design LAW (never shame)', () => {
  const strings = [listNextCheckinLabelCopy(), listNextCheckinWaitingCopy()];
  const banned = /\b(late|overdue|missed|miss|behind|fail|failed|failure|slack(ing)?|lazy|should have|guilt|shame|AI|diagnos|treat(ment)?|cure)\b/i;

  it('the label and the waiting line carry no shame, no miss tally, no "AI", no clinical claim', () => {
    for (const s of strings) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
      expect(banned.test(s), `banned word in: "${s}"`).toBe(false);
    }
  });

  it('the waiting line is warmly forward, not a scold about time passing', () => {
    expect(listNextCheckinWaitingCopy().toLowerCase()).toContain('still here');
  });
});
