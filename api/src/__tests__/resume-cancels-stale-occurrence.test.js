/**
 * FocusBro — resume neutralises a pre-pause occurrence (Contender #10, Phase A).
 *
 * The bug this locks down: pause deliberately cancels only the *waiting*
 * substates (`pending` / `deferred` / `awaiting_time`) and leaves a DELIVERED-
 * but-unanswered `sent` nudge live. That is safe *while paused* — every active-
 * scoped surface (the escalation cron `c.status='sent' AND m.status='active'`,
 * the /me/ + coach next-check-in `MIN(scheduled_for)` over the open set) filters
 * on the commitment being 'active', so a paused word's stray `sent` row is inert.
 *
 * Resume flips the word back to 'active'. Before this fix that re-armed the same
 * stray row:
 *   - the escalation ladder would text a "still here about <word>" nudge chasing
 *     a moment from BEFORE the break — the exact design-LAW brush the edit path
 *     (R-310) already guards against, and the precise thing pause promised would
 *     stop ("the bro stops ringing"),
 *   - the pre-pause occurrence lingered beside the freshly-queued one as a
 *     DUPLICATE open occurrence, so the /me/ card's MIN(scheduled_for) surfaced
 *     the OLD moment the person had already stepped away from.
 *
 * Resume's contract is "pick up cleanly from now, never a backlog of the days
 * away", so the pre-pause occurrence is superseded and cancelled — anti-shame by
 * construction (`cancelled` is inert; the streak is never read or written by a
 * resume; no miss is recorded).
 *
 * This suite drives the REAL pause + resume routes and the REAL escalation cron
 * over a stateful in-memory D1 double that stores rows, so the cross-handler
 * interaction is exercised end-to-end rather than asserted against canned rows.
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'itty-router';
import { registerAccountabilityRoutes } from '../accountability.js';
import { runEscalations } from '../checkins-cron.js';
import { generateUUID } from '../middleware.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const ctx = {
  getAuthToken: (r) => {
    const h = r.headers.get('Authorization');
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (t) => (t === 'good' ? { sub: 'u1' } : null),
  jsonResponse,
  generateUUID,
};

// Stateful in-memory D1 double: holds one commitment + an array of
// commitment_checkins rows, and interprets exactly the statements the pause,
// resume, and escalation-scan paths issue. Every mutation is applied to the
// stored rows so a later query sees the real, current state.
function makeStore({ commitment, checkins }) {
  const state = { commitment, checkins };
  function prepare(sql) {
    let params = [];
    const stmt = {
      bind(...a) { params = a; return stmt; },
      async first() {
        if (/FROM commitments WHERE id = \? AND user_id = \?/.test(sql)) return state.commitment;
        if (/FROM commitment_checkins/.test(sql) && /status = 'pending' AND scheduled_for > \?/.test(sql)) {
          const after = params[1];
          return state.checkins.find((c) => c.status === 'pending' && c.scheduled_for > after) || null;
        }
        return null;
      },
      async all() {
        // The escalation scan: sent + push + unanswered + un-escalated +
        // delivered before the cutoff, on a commitment that is 'active'.
        if (/escalated_at IS NULL/.test(sql) && /FROM commitment_checkins c/.test(sql)) {
          const cutoff = params[0];
          const rows = state.checkins.filter((c) =>
            c.status === 'sent' && c.channel === 'push' &&
            c.responded_at == null && c.escalated_at == null &&
            c.delivered_at != null && c.delivered_at <= cutoff &&
            state.commitment.status === 'active');
          return {
            results: rows.map((c) => ({
              checkin_id: c.id, commitment_id: c.commitment_id, user_id: c.user_id,
              delivered_at: c.delivered_at, title: 'start the taxes', persona: 'ally',
              // ceiling 'none' = the person set their ladder to just-the-nudge, so
              // the cron latches without a text — keeps this test off the network
              // while still proving the row was SCANNED (the ladder woke for it).
              ceiling: 'none',
            })),
          };
        }
        return { results: [] };
      },
      async run() {
        if (/UPDATE commitments SET status = 'paused'/.test(sql)) state.commitment.status = 'paused';
        if (/UPDATE commitments SET status = 'active'/.test(sql)) state.commitment.status = 'active';
        // pause: cancel only the waiting substates (sent survives).
        if (/UPDATE commitment_checkins SET status = 'cancelled'/.test(sql)
            && /status IN \('pending', 'deferred', 'awaiting_time'\)/.test(sql)) {
          for (const c of state.checkins) {
            if (['pending', 'deferred', 'awaiting_time'].includes(c.status)) { c.status = 'cancelled'; c.responded_at = 'now'; }
          }
        }
        // resume/edit: cancel the wider set (sent included).
        if (/UPDATE commitment_checkins SET status = 'cancelled'/.test(sql)
            && /status IN \('pending', 'sent', 'deferred', 'awaiting_time'\)/.test(sql)) {
          for (const c of state.checkins) {
            if (['pending', 'sent', 'deferred', 'awaiting_time'].includes(c.status)) { c.status = 'cancelled'; c.responded_at = 'now'; }
          }
        }
        if (/INSERT INTO commitment_checkins/.test(sql)) {
          state.checkins.push({
            id: params[0], commitment_id: params[1], user_id: params[2],
            scheduled_for: params[3], channel: params[4], status: 'pending',
            responded_at: null, escalated_at: null, delivered_at: null,
          });
        }
        if (/UPDATE commitment_checkins SET escalated_at = \?/.test(sql)) {
          const row = state.checkins.find((c) => c.id === params[1]);
          if (row) row.escalated_at = params[0];
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  return { DB: { prepare }, state };
}

function buildCall(env) {
  const router = Router();
  registerAccountabilityRoutes(router, ctx);
  return (method, path) => router.handle(
    new Request('https://x' + path, { method, headers: { Authorization: 'Bearer good' } }),
    env,
  );
}

const recurring = () => ({
  id: 'cm1', user_id: 'u1', persona: 'ally', channel: 'push',
  recurrence: 'daily', timezone: 'UTC', local_time: '08:40', status: 'active',
});
const sentNudge = () => ({
  id: 'ci-old', commitment_id: 'cm1', user_id: 'u1',
  scheduled_for: '2026-08-01T08:40:00.000Z', channel: 'push', status: 'sent',
  responded_at: null, escalated_at: null, delivered_at: '2026-08-01T08:40:05.000Z',
});

const openOccurrences = (checkins) =>
  checkins.filter((c) => ['sent', 'pending', 'awaiting_time'].includes(c.status) && c.responded_at == null);

describe('resume neutralises a pre-pause occurrence', () => {
  it('leaves exactly one open occurrence — the fresh one — after pause→resume', async () => {
    const store = makeStore({ commitment: recurring(), checkins: [sentNudge()] });
    const env = { DB: store.DB, JWT_SECRET: 'test' };
    const call = buildCall(env);

    await call('POST', '/api/commitments/cm1/pause');
    // pause leaves the delivered nudge live (only the waiting substates cancel).
    expect(store.state.checkins.find((c) => c.id === 'ci-old').status).toBe('sent');

    const res = await call('POST', '/api/commitments/cm1/resume');
    expect(res.status).toBe(200);

    // The stale pre-pause nudge is superseded, and one fresh occurrence remains.
    expect(store.state.checkins.find((c) => c.id === 'ci-old').status).toBe('cancelled');
    const open = openOccurrences(store.state.checkins);
    expect(open.length).toBe(1);
    expect(open[0].id).not.toBe('ci-old');
  });

  it('the escalation ladder never chases a pre-pause moment after resume', async () => {
    const store = makeStore({ commitment: recurring(), checkins: [sentNudge()] });
    const env = { DB: store.DB, JWT_SECRET: 'test' };
    const call = buildCall(env);

    await call('POST', '/api/commitments/cm1/pause');
    await call('POST', '/api/commitments/cm1/resume');

    // A day later the real escalation cron runs: it must find nothing to chase —
    // the pre-pause nudge was superseded, not re-armed.
    const esc = await runEscalations(env, { now: '2026-08-02T09:00:00.000Z' });
    expect(esc.scanned).toBe(0);
    expect(esc.escalated).toBe(0);
  });

  it('NEVER touches the kept-word streak — a resume is not a resolution', async () => {
    const store = makeStore({ commitment: { ...recurring(), status: 'paused' }, checkins: [sentNudge()] });
    // capture every statement to prove the streak table is never written
    const seen = [];
    const wrapped = { DB: { prepare: (sql) => { seen.push(sql); return store.DB.prepare(sql); } }, JWT_SECRET: 'test' };
    const call = buildCall(wrapped);
    const res = await call('POST', '/api/commitments/cm1/resume');
    expect(res.status).toBe(200);
    expect(seen.some((s) => /accountability_streaks/.test(s))).toBe(false);
  });

  it('a resume with no leftover nudge still queues exactly one fresh occurrence', async () => {
    // Regression guard: the cancel must not disturb the clean path.
    const store = makeStore({ commitment: { ...recurring(), status: 'paused' }, checkins: [] });
    const env = { DB: store.DB, JWT_SECRET: 'test' };
    const res = await buildCall(env)('POST', '/api/commitments/cm1/resume');
    expect(res.status).toBe(200);
    const open = openOccurrences(store.state.checkins);
    expect(open.length).toBe(1);
    expect(open[0].status).toBe('pending');
  });
});
