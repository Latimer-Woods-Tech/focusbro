/**
 * FocusBro — "I'm on it" snooze path (Contender #10, Phase A).
 *
 * A real accountability friend has a third answer between "I did it" and "move
 * the whole thing": "I'm on it — check back in a bit." A push nudge swiped away
 * in half a second is the exact ADHD failure mode this product beats; snooze
 * keeps the nudge alive without moving the word or touching the streak:
 *   - it re-arms the latest still-open check-in (pending / sent / deferred) a few
 *     minutes out, or opens a fresh pending one if none is open,
 *   - the requested interval is clamped to a sane window (default / floor / ceil),
 *   - the kept-word streak is NEVER read or written — a snooze is not a
 *     resolution, by construction,
 *   - a word already kept / moved / set down is warmly refused (409), never an
 *     error tone, and nothing is mutated.
 *
 * This suite drives the real `/api/commitments/:id/snooze` route through
 * itty-router with an in-memory D1 double, plus the design-LAW scan on the copy.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerAccountabilityRoutes,
  snoozeConfirmCopy,
  clampSnoozeMinutes,
  SNOOZE_DEFAULT_MIN,
  SNOOZE_MIN_MIN,
  SNOOZE_MAX_MIN,
} from '../accountability.js';
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

// In-memory D1 double: returns `commitment` for the ownership SELECT and
// `openCheckin` for the open-check-in SELECT; records every run() so the test
// can assert exactly what was (and was NOT) written.
function makeDB({ commitment = null, openCheckin = null } = {}) {
  const runs = [];
  const db = {
    runs,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return commitment;
          if (/FROM commitment_checkins/.test(sql) && /status IN \('pending', 'sent', 'deferred'\)/.test(sql)) {
            return openCheckin;
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

const activeCommitment = { id: 'cm1', persona: 'ally', channel: 'push', status: 'active' };
const openSent = { id: 'ci1' };

describe('POST /api/commitments/:id/snooze — "I\'m on it"', () => {
  it('re-arms the latest open check-in a few minutes out (status back to pending)', async () => {
    const db = makeDB({ commitment: activeCommitment, openCheckin: openSent });
    const call = buildRouter(db);
    const before = Date.now();
    const res = await call('POST', '/api/commitments/cm1/snooze');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.minutes).toBe(SNOOZE_DEFAULT_MIN);
    expect(typeof body.message).toBe('string');
    expect(body.message.trim().length).toBeGreaterThan(0);

    // The open check-in was re-armed to a FUTURE time, pending again, attempts reset.
    const upd = db.runs.find((x) =>
      /UPDATE commitment_checkins/.test(x.sql) &&
      /status = 'pending'/.test(x.sql) &&
      /attempts = 0/.test(x.sql));
    expect(upd, 're-armed the open check-in').toBeTruthy();
    // scheduled_for is the first bound param and must be in the future.
    const snoozedUntil = Date.parse(upd.params[0]);
    expect(snoozedUntil).toBeGreaterThanOrEqual(before + (SNOOZE_MIN_MIN - 1) * 60000);
    expect(body.snoozed_until).toBe(upd.params[0]);

    // It re-arms — never INSERTs a duplicate — when an open check-in exists.
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('opens a fresh pending check-in when none is open, so the bro still comes back', async () => {
    const db = makeDB({ commitment: activeCommitment, openCheckin: null });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/snooze');
    expect(res.status).toBe(200);
    const ins = db.runs.find((x) => /INSERT INTO commitment_checkins/.test(x.sql) && /'pending'/.test(x.sql));
    expect(ins, 'a fresh pending check-in was opened').toBeTruthy();
    expect(db.runs.some((x) => /UPDATE commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('clamps the requested minutes to the allowed window', async () => {
    const tooLow = await (buildRouter(makeDB({ commitment: activeCommitment, openCheckin: openSent }))(
      'POST', '/api/commitments/cm1/snooze', { body: { minutes: 1 } })).then((r) => r.json());
    expect(tooLow.minutes).toBe(SNOOZE_MIN_MIN);

    const tooHigh = await (buildRouter(makeDB({ commitment: activeCommitment, openCheckin: openSent }))(
      'POST', '/api/commitments/cm1/snooze', { body: { minutes: 9999 } })).then((r) => r.json());
    expect(tooHigh.minutes).toBe(SNOOZE_MAX_MIN);

    const inRange = await (buildRouter(makeDB({ commitment: activeCommitment, openCheckin: openSent }))(
      'POST', '/api/commitments/cm1/snooze', { body: { minutes: 30 } })).then((r) => r.json());
    expect(inRange.minutes).toBe(30);
  });

  it('NEVER touches the kept-word streak — a snooze is not a resolution', async () => {
    const db = makeDB({ commitment: activeCommitment, openCheckin: openSent });
    const call = buildRouter(db);
    await call('POST', '/api/commitments/cm1/snooze');
    expect(db.runs.some((x) => /accountability_streaks/.test(x.sql))).toBe(false);
  });

  it('never moves the commitment itself (the word is unchanged)', async () => {
    const db = makeDB({ commitment: activeCommitment, openCheckin: openSent });
    const call = buildRouter(db);
    await call('POST', '/api/commitments/cm1/snooze');
    expect(db.runs.some((x) => /UPDATE commitments/.test(x.sql))).toBe(false);
  });

  it('409s warmly a word that is not active, and mutates nothing', async () => {
    const db = makeDB({ commitment: { ...activeCommitment, status: 'kept' }, openCheckin: openSent });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/snooze');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(db.runs.length).toBe(0);
  });

  it('404s a commitment the user does not own (no leak, no write)', async () => {
    const db = makeDB({ commitment: null });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/nope/snooze');
    expect(res.status).toBe(404);
    expect(db.runs.length).toBe(0);
  });

  it('401s without a valid token', async () => {
    const db = makeDB({ commitment: activeCommitment, openCheckin: openSent });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/snooze', { token: 'bad' });
    expect(res.status).toBe(401);
    expect(db.runs.length).toBe(0);
  });
});

// ── clampSnoozeMinutes unit ──────────────────────────────────
describe('clampSnoozeMinutes', () => {
  it('defaults missing / garbage to SNOOZE_DEFAULT_MIN', () => {
    expect(clampSnoozeMinutes(undefined)).toBe(SNOOZE_DEFAULT_MIN);
    expect(clampSnoozeMinutes(null)).toBe(SNOOZE_DEFAULT_MIN);
    expect(clampSnoozeMinutes('nope')).toBe(SNOOZE_DEFAULT_MIN);
    expect(clampSnoozeMinutes(NaN)).toBe(SNOOZE_DEFAULT_MIN);
  });
  it('clamps to the [floor, ceil] window and rounds', () => {
    expect(clampSnoozeMinutes(0)).toBe(SNOOZE_MIN_MIN);
    expect(clampSnoozeMinutes(-10)).toBe(SNOOZE_MIN_MIN);
    expect(clampSnoozeMinutes(100000)).toBe(SNOOZE_MAX_MIN);
    expect(clampSnoozeMinutes(30.4)).toBe(30);
    expect(clampSnoozeMinutes('45')).toBe(45);
  });
});

// ── the design LAW on the snooze copy ────────────────────────
describe('snoozeConfirmCopy — glad you\'re on it, never pressure', () => {
  const SHAME = [
    /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
    /\bashamed\b/i, /\bshame\b/i, /\bquit(ter|ting)?\b/i, /\bgave up\b/i, /\bgiving up\b/i,
    /\byou (didn.?t|should have|should.?ve)\b/i, /\bexcuse/i, /\bdon.?t forget\b/i,
    /\bhurry\b/i, /\bpathetic\b/i, /\bworthless\b/i,
  ];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI = /\bAI\b/;

  const samples = ['ally', 'hype', 'unknown'].flatMap((persona) =>
    [undefined, 5, 60].map((minutes) => snoozeConfirmCopy({ persona, minutes })));

  it('are non-empty strings that name the interval', () => {
    for (const s of samples) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
      expect(s).toMatch(/\d+\s*minute/);
    }
  });
  it('never shame (incl. "don\'t forget" / "hurry")', () => {
    for (const s of samples) for (const p of SHAME) expect(p.test(s), `"${s}" matched ${p}`).toBe(false);
  });
  it('never say "AI" and never make a clinical claim', () => {
    for (const s of samples) {
      expect(AI.test(s), `"AI" leaked: "${s}"`).toBe(false);
      for (const p of CLINICAL) expect(p.test(s), `clinical: "${s}" matched ${p}`).toBe(false);
    }
  });
});
