/**
 * FocusBro — a snooze re-arms the CURRENT check-in occurrence, never a
 * freshly-materialized future one (Contender #10, Phase A, R-287).
 *
 * The bug this pins is the R-284 defect one seam over — on the SNOOZE path
 * instead of the resolve path. For a recurring word the delivery cron marks
 * today's check-in `sent` and immediately materializes tomorrow's as `pending`
 * (checkins-cron.js). So the moment a person answers "I'm on it, gimme 20" —
 * whether through the `/api/commitments/:id/snooze` endpoint or the in-app
 * "Move it → I'm on it" branch of `/checkin` — TWO open rows exist: today's
 * delivered `sent` row and tomorrow's `pending` row.
 *
 * Both snooze surfaces selected the row to re-arm with `ORDER BY scheduled_for
 * DESC LIMIT 1` — the LATEST occurrence — so a snooze moved TOMORROW's
 * not-yet-due check-in forward into today (minutes out) and left today's
 * `sent` row untouched and unanswered. Two failures, both against the one
 * design LAW:
 *   1. tomorrow's check-in now fires today, out of rhythm, and
 *   2. today's orphaned `sent` row rides the escalation ladder into a false
 *      "still here about <word>" nudge for a task the person is ACTIVELY doing.
 *
 * The fix orders by `scheduled_for ASC` — the SAME soonest-open occurrence the
 * /me/ card surfaces (MIN(scheduled_for)) and the resolve path already targets
 * (R-284) — so the snooze re-arms the occurrence the person is acting on and
 * leaves the future one to fire on its own day.
 *
 * The DB double is order-faithful: it reads the ORDER BY out of the actual
 * re-arm SELECT and picks the row exactly as SQLite would, so reverting the
 * source to `DESC` flips which row is snoozed and these tests fail
 * (proof-of-rejection, Factory Standing Law 1).
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

const RECURRING = {
  id: 'cm1', title: 'take meds', persona: 'ally', channel: 'push',
  timezone: 'America/New_York', recurrence: 'daily', local_time: '09:00', status: 'active',
};

// An order-faithful in-memory D1 double over a set of commitment_checkins rows.
// The snooze re-arm SELECT embeds `ORDER BY scheduled_for ASC|DESC`; this picks
// the row exactly as SQLite would for whichever ordering the source carries, so
// the same test passes on the fix (ASC) and fails on a revert (DESC).
function makeDB(rows) {
  const runs = [];
  const prepared = [];
  const OPEN = new Set(['pending', 'sent', 'deferred', 'awaiting_time']);
  function selectRearmTarget(sql, commitmentId) {
    let pool = rows.filter((r) => r.commitment_id === commitmentId && OPEN.has(r.status));
    if (/ORDER BY scheduled_for ASC/.test(sql)) {
      pool = pool.slice().sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
    } else {
      // old (buggy): latest scheduled_for first
      pool = pool.slice().sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for));
    }
    return pool[0] || null;
  }
  const db = {
    runs,
    prepared,
    rows,
    prepare(sql) {
      prepared.push(sql);
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return RECURRING;
          // The snooze re-arm target select.
          if (/SELECT id FROM commitment_checkins/.test(sql)
              && /status IN \('pending', 'sent', 'deferred', 'awaiting_time'\)/.test(sql)) {
            return selectRearmTarget(sql, params[0]);
          }
          return null; // streaks / anything else → defaults
        },
        async all() { return { results: [] }; },
        async run() {
          runs.push({ sql, params });
          // The re-arm UPDATE: move the selected row's scheduled_for + re-pend it.
          if (/UPDATE commitment_checkins/.test(sql)
              && /SET status = 'pending', scheduled_for = \?/.test(sql)) {
            const target = rows.find((r) => r.id === params[1]);
            if (target) {
              target.status = 'pending';
              target.scheduled_for = params[0];
              target.responded_at = null;
              target.rearmed = true;
            }
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

function buildCall(db) {
  const router = Router();
  registerAccountabilityRoutes(router, ctx);
  const env = { DB: db, JWT_SECRET: 'test' };
  return (method, path, { token = 'good', body } = {}) => {
    const headers = { Authorization: 'Bearer ' + token };
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return router.handle(new Request('https://x' + path, init), env);
  };
}

function twoOpenRows() {
  const now = Date.now();
  const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
    scheduled_for: new Date(now - 3 * 3600 * 1000).toISOString(), responded_at: null };
  const tomorrow = { id: 'ckB', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
    scheduled_for: new Date(now + 21 * 3600 * 1000).toISOString(), responded_at: null };
  return { today, tomorrow };
}

describe('/snooze endpoint re-arms the current occurrence, never a future one', () => {
  it('moves TODAY\'s delivered check-in and leaves TOMORROW\'s pending row untouched', async () => {
    const { today, tomorrow } = twoOpenRows();
    const tomorrowWhen = tomorrow.scheduled_for;
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/snooze', { body: { minutes: 20 } });
    expect(res.status).toBe(200);

    // Today's occurrence is the one moved forward (re-armed to ~20 min out)...
    expect(today.rearmed).toBe(true);
    expect(today.status).toBe('pending');
    expect(new Date(today.scheduled_for).getTime()).toBeGreaterThan(Date.now());
    // ...and tomorrow's not-yet-due check-in is left exactly where it was — never
    // dragged into today, never orphaning today's row into a false escalation.
    expect(tomorrow.rearmed).toBeUndefined();
    expect(tomorrow.status).toBe('pending');
    expect(tomorrow.scheduled_for).toBe(tomorrowWhen);
  });

  it('a one-shot with a single open row still re-arms it (no regression)', async () => {
    const now = Date.now();
    const only = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
      scheduled_for: new Date(now - 1 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([only]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/snooze', { body: { minutes: 30 } });
    expect(res.status).toBe(200);
    expect(only.rearmed).toBe(true);
    expect(only.status).toBe('pending');
  });

  it('SQL-shape lock: the re-arm select filters to the open set and orders scheduled_for ASC', async () => {
    const { today, tomorrow } = twoOpenRows();
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);
    await call('POST', '/api/commitments/cm1/snooze', { body: { minutes: 20 } });

    const rearmSelect = db.prepared.find((sql) => /SELECT id FROM commitment_checkins/.test(sql)
      && /status IN \('pending', 'sent', 'deferred', 'awaiting_time'\)/.test(sql));
    expect(rearmSelect).toBeTruthy();
    expect(rearmSelect).toMatch(/ORDER BY scheduled_for ASC/);
    // The old future-picking ordering is gone.
    expect(rearmSelect).not.toMatch(/ORDER BY scheduled_for DESC/);
    // And behaviorally the row moved is today's (soonest) — what ASC yields.
    const update = db.runs.find((x) => /UPDATE commitment_checkins/.test(x.sql)
      && /SET status = 'pending', scheduled_for = \?/.test(x.sql));
    expect(update).toBeTruthy();
    expect(update.params[1]).toBe('ckA');
  });
});

describe('in-app "I\'m on it" snooze re-arms the current occurrence, never a future one', () => {
  it('reads "on it, gimme 20" as a snooze and moves TODAY\'s row, not TOMORROW\'s', async () => {
    const { today, tomorrow } = twoOpenRows();
    const tomorrowWhen = tomorrow.scheduled_for;
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', {
      body: { outcome: 'reschedule', when_text: 'on it, gimme 20' },
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.action).toBe('snoozed');

    // Today's occurrence is the one snoozed forward...
    expect(today.rearmed).toBe(true);
    expect(today.status).toBe('pending');
    // ...tomorrow's is untouched.
    expect(tomorrow.rearmed).toBeUndefined();
    expect(tomorrow.status).toBe('pending');
    expect(tomorrow.scheduled_for).toBe(tomorrowWhen);
  });
});
