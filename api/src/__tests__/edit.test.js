/**
 * FocusBro — edit a commitment in place (Contender #10, Phase A).
 *
 * A small change — a reworded title, a nudged time, "make this daily" — must
 * never cost the streak, which is exactly what happens when the only way to
 * change a word is to set it down and give a fresh one. Editing keeps the same
 * commitment:
 *   - only an OPEN word can be edited (active or paused); a wrapped-up word
 *     (kept / moved / set down) is warmly refused (409) with a fresh-word nudge,
 *   - the kept-word streak is NEVER read or written — an edit is not a resolution,
 *   - when the schedule moves, the outstanding check-in is cancelled and, for a
 *     still-active word, a fresh one is queued at the new time; a paused rhythm
 *     is left quiet (resume schedules it from now),
 *   - a title-only / persona-only edit does NOT re-queue anything.
 *
 * Drives the real route through itty-router with an in-memory D1 double, plus
 * unit tests on the pure builder and the design-LAW scan on the confirm copy.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerAccountabilityRoutes,
  buildCommitmentEdit,
  editConfirmCopy,
} from '../accountability.js';
import { generateUUID } from '../middleware.js';

// ── router harness (mirrors pause-resume.test.js) ────────────
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
  return (method, path, { token = 'good', body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const req = new Request('https://x' + path, init);
    return router.handle(req, env);
  };
}

const recurringActive = {
  id: 'cm1', title: 'start the taxes', details: '', start_at: '2026-07-11T08:40:00.000Z',
  checkin_at: '2026-07-11T08:40:00.000Z', channel: 'push', persona: 'ally', timezone: 'UTC',
  recurrence: 'daily', local_time: '08:40', status: 'active',
};
const recurringPaused = { ...recurringActive, status: 'paused' };
const oneShotActive = {
  id: 'cm2', title: 'call the dentist', details: '', start_at: '2026-07-11T14:00:00.000Z',
  checkin_at: '2026-07-11T15:00:00.000Z', channel: 'push', persona: 'ally', timezone: 'UTC',
  recurrence: 'none', local_time: null, status: 'active',
};

function updatedCommitment(runs) {
  return runs.find((x) => /UPDATE commitments\s+SET title = \?/.test(x.sql));
}

// ── ROUTE ────────────────────────────────────────────────────
describe('POST /api/commitments/:id/edit — change a word in place', () => {
  it('edits the title with no schedule change: updates the word, re-queues nothing', async () => {
    const db = makeDB({ commitment: recurringActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/edit', { body: { title: 'file the taxes' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commitment.title).toBe('file the taxes');
    expect(body.commitment.status).toBe('active'); // status preserved
    // The word was updated…
    expect(updatedCommitment(db.runs)).toBeTruthy();
    // …but nothing scheduling-related moved.
    expect(db.runs.some((x) => /UPDATE commitment_checkins SET status = 'cancelled'/.test(x.sql))).toBe(false);
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('editing the time re-queues the check-in: cancels the old, inserts a fresh one', async () => {
    const db = makeDB({ commitment: recurringActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/edit', {
      body: { recurrence: 'daily', local_time: '09:15', timezone: 'UTC' },
    });
    expect(res.status).toBe(200);
    // Old waiting check-ins cancelled…
    expect(db.runs.some((x) =>
      /UPDATE commitment_checkins SET status = 'cancelled'/.test(x.sql) &&
      /status IN \('pending', 'deferred', 'awaiting_time'\)/.test(x.sql))).toBe(true);
    // …and a fresh pending one queued (active word).
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql) && /'pending'/.test(x.sql))).toBe(true);
    const body = await res.json();
    expect(body.message).toMatch(/Next check-in/);
  });

  it('a paused word can be edited but stays quiet — cancel, no re-queue', async () => {
    const db = makeDB({ commitment: recurringPaused });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/edit', {
      body: { recurrence: 'weekdays', local_time: '07:30' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commitment.status).toBe('paused'); // still paused
    // Waiting check-ins cancelled…
    expect(db.runs.some((x) => /UPDATE commitment_checkins SET status = 'cancelled'/.test(x.sql))).toBe(true);
    // …but NOTHING new is scheduled while paused (resume does that).
    expect(db.runs.some((x) => /INSERT INTO commitment_checkins/.test(x.sql))).toBe(false);
  });

  it('NEVER touches the kept-word streak — an edit is not a resolution', async () => {
    const db = makeDB({ commitment: recurringActive });
    await buildRouter(db)('POST', '/api/commitments/cm1/edit', { body: { title: 'x', local_time: '10:00', recurrence: 'daily' } });
    expect(db.runs.some((x) => /accountability_streaks/.test(x.sql))).toBe(false);
  });

  it('409s a wrapped-up word (kept) and mutates nothing', async () => {
    const db = makeDB({ commitment: { ...recurringActive, status: 'kept' } });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/edit', { body: { title: 'nope' } });
    expect(res.status).toBe(409);
    expect(db.runs.length).toBe(0);
  });

  it('400s an empty title (a word still needs a name), mutating nothing', async () => {
    const db = makeDB({ commitment: recurringActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/edit', { body: { title: '   ' } });
    expect(res.status).toBe(400);
    expect(db.runs.some((x) => /UPDATE commitments/.test(x.sql))).toBe(false);
  });

  it('400s an edit that changes nothing', async () => {
    const db = makeDB({ commitment: recurringActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/edit', { body: {} });
    expect(res.status).toBe(400);
    expect(db.runs.some((x) => /UPDATE commitments/.test(x.sql))).toBe(false);
  });

  it('404s a commitment the user does not own (no leak, no write)', async () => {
    const db = makeDB({ commitment: null });
    const res = await buildRouter(db)('POST', '/api/commitments/nope/edit', { body: { title: 'x' } });
    expect(res.status).toBe(404);
    expect(db.runs.length).toBe(0);
  });

  it('401s without a valid token', async () => {
    const db = makeDB({ commitment: recurringActive });
    const res = await buildRouter(db)('POST', '/api/commitments/cm1/edit', { token: 'bad', body: { title: 'x' } });
    expect(res.status).toBe(401);
    expect(db.runs.length).toBe(0);
  });
});

// ── PURE BUILDER ─────────────────────────────────────────────
describe('buildCommitmentEdit — merge the change over the existing word', () => {
  const now = '2026-07-11T06:00:00.000Z';

  it('carries over untouched fields and flags no schedule change on a title edit', () => {
    const r = buildCommitmentEdit(recurringActive, { title: 'file the taxes' }, now);
    expect(r.ok).toBe(true);
    expect(r.value.title).toBe('file the taxes');
    expect(r.value.recurrence).toBe('daily');
    expect(r.value.localTime).toBe('08:40'); // unchanged
    expect(r.scheduleChanged).toBe(false);
  });

  it('recomputes the next occurrence when the time-of-day changes', () => {
    const r = buildCommitmentEdit(recurringActive, { local_time: '09:15' }, now);
    expect(r.ok).toBe(true);
    expect(r.scheduleChanged).toBe(true);
    expect(r.value.localTime).toBe('09:15');
    expect(r.value.startAt).toBe(r.value.checkinAt); // the recurring check-in IS the moment
    expect(Date.parse(r.value.startAt)).toBeGreaterThan(Date.parse(now));
  });

  it('turning a one-shot into a rhythm keeps the same time of day when none is given', () => {
    // oneShotActive starts 14:00 UTC → "make it daily" should anchor to 14:00.
    const r = buildCommitmentEdit(oneShotActive, { recurrence: 'daily' }, now);
    expect(r.ok).toBe(true);
    expect(r.scheduleChanged).toBe(true);
    expect(r.value.recurrence).toBe('daily');
    expect(r.value.localTime).toBe('14:00');
  });

  it('turning a rhythm into a one-shot clears the local-time anchor', () => {
    const r = buildCommitmentEdit(recurringActive, { recurrence: 'none', start_at: '2026-07-12T10:00:00.000Z' }, now);
    expect(r.ok).toBe(true);
    expect(r.value.recurrence).toBe('none');
    expect(r.value.localTime).toBe('');
    expect(r.value.startAt).toBe('2026-07-12T10:00:00.000Z');
  });

  it('rejects an empty title and a no-op edit', () => {
    expect(buildCommitmentEdit(recurringActive, { title: '  ' }, now).ok).toBe(false);
    expect(buildCommitmentEdit(recurringActive, {}, now).ok).toBe(false);
    expect(buildCommitmentEdit(recurringActive, null, now).ok).toBe(false);
    expect(buildCommitmentEdit(null, { title: 'x' }, now).ok).toBe(false);
  });

  it('refuses a voice channel (Phase B) and an unknown channel', () => {
    expect(buildCommitmentEdit(recurringActive, { channel: 'voice' }, now).ok).toBe(false);
    expect(buildCommitmentEdit(recurringActive, { channel: 'carrier-pigeon' }, now).ok).toBe(false);
  });
});

// ── the design LAW on the edit copy ──────────────────────────
describe('edit copy — adjusting a plan is never a step back', () => {
  const SHAME = [
    /\bfail(ed|ure|ing|s)?\b/i, /\blaz(y|iness)\b/i, /\bdisappoint/i, /\bguilt/i,
    /\bashamed\b/i, /\bshame\b/i, /\bquit(ter|ting)?\b/i, /\bgave up\b/i, /\bgiving up\b/i,
    /\bmiss(ed|ing|es)?\b/i, /\bbehind\b/i, /\byou (didn.?t|should have|should.?ve)\b/i,
    /\bexcuse/i, /\bcatch(ing)? up\b/i, /\bmake up for\b/i, /\bhurry\b/i, /\bpathetic\b/i,
  ];
  const CLINICAL = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI = /\bAI\b/;

  const samples = ['ally', 'hype', 'unknown'].flatMap((persona) => [
    editConfirmCopy({ persona, scheduleChanged: true, when: '2026-07-12T09:15:00Z' }),
    editConfirmCopy({ persona, scheduleChanged: false }),
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
  it('reassures the streak is intact', () => {
    for (const s of samples) expect(s).toMatch(/streak/i);
  });
  it('names the next check-in only when the schedule moved', () => {
    expect(editConfirmCopy({ persona: 'ally', scheduleChanged: true, when: '2026-07-12T09:15:00Z' })).toMatch(/Next check-in/);
    expect(editConfirmCopy({ persona: 'ally', scheduleChanged: false })).not.toMatch(/Next check-in/);
  });
});
