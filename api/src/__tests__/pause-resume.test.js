/**
 * FocusBro — pause / resume a recurring rhythm (Contender #10, Phase A).
 *
 * "The bro who calls you every day" needs an off switch that isn't a goodbye.
 * Pause suspends a repeating rhythm on purpose — life happens, you go away — and
 * resume brings it back, without ever ending the word or breaking the chain:
 *   - pause moves the commitment to 'paused' and cancels its still-waiting
 *     check-ins (pending / deferred → cancelled) so the bro stops ringing,
 *   - the delivery cron's materializer only re-queues an 'active' commitment, so
 *     nothing new is scheduled while paused,
 *   - resume returns it to 'active' and schedules the next occurrence from now
 *     (no backlog of the days away),
 *   - the kept-word streak is NEVER read or written on either path — a pause is
 *     not a miss, by construction,
 *   - pause is for a *rhythm*: a one-shot word is warmly refused (409), as is a
 *     non-active pause / non-paused resume, with nothing mutated.
 *
 * This suite drives the real routes through itty-router with an in-memory D1
 * double, plus the design-LAW scan on the confirmation copy.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerAccountabilityRoutes,
  pauseConfirmCopy,
  resumeConfirmCopy,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── router harness (mirrors snooze.test.js) ──────────────────
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

// In-memory D1 double: returns `commitment` for the ownership SELECT and
// `existingPending` for the "is a future check-in already queued?" SELECT that
// ensureNextOccurrence runs. Records every run() so the test can assert exactly
// what was — and was NOT — written.
function makeDB({ commitment = null, existingPending = null } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return commitment;
          if (/FROM commitment_checkins/.test(sql) && /status = 'pending' AND scheduled_for > \?/.test(sql)) {
            return existingPending;
          }
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

const recurringActive = { id: 'cm1', persona: 'ally', channel: 'push', recurrence: 'daily', timezone: 'UTC', local_time: '08:40', status: 'active' };
const recurringPaused = { ...recurringActive, status: 'paused' };
const oneShotActive = { id: 'cm2', persona: 'ally', channel: 'push', recurrence: 'none', timezone: 'UTC', local_time: null, status: 'active' };

// ── PAUSE ────────────────────────────────────────────────────
describe('POST /api/commitments/:id/pause — take a break', () => {
  it('pauses a recurring active rhythm and stops the bro ringing', async () => {
    const db = makeDB({ commitment: recurringActive });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/pause');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commitment.status).toBe('paused');
    expect(typeof body.message).toBe('string');
    expect(body.message.trim().length).toBeGreaterThan(0);

    // The word moved to 'paused'…
    expect(db.runs.some((x) => /UPDATE commitments SET status = 'paused'/.test(x.sql))).toBe(true);
    // …and its still-waiting check-ins were cancelled (pending + deferred).
    const cancel = db.runs.find((x) =>
      /UPDATE commitment_checkins SET status = 'cancelled'/.test(x.sql) &&
      /status IN \('pending', 'deferred', 'awaiting_time'\)/.test(x.sql));
    expect(cancel, 'cancelled the waiting check-ins').toBeTruthy();
  });

  it('NEVER touches the kept-word streak — a pause is not a miss', async () => {
    const db = makeDB({ commitment: recurringActive });
    await buildRouter(db)('POST', '/api/commitments/cm1/pause');
    expect(db.runs.some((x) => /accountability_streaks/.test(x.sql))).toBe(false);
  });

  it('409s a one-time word (pause is for a rhythm) and mutates nothing', async () => {
    const db = makeDB({ commitment: oneShotActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm2/pause');
    expect(res.status).toBe(409);
    expect(db.runs.length).toBe(0);
  });

  it('409s a word that is not active, and mutates nothing', async () => {
    const db = makeDB({ commitment: { ...recurringActive, status: 'kept' } });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/pause');
    expect(res.status).toBe(409);
    expect(db.runs.length).toBe(0);
  });

  it('404s a commitment the user does not own (no leak, no write)', async () => {
    const db = makeDB({ commitment: null });
    const res = await buildRouter(db)('POST', '/api/commitments/nope/pause');
    expect(res.status).toBe(404);
    expect(db.runs.length).toBe(0);
  });

  it('401s without a valid token', async () => {
    const db = makeDB({ commitment: recurringActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/pause', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.runs.length).toBe(0);
  });
});

// ── RESUME ───────────────────────────────────────────────────
describe('POST /api/commitments/:id/resume — welcome back', () => {
  it('resumes a paused rhythm and schedules the next occurrence from now', async () => {
    const db = makeDB({ commitment: recurringPaused, existingPending: null });
    const call = buildRouter(db);
    const before = Date.now();
    const res = await call('POST', '/api/commitments/cm1/resume');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commitment.status).toBe('active');

    // Back to 'active'…
    expect(db.runs.some((x) => /UPDATE commitments SET status = 'active'/.test(x.sql))).toBe(true);
    // …and a fresh pending check-in was materialized in the future.
    const ins = db.runs.find((x) => /INSERT INTO commitment_checkins/.test(x.sql) && /'pending'/.test(x.sql));
    expect(ins, 'the next occurrence was scheduled').toBeTruthy();
    const nextISO = body.next_checkin && body.next_checkin.scheduled_for;
    expect(Date.parse(nextISO)).toBeGreaterThan(before);
    // The confirmation names when the bro comes back.
    expect(body.message).toMatch(/Next check-in/);
  });

  it('does not double-schedule if a future check-in is already queued', async () => {
    const db = makeDB({ commitment: recurringPaused, existingPending: { id: 'already' } });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/resume');
    expect(res.status).toBe(200);
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('NEVER touches the kept-word streak — the time away was allowed', async () => {
    const db = makeDB({ commitment: recurringPaused });
    await buildRouter(db)('POST', '/api/commitments/cm1/resume');
    expect(db.runs.some((x) => /accountability_streaks/.test(x.sql))).toBe(false);
  });

  it('409s a word that is not paused, and mutates nothing', async () => {
    const db = makeDB({ commitment: recurringActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/resume');
    expect(res.status).toBe(409);
    expect(db.runs.length).toBe(0);
  });

  it('404s a commitment the user does not own (no leak, no write)', async () => {
    const db = makeDB({ commitment: null });
    const res = await buildRouter(db)('POST', '/api/commitments/nope/resume');
    expect(res.status).toBe(404);
    expect(db.runs.length).toBe(0);
  });

  it('401s without a valid token', async () => {
    const db = makeDB({ commitment: recurringPaused });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/resume', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.runs.length).toBe(0);
  });
});

// ── the design LAW on the pause / resume copy ────────────────
describe('pause / resume copy — a break is allowed, never a scold', () => {
  const SHAME = [
    /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
    /\bashamed\b/i, /\bshame\b/i, /\bquit(ter|ting)?\b/i, /\bgave up\b/i, /\bgiving up\b/i,
    /\bmiss(ed|ing|es)?\b/i, /\bbehind\b/i, /\byou (didn.?t|should have|should.?ve)\b/i,
    /\bexcuse/i, /\bcatch(ing)? up\b/i, /\bmake up for\b/i, /\bhurry\b/i, /\bpathetic\b/i,
  ];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI = /\bAI\b/;

  const samples = ['ally', 'hype', 'unknown'].flatMap((persona) => [
    pauseConfirmCopy({ persona }),
    resumeConfirmCopy({ persona, when: '2026-07-11T08:40:00Z' }),
    resumeConfirmCopy({ persona }),
  ]);

  it('are non-empty strings', () => {
    for (const s of samples) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });
  it('never shame (incl. "miss" / "behind" / "catch up")', () => {
    for (const s of samples) for (const p of SHAME) expect(p.test(s), `"${s}" matched ${p}`).toBe(false);
  });
  it('never say "AI" and never make a clinical claim', () => {
    for (const s of samples) {
      expect(AI.test(s), `"AI" leaked: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical: "${s}" matched ${p}`).toBe(false);
    }
  });
  it('resume names the next check-in when one is scheduled', () => {
    for (const persona of ['ally', 'hype']) {
      expect(resumeConfirmCopy({ persona, when: '2026-07-11T08:40:00Z' })).toMatch(/Next check-in/);
    }
  });
});
