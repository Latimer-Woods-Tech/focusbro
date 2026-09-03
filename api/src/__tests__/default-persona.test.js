/**
 * FocusBro — the companion tone is remembered per person (Contender #10, Phase A).
 *
 * The vision names persona "configurable ... per user," but tone lived only
 * per-word: a returning person had to re-pick their voice (calm ally vs. hype)
 * on every commitment. This suite pins the per-user default:
 *   - giving a word persists the chosen tone onto the existing per-user prefs
 *     row (an upsert that touches ONLY default_persona, never the ceiling),
 *   - the streak endpoint reads that tone back as `default_persona` so /me/ can
 *     pre-select it,
 *   - a person who never chose gets `default_persona: null` (the form keeps its
 *     own standing default — the calm ally),
 *   - an unknown stored value is normalized to the calm ally, never surfaced raw.
 *
 * DESIGN LAW note: both tones are warm; this only remembers which warm voice a
 * person prefers — it can never surface a miss or a tally.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerAccountabilityRoutes } from '../accountability.js';
import { generateUUID } from '../middleware.js';

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

// In-memory D1 double: records every run() so writes can be asserted, and routes
// first()/all() by SQL so reads (streak row, saved pref) can be scripted per test.
function makeDB({ prefRow = null, streakRow = null } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM escalation_prefs/i.test(sql)) return prefRow;
          if (/FROM accountability_streaks/i.test(sql)) return streakRow;
          return null;
        },
        async all() { return { results: [] }; },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
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
  return (method, path, { token = 'good', body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const req = new Request('https://x' + path, init);
    return router.handle(req, env);
  };
}

const prefUpsert = (runs) => runs.find((x) => /INSERT INTO escalation_prefs/i.test(x.sql));

describe('per-user default companion tone', () => {
  it('remembers the chosen tone on the per-user prefs row when a word is given', async () => {
    const db = makeDB();
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments', {
      body: { title: 'start the taxes', start_at: '2099-01-01T15:00:00.000Z', persona: 'hype', channel: 'push' },
    });
    expect(res.status).toBe(201);

    const up = prefUpsert(db.runs);
    expect(up).toBeTruthy();
    // Upsert touches ONLY default_persona — never the escalation ceiling.
    expect(up.sql).toMatch(/default_persona/);
    expect(up.sql).not.toMatch(/\bceiling\b/);
    expect(up.sql).toMatch(/ON CONFLICT\(user_id\) DO UPDATE/i);
    expect(up.params).toContain('hype');
  });

  it('a pref write failure never sinks the saved word (non-fatal)', async () => {
    // DB double whose escalation_prefs write throws; the commitment insert still
    // succeeds and the endpoint returns 201.
    const runs = [];
    const db = {
      runs,
      prepare(sql) {
        let params = [];
        const stmt = {
          bind(...a) { params = a; return stmt; },
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() {
            if (/INSERT INTO escalation_prefs/i.test(sql)) throw new Error('boom');
            runs.push({ sql, params });
            return { success: true, meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    const router = Router();
    registerAccountabilityRoutes(router, ctx);
    const env = { DB: db, JWT_SECRET: 'test' };
    const req = new Request('https://x/api/commitments', {
      method: 'POST',
      headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'call the dentist', start_at: '2099-01-01T15:00:00.000Z', persona: 'ally', channel: 'push' }),
    });
    const res = await router.handle(req, env);
    expect(res.status).toBe(201);
    expect(runs.some((x) => /INSERT INTO commitments\b/.test(x.sql))).toBe(true);
  });

  it('the streak endpoint reads back the saved tone as default_persona', async () => {
    const db = makeDB({ prefRow: { default_persona: 'hype' } });
    const call = buildRouter(db);
    const res = await call('GET', '/api/accountability/streak');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.default_persona).toBe('hype');
  });

  it('a person who never chose gets default_persona: null', async () => {
    const db = makeDB({ prefRow: null });
    const call = buildRouter(db);
    const res = await call('GET', '/api/accountability/streak');
    const body = await res.json();
    expect(body.default_persona).toBeNull();
  });

  it('an unknown stored tone is normalized to the calm ally, never surfaced raw', async () => {
    const db = makeDB({ prefRow: { default_persona: 'boss-mode' } });
    const call = buildRouter(db);
    const res = await call('GET', '/api/accountability/streak');
    const body = await res.json();
    expect(body.default_persona).toBe('ally');
  });
});
