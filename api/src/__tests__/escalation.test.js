import { describe, expect, it } from 'vitest';
import {
  CEILING_LEVELS,
  DEFAULT_CEILING,
  getEscalationCeiling,
  registerConsentRoutes,
} from '../consent.js';

// The escalation ceiling is the wedge: the person sets the hardest rung the
// ladder may ever climb, and nothing crosses it. These tests pin the model
// (levels + safe default), the reader, and the GET/POST routes.

// D1-shaped stub: the escalation_prefs read returns `stored`; every prepared
// statement records its SQL + bound params so we can assert the upsert.
function makeDB({ stored = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      let params = [];
      return {
        bind(...p) { params = p; return this; },
        first: async () => (/FROM escalation_prefs/.test(sql) ? stored : null),
        run: async () => { calls.push({ sql, params }); return { success: true }; },
        all: async () => ({ results: [] }),
      };
    },
  };
}

describe('escalation ceiling — the wedge model', () => {
  it('exposes the low→high rungs and a safe default', () => {
    expect(CEILING_LEVELS).toEqual(['none', 'text', 'call']);
    expect(DEFAULT_CEILING).toBe('text');
    expect(CEILING_LEVELS).toContain(DEFAULT_CEILING);
  });

  it('getEscalationCeiling returns the stored rung', async () => {
    expect(await getEscalationCeiling({ DB: makeDB({ stored: { ceiling: 'none' } }) }, 'u1')).toBe('none');
    expect(await getEscalationCeiling({ DB: makeDB({ stored: { ceiling: 'call' } }) }, 'u1')).toBe('call');
  });

  it('defaults to text when unset, unknown, or on a read error (never silences the ladder)', async () => {
    expect(await getEscalationCeiling({ DB: makeDB({ stored: null }) }, 'u1')).toBe('text');
    expect(await getEscalationCeiling({ DB: makeDB({ stored: { ceiling: 'wat' } }) }, 'u1')).toBe('text');
    const boom = { DB: { prepare() { throw new Error('db down'); } } };
    expect(await getEscalationCeiling(boom, 'u1')).toBe('text');
  });
});

// Capture the handlers registerConsentRoutes registers, then drive the two
// escalation routes directly with a stub ctx (no JWT crypto needed).
function escalationRoutes(db) {
  const routes = {};
  const router = {
    get: (p, h) => { routes['GET ' + p] = h; },
    post: (p, h) => { routes['POST ' + p] = h; },
  };
  const ctx = {
    getAuthToken: () => 'tok',
    verifyToken: async () => ({ sub: 'u1' }),
    jsonResponse: (body, status = 200) => ({ body, status }),
    generateUUID: () => 'uuid',
  };
  registerConsentRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 's' };
  return {
    get: () => routes['GET /api/escalation']({ headers: { get: () => null } }, env),
    post: (payload) => routes['POST /api/escalation']({ json: async () => payload }, env),
  };
}

describe('GET/POST /api/escalation', () => {
  it('GET returns the current ceiling and the level set', async () => {
    const r = await escalationRoutes(makeDB({ stored: { ceiling: 'none' } })).get();
    expect(r.status).toBe(200);
    expect(r.body.ceiling).toBe('none');
    expect(r.body.levels).toEqual(CEILING_LEVELS);
  });

  it('GET falls back to the default when nothing is stored', async () => {
    const r = await escalationRoutes(makeDB({ stored: null })).get();
    expect(r.body.ceiling).toBe('text');
  });

  it('POST upserts a valid ceiling (user + rung bound)', async () => {
    const db = makeDB();
    const r = await escalationRoutes(db).post({ ceiling: 'none' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, ceiling: 'none' });
    const upsert = db.calls.find((c) => /INSERT INTO escalation_prefs/.test(c.sql));
    expect(upsert).toBeTruthy();
    expect(upsert.sql).toMatch(/ON CONFLICT\(user_id\) DO UPDATE/);
    expect(upsert.params).toEqual(['u1', 'none']);
  });

  it('POST accepts "call" forward-compatibly (the voice rung, stored now)', async () => {
    const r = await escalationRoutes(makeDB()).post({ ceiling: 'call' });
    expect(r.status).toBe(200);
    expect(r.body.ceiling).toBe('call');
  });

  it('POST rejects an unknown ceiling with 400 and never writes', async () => {
    const db = makeDB();
    const r = await escalationRoutes(db).post({ ceiling: 'nuclear' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/none, text, call/);
    expect(db.calls.find((c) => /INSERT INTO escalation_prefs/.test(c.sql))).toBeFalsy();
  });

  it('POST rejects a missing ceiling with 400', async () => {
    const r = await escalationRoutes(makeDB()).post({});
    expect(r.status).toBe(400);
  });
});
