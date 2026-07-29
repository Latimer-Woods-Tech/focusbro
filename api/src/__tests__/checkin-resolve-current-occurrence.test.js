/**
 * FocusBro — an in-app resolve lands on the CURRENT occurrence, never a
 * freshly-materialized future one (Contender #10, Phase A).
 *
 * The bug this pins: for a recurring word, the delivery cron marks today's
 * check-in `sent` and immediately materializes tomorrow's as `pending`
 * (checkins-cron.js). So at the moment a person taps "I did it" on /me/, TWO
 * check-in rows exist — today's delivered `sent` row and tomorrow's `pending`
 * row. The resolve route's old ordering (`(status='pending') DESC,
 * scheduled_for DESC`) picked TOMORROW's not-yet-due row, stamped the
 * resolution on it, and left today's genuinely-completed check-in orphaned as
 * an unanswered `sent` row — so the /me/ card kept reading "still here whenever
 * you're ready" right after the person marked it done, and 15 min later the
 * escalation ladder texted a false "still here about <word>" nudge for a task
 * they had ALREADY completed. A shame-by-accident defect on the exact channel
 * that is supposed to celebrate the win.
 *
 * The fix orders by `scheduled_for ASC` over the open set — the SAME occurrence
 * the /me/ card surfaces as `next_checkin` (MIN(scheduled_for), accountability
 * `outstanding` query) — so resolve and card always agree, and the current
 * occurrence is the one that gets resolved.
 *
 * The DB double below is order-faithful: it reads the ORDER BY / status filter
 * out of the actual UPDATE SQL and selects the row exactly as SQLite would, so
 * reverting the source flips which row is stamped and these tests fail
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
// The resolve UPDATE embeds `SELECT id ... ORDER BY ...`; this reproduces both
// the fixed (`scheduled_for ASC` + open-status filter) and the old
// (`(status='pending') DESC, scheduled_for DESC`, no filter) shapes so the same
// test passes on the fix and fails on a revert.
function makeDB(rows) {
  const runs = [];
  const OPEN = new Set(['pending', 'sent', 'deferred']);
  function selectResolveTarget(sql, commitmentId) {
    let pool = rows.filter((r) => r.commitment_id === commitmentId);
    if (/status IN \('pending', 'sent', 'deferred'\)/.test(sql)) {
      pool = pool.filter((r) => OPEN.has(r.status));
    }
    if (/ORDER BY scheduled_for ASC/.test(sql)) {
      pool = pool.slice().sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
    } else {
      // old: pending-first, then scheduled_for DESC
      pool = pool.slice().sort((a, b) => {
        const ap = a.status === 'pending' ? 1 : 0;
        const bp = b.status === 'pending' ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return b.scheduled_for.localeCompare(a.scheduled_for);
      });
    }
    return pool[0] || null;
  }
  const db = {
    runs,
    rows,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() {
          if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return RECURRING;
          // ensureNextOccurrence: an existing future pending row → no insert.
          if (/status = 'pending' AND scheduled_for > \?/.test(sql)) {
            return rows.find((r) => r.status === 'pending' && r.scheduled_for > params[1]) || null;
          }
          return null; // accountability_streaks → defaults
        },
        async all() { return { results: [] }; },
        async run() {
          runs.push({ sql, params });
          // The resolve UPDATE: stamp the selected occurrence, faithfully.
          if (/UPDATE commitment_checkins[\s\S]*SET status = \?, responded_at/.test(sql)
              && /SELECT id FROM commitment_checkins/.test(sql)) {
            const target = selectResolveTarget(sql, params[4]);
            if (target) { target.status = params[0]; target.responded_at = 'now'; target.resolved = true; }
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

describe('in-app resolve targets the current occurrence, never a future one', () => {
  it('stamps TODAY\'s delivered check-in kept and leaves TOMORROW\'s pending row untouched', async () => {
    const now = Date.now();
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
      scheduled_for: new Date(now - 3 * 3600 * 1000).toISOString(), responded_at: null };
    const tomorrow = { id: 'ckB', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: new Date(now + 21 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);

    // The occurrence the person actually completed is the one credited...
    expect(today.status).toBe('kept');
    expect(today.responded_at).not.toBeNull();
    // ...and tomorrow's not-yet-due check-in is left alone to fire tomorrow —
    // never pre-resolved, never orphaning today's into a false escalation.
    expect(tomorrow.status).toBe('pending');
    expect(tomorrow.responded_at).toBeNull();
  });

  it('a miss also resolves today\'s occurrence, not tomorrow\'s', async () => {
    const now = Date.now();
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
      scheduled_for: new Date(now - 2 * 3600 * 1000).toISOString(), responded_at: null };
    const tomorrow = { id: 'ckB', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: new Date(now + 22 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([today, tomorrow]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'missed' } });
    expect(res.status).toBe(200);
    expect(today.status).toBe('missed');
    expect(tomorrow.status).toBe('pending');
  });

  it('an early resolve BEFORE any delivery still lands on the single pending row (no regression)', async () => {
    const now = Date.now();
    const onlyPending = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'pending',
      scheduled_for: new Date(now + 2 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([onlyPending]);
    const call = buildCall(db);

    const res = await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });
    expect(res.status).toBe(200);
    expect(onlyPending.status).toBe('kept');
  });

  it('SQL-shape lock: the resolve subquery filters to the open set and orders scheduled_for ASC', async () => {
    const now = Date.now();
    const today = { id: 'ckA', commitment_id: 'cm1', user_id: 'u1', status: 'sent',
      scheduled_for: new Date(now - 1 * 3600 * 1000).toISOString(), responded_at: null };
    const db = makeDB([today]);
    const call = buildCall(db);
    await call('POST', '/api/commitments/cm1/checkin', { body: { outcome: 'kept' } });

    const resolve = db.runs.find((x) => /UPDATE commitment_checkins[\s\S]*SET status = \?, responded_at/.test(x.sql)
      && /SELECT id FROM commitment_checkins/.test(x.sql));
    expect(resolve).toBeTruthy();
    expect(resolve.sql).toMatch(/status IN \('pending', 'sent', 'deferred'\)/);
    expect(resolve.sql).toMatch(/ORDER BY scheduled_for ASC/);
    // The old future-picking ordering is gone.
    expect(resolve.sql).not.toMatch(/\(status = 'pending'\) DESC/);
  });
});
