/**
 * FocusBro — in-app "Move it" reschedule shares ONE time parser with SMS
 * (Contender #10, Phase A).
 *
 * Before this, the in-app "Move it" made you type a rigid `2026-07-07 14:00`
 * while a text reply understood "in 30 min", "tomorrow 9am", "3pm". Two parsers,
 * two personalities — and the app was the colder, stricter one, which is exactly
 * the friction the anti-shame design LAW exists to kill. This suite drives the
 * real `/api/commitments/:id/checkin` reschedule route through itty-router with
 * an in-memory D1 double and pins the unification:
 *   - a natural-language `when_text` is parsed server-side by the SAME
 *     `parseWhenReply` the SMS channel uses, and creates the follow-up word,
 *   - an unreadable time is refused warmly (400, shared voice) and writes NOTHING
 *     — never assume a time, and never a miss,
 *   - an explicit ISO `new_start_at` still works (backward compatible),
 *   - the follow-up word carries the person's timezone, not a silent UTC.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import {
  registerAccountabilityRoutes,
  smsWhenUnclearCopy,
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

// In-memory D1 double: returns `commitment` for the ownership SELECT, null for
// the streak SELECT (defaults kick in), and records every run() so the test can
// assert exactly what was — and was NOT — written.
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
          // The still-open check-in the snooze path re-arms (null → fresh insert).
          if (/FROM commitment_checkins/.test(sql)) return openCheckin;
          return null; // accountability_streaks → defaults
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

// A one-shot active word in a real zone, so the reschedule is a fresh follow-up
// (no recurrence re-queue) and we can watch its INSERT.
const oneShot = {
  id: 'cm1', title: 'Start the taxes', persona: 'ally', channel: 'push',
  timezone: 'America/New_York', recurrence: 'none', local_time: '', status: 'active',
};

// The commitments INSERT: (id, user_id, title, details, start_at, checkin_at,
// channel, persona, timezone, status='active', rescheduled_from).
function insertedCommitment(runs) {
  const r = runs.find((x) => /INSERT INTO commitments\b/.test(x.sql));
  if (!r) return null;
  return { start_at: r.params[4], channel: r.params[6], timezone: r.params[8], rescheduled_from: r.params[9] };
}

describe('in-app reschedule shares parseWhenReply with the SMS channel', () => {
  it('reads a natural-language when_text and carries the word forward', async () => {
    const db = makeDB({ commitment: oneShot });
    const call = buildRouter(db);
    const before = Date.now();
    const res = await call('POST', '/api/commitments/cm1/checkin', {
      body: { outcome: 'reschedule', when_text: 'in 30 min' },
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.new_commitment).toBeTruthy();

    const ins = insertedCommitment(db.runs);
    expect(ins).toBeTruthy();
    // parseWhenReply ran server-side → a valid ISO ~30 min out (never past).
    const t = Date.parse(ins.start_at);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThan(before + 29 * 60 * 1000);
    expect(t).toBeLessThan(before + 31 * 60 * 1000);
    // The follow-up word keeps the person's zone, not a silent UTC.
    expect(ins.timezone).toBe('America/New_York');
    expect(ins.rescheduled_from).toBe('cm1');
  });

  it('understands the same warm forms the text channel does', async () => {
    for (const phrase of ['tomorrow 9am', '3pm', 'in 2 hours', 'tonight']) {
      const db = makeDB({ commitment: oneShot });
      const call = buildRouter(db);
      const res = await call('POST', '/api/commitments/cm1/checkin', {
        body: { outcome: 'reschedule', when_text: phrase },
      });
      expect(res.status, phrase).toBe(200);
      const ins = insertedCommitment(db.runs);
      expect(Number.isNaN(Date.parse(ins.start_at)), phrase).toBe(false);
    }
  });

  it('refuses an unreadable time warmly and writes NOTHING (never assume, never a miss)', async () => {
    const db = makeDB({ commitment: oneShot });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/checkin', {
      body: { outcome: 'reschedule', when_text: 'zzz whenever i feel like it' },
    });
    expect(res.status).toBe(400);
    const b = await res.json();
    // Shared voice — the exact copy the SMS "when?" reply uses.
    expect(b.error).toBe(smsWhenUnclearCopy({ persona: 'ally' }));
    // No follow-up word was created from an unreadable time.
    expect(insertedCommitment(db.runs)).toBeNull();
  });

  // Two-way parity with SMS (PR #130): answering the in-app "Move it → when?"
  // prompt with "I'm on it" is a SNOOZE, not a reschedule — the engaged person,
  // mid-task, meets the same warmth the text channel gives, never the cold
  // "I couldn't read that time."
  it('honors "I\'m on it" while awaiting a reschedule time as a snooze (SMS parity)', async () => {
    const db = makeDB({ commitment: oneShot, openCheckin: { id: 'ck1' } });
    const call = buildRouter(db);
    const before = Date.now();
    const res = await call('POST', '/api/commitments/cm1/checkin', {
      body: { outcome: 'reschedule', when_text: 'actually I\'m on it, gimme a few' },
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.action).toBe('snoozed');
    // Re-pended ~SNOOZE_DEFAULT_MIN (15 min) out, never past.
    const t = Date.parse(b.snoozed_until);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThan(before + 14 * 60 * 1000);
    expect(t).toBeLessThan(before + 16 * 60 * 1000);
    // A snooze is not a resolution and not a miss: NO follow-up word is created,
    // the check-in is never marked 'reschedule', and the streak is never written.
    expect(insertedCommitment(db.runs)).toBeNull();
    expect(db.runs.some((x) => /UPDATE commitment_checkins[\s\S]*SET status = \?/.test(x.sql))).toBe(false);
    expect(db.runs.some((x) => /accountability_streaks/i.test(x.sql))).toBe(false);
    // The open check-in was re-pended, not resolved.
    expect(db.runs.some((x) => /SET status = 'pending', scheduled_for = \?, attempts = 0/.test(x.sql))).toBe(true);
  });

  it('a plain "later" answering "when?" is still a reschedule, never a wrong snooze', async () => {
    // detectCheckinReply runs RESCHEDULE before SNOOZE, so "later" never reads as
    // a snooze; parseWhenReply can't read a concrete time from it, so it gets the
    // warm shared re-ask (400) — the same behavior as before this change.
    const db = makeDB({ commitment: oneShot });
    const call = buildRouter(db);
    const res = await call('POST', '/api/commitments/cm1/checkin', {
      body: { outcome: 'reschedule', when_text: 'later' },
    });
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error).toBe(smsWhenUnclearCopy({ persona: 'ally' }));
    // Not a snooze: the check-in was never re-pended.
    expect(db.runs.some((x) => /SET status = 'pending', scheduled_for = \?, attempts = 0/.test(x.sql))).toBe(false);
  });

  it('still accepts an explicit ISO new_start_at (backward compatible)', async () => {
    const db = makeDB({ commitment: oneShot });
    const call = buildRouter(db);
    const iso = '2026-09-01T14:00:00.000Z';
    const res = await call('POST', '/api/commitments/cm1/checkin', {
      body: { outcome: 'reschedule', new_start_at: iso },
    });
    expect(res.status).toBe(200);
    const ins = insertedCommitment(db.runs);
    expect(Date.parse(ins.start_at)).toBe(Date.parse(iso));
  });
});
