/**
 * FocusBro — "set it down" release path (Contender #10, Phase A).
 *
 * Plans change. Before this, the only exits from an active word were
 * kept / missed / reschedule, so a commitment a person no longer intends to
 * keep just sat `active` and the delivery cron nudged it forever. Setting a
 * word DOWN is the blameless exit:
 *   - the commitment moves to a terminal `released` state,
 *   - every still-waiting check-in (pending or held for quiet hours) is
 *     cancelled so the bro stops ringing,
 *   - and the kept-word streak is NEVER read or written — releasing protects
 *     the chain by construction (the design LAW: never a miss, never a scold).
 *
 * This suite drives the real `/api/commitments/:id/release` route through
 * itty-router with an in-memory D1 double, plus the design-LAW scan on the
 * confirmation copy.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerAccountabilityRoutes, releaseConfirmCopy } from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── router harness ───────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (request) => {
    const h = request.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  // 'good' → user u1; anything else → invalid.
  verifyToken: async (token) => (token === 'good' ? { sub: 'u1' } : null),
  jsonResponse,
  generateUUID,
};

// In-memory D1 double: returns `commitment` for the ownership SELECT and records
// every run() so the test can assert what was (and was NOT) written.
function makeDB({ commitment = null } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return commitment;
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
  return (method, path, { token = 'good' } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = new Request('https://x' + path, { method, headers });
    return router.handle(req, env);
  };
}

const activeOneShot = { id: 'cm1', title: 'file the taxes', persona: 'ally', status: 'active' };

describe('POST /api/commitments/:id/release — the blameless exit', () => {
  it('sets the commitment down (status=released) and returns a warm message', async () => {
    const db = makeDB({ commitment: activeOneShot });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/release');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commitment.status).toBe('released');
    expect(typeof body.message).toBe('string');
    expect(body.message.trim().length).toBeGreaterThan(0);

    const cUpd = db.runs.find((x) => /UPDATE commitments SET status = 'released'/.test(x.sql));
    expect(cUpd, 'commitment moved to released').toBeTruthy();
  });

  it('cancels the still-waiting check-ins so the cron stops ringing', async () => {
    const db = makeDB({ commitment: activeOneShot });
    const call = buildRouter(db);
    await call('POST', '/api/commitments/cm1/release');
    const ciUpd = db.runs.find((x) =>
      /UPDATE commitment_checkins SET status = 'cancelled'/.test(x.sql) &&
      /status IN \('pending', 'deferred'\)/.test(x.sql));
    expect(ciUpd, 'pending/deferred check-ins cancelled').toBeTruthy();
  });

  it('NEVER touches the kept-word streak — releasing protects the chain', async () => {
    const db = makeDB({ commitment: activeOneShot });
    const call = buildRouter(db);
    await call('POST', '/api/commitments/cm1/release');
    // No read and no write of accountability_streaks anywhere in the release path.
    expect(db.runs.some((x) => /accountability_streaks/.test(x.sql))).toBe(false);
  });

  it('404s a commitment the user does not own (no leak, no write)', async () => {
    const db = makeDB({ commitment: null });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/nope/release');
    expect(res.status).toBe(404);
    // nothing was mutated
    expect(db.runs.some((x) => /UPDATE commitments/.test(x.sql))).toBe(false);
  });

  it('401s without a valid token', async () => {
    const db = makeDB({ commitment: activeOneShot });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/release', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.runs.length).toBe(0);
  });
});

// ── the design LAW on the release copy ───────────────────────
describe('releaseConfirmCopy — a blameless exit, never a miss', () => {
  const SHAME = [
    /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
    /\bashamed\b/i, /\bshame\b/i, /\bquit(ter|ting)?\b/i, /\bgave up\b/i, /\bgiving up\b/i,
    /\byou (didn.?t|should have|should.?ve)\b/i, /\bexcuse/i, /\bpathetic\b/i, /\bworthless\b/i,
  ];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI = /\bAI\b/;

  const samples = ['ally', 'hype', 'unknown'].map((persona) => releaseConfirmCopy({ persona }));

  it('are non-empty strings', () => {
    for (const s of samples) { expect(typeof s).toBe('string'); expect(s.trim().length).toBeGreaterThan(0); }
  });
  it('never shame (incl. "quit" / "gave up")', () => {
    for (const s of samples) for (const p of SHAME) expect(p.test(s), `"${s}" matched ${p}`).toBe(false);
  });
  it('never say "AI" and never make a clinical claim', () => {
    for (const s of samples) {
      expect(AI.test(s), `"AI" leaked: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical: "${s}" matched ${p}`).toBe(false);
    }
  });
  it('reassure that the streak is safe', () => {
    for (const s of samples) expect(s.toLowerCase()).toMatch(/streak/);
  });
});
