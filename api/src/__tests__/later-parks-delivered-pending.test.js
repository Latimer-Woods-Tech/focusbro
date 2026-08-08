/**
 * FocusBro — "later" parks a delivered-then-re-pended check-in too
 * (Contender #10, Phase A).
 *
 * The bug this locks down: the inbound-SMS open-check-in lookup matches THREE
 * open substates — a freshly-delivered nudge (`status='sent'`), a mid-"when?"
 * row (`status='awaiting_time'`), and a DELIVERED-then-re-pended one
 * (`status='pending'` with `delivered_at` set — what a "help me start" or a
 * snooze leaves behind). But the "later"→ask-when transition guarded on
 * `AND status = 'sent'`, so a "later" reply to a delivered-'pending' row matched
 * ZERO rows:
 *   - the promised holding state never took effect — the row stayed 'pending' at
 *     its near-future scheduled_for, so `runDueCheckins` would re-deliver the
 *     "You said you'd do X. Ready?" nudge minutes later, nagging the person on the
 *     exact moment they just deferred (a design-LAW brush — the guilt-engine the
 *     LAW forbids);
 *   - the "when do you want to try again?" conversation the bro just opened had no
 *     `awaiting_time` anchor behind it.
 *
 * Same shape as R-308: a write path whose status set omitted a valid open
 * substate. The fix targets the SPECIFIC open row we already resolved, guarded on
 * `responded_at IS NULL`, so a "later" parks the check-in into 'awaiting_time'
 * whether it was fresh-sent or delivered-then-re-pended.
 *
 * PROOF-OF-REJECTION: the stateful D1 double honors whichever WHERE guard the SQL
 * actually carries. Under the old `AND status = 'sent'` guard the delivered-
 * 'pending' row is NOT parked (assertions fail); under the corrected
 * `responded_at IS NULL` guard it is (assertions pass). No status-set assertion —
 * the double models the real semantics, so the test can't pass by SQL-string luck.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from 'itty-router';
import { registerConsentRoutes } from '../consent.js';
import { generateUUID } from '../middleware.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const TELNYX_ENV = {
  TELNYX_API_KEY: 'k',
  TELNYX_FROM_NUMBER: '+15550001111',
  TELNYX_PUBLIC_KEY: 'test-public-key',
};

// Stateful in-memory D1 double: holds one commitment + its commitment_checkins
// rows, and interprets exactly the statements the inbound "later" / "help me
// start" paths issue. The load-bearing part is `run()` for the two check-in
// UPDATEs — it evaluates the WHERE predicates AS WRITTEN in the SQL string it
// receives, so the SAME test faithfully models both the buggy `status = 'sent'`
// guard and the corrected `responded_at IS NULL` one.
function makeStore({ commitment, checkins }) {
  const state = { commitment, checkins };
  function prepare(sql) {
    let params = [];
    const stmt = {
      bind(...a) { params = a; return stmt; },
      async first() {
        if (/FROM users WHERE phone/.test(sql)) return { id: 'u1' };
        // The inbound open-check-in lookup: text, unanswered, active parent, in one
        // of the three open substates (sent / awaiting_time / delivered-pending).
        if (/FROM commitment_checkins c\s+JOIN commitments m/.test(sql)) {
          if (state.commitment.status !== 'active') return null;
          const row = state.checkins.find((c) =>
            c.channel === 'text' && c.responded_at == null &&
            (['sent', 'awaiting_time'].includes(c.status) ||
              (c.status === 'pending' && c.delivered_at != null)));
          if (!row) return null;
          return {
            checkin_id: row.id,
            commitment_id: row.commitment_id,
            checkin_status: row.status,
            recurrence: state.commitment.recurrence,
            timezone: state.commitment.timezone,
            local_time: state.commitment.local_time,
            channel: state.commitment.channel,
            persona: state.commitment.persona,
          };
        }
        return null;
      },
      async all() { return { results: [] }; },
      async run() {
        // webhook_inbox intake: first insert "changes" (not a duplicate).
        if (/INSERT INTO webhook_inbox/.test(sql)) return { success: true, meta: { changes: 1 } };
        // A "help me start" / snooze / reschedule re-pend: set the row 'pending' at
        // a new time, reset attempts, clear responded_at — delivered_at UNTOUCHED
        // (so it stays the delivered-then-re-pended substate the bug missed).
        if (/UPDATE commitment_checkins\s+SET status = 'pending', scheduled_for/.test(sql)) {
          const row = state.checkins.find((c) => c.id === params[1]);
          if (row) { row.status = 'pending'; row.scheduled_for = params[0]; row.attempts = 0; row.responded_at = null; }
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        // The transition under test — apply ONLY if the row satisfies the WHERE
        // predicates present in THIS sql (models buggy vs. fixed guard faithfully).
        if (/UPDATE commitment_checkins SET status = 'awaiting_time'/.test(sql)) {
          const row = state.checkins.find((c) => c.id === params[0]);
          let changes = 0;
          if (row) {
            const needSent = /status = 'sent'/.test(sql);
            const needUnanswered = /responded_at IS NULL/.test(sql);
            const ok = (!needSent || row.status === 'sent') &&
                       (!needUnanswered || row.responded_at == null);
            if (ok) { row.status = 'awaiting_time'; changes = 1; }
          }
          return { success: true, meta: { changes } };
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  return { DB: { prepare }, state };
}

function buildRouter() {
  const router = Router();
  registerConsentRoutes(router, {
    getAuthToken: () => null,
    verifyToken: async () => null,
    jsonResponse,
    generateUUID,
    verifyInboundSignature: async () => true,
  });
  return router;
}

function inbound(text, from = '+15551234567', eventId = 'evt-1') {
  return new Request('https://focusbro.net/api/webhooks/telnyx/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'telnyx-timestamp': '1785000000',
      'telnyx-signature-ed25519': 'test-signature',
    },
    body: JSON.stringify({ data: { id: eventId, event_type: 'message.received', payload: { from: { phone_number: from }, text } } }),
  });
}

const oneShotText = () => ({
  id: 'cm1', user_id: 'u1', status: 'active',
  recurrence: 'none', timezone: 'UTC', local_time: null, channel: 'text', persona: 'ally',
});

// A DELIVERED-then-re-pended text check-in: status='pending' with delivered_at
// set (exactly what "help me start" and snooze leave behind). This is the open
// substate the old `AND status = 'sent'` guard could not park.
const deliveredPending = () => ({
  id: 'ci1', commitment_id: 'cm1', user_id: 'u1', channel: 'text',
  status: 'pending', scheduled_for: '2026-08-08T14:02:00.000Z',
  responded_at: null, escalated_at: null, delivered_at: '2026-08-08T14:00:05.000Z',
});

describe('"later" parks a delivered-then-re-pended check-in into awaiting_time', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a "later" reply to a delivered-pending row is parked (not left cron-eligible)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const store = makeStore({ commitment: oneShotText(), checkins: [deliveredPending()] });

    const res = await buildRouter().handle(inbound('later'), { ...TELNYX_ENV, DB: store.DB });
    expect((await res.json()).action).toBe('reschedule_ask_when');

    const row = store.state.checkins.find((c) => c.id === 'ci1');
    // The check-in is HELD awaiting a time — the promised no-shame conversation
    // has a real anchor, and it's no longer a 'pending' row `runDueCheckins`
    // (which scans status='pending') would re-deliver on the just-deferred moment.
    expect(row.status).toBe('awaiting_time');
    // Never resolved, never a miss — the parent word is untouched.
    expect(store.state.commitment.status).toBe('active');
  });

  it('end-to-end: real "help me start" → "later" parks the check-in it created', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    // Start from a freshly-delivered text nudge.
    const sentNudge = {
      id: 'ci1', commitment_id: 'cm1', user_id: 'u1', channel: 'text',
      status: 'sent', scheduled_for: '2026-08-08T14:00:00.000Z',
      responded_at: null, escalated_at: null, delivered_at: '2026-08-08T14:00:05.000Z',
    };
    const store = makeStore({ commitment: oneShotText(), checkins: [sentNudge] });
    const env = { ...TELNYX_ENV, DB: store.DB };

    // Real "help me start" re-pends the check-in a couple minutes out — it stays
    // status='pending' with delivered_at intact (the substate the bug missed).
    const help = await buildRouter().handle(inbound('help me start', '+15551234567', 'evt-help'), env);
    expect((await help.json()).action).toBe('start_help');
    expect(store.state.checkins.find((c) => c.id === 'ci1').status).toBe('pending');
    expect(store.state.checkins.find((c) => c.id === 'ci1').delivered_at).toBeTruthy();

    // Then the person realizes they can't right now and texts "later".
    const later = await buildRouter().handle(inbound('later', '+15551234567', 'evt-later'), env);
    expect((await later.json()).action).toBe('reschedule_ask_when');

    // The word is now genuinely held for the "when?" answer — the bro will not
    // re-ring the moment it just deferred.
    expect(store.state.checkins.find((c) => c.id === 'ci1').status).toBe('awaiting_time');
  });

  it('regression: a fresh "sent" nudge still parks on "later" (unchanged behavior)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const sentNudge = {
      id: 'ci1', commitment_id: 'cm1', user_id: 'u1', channel: 'text',
      status: 'sent', scheduled_for: '2026-08-08T14:00:00.000Z',
      responded_at: null, escalated_at: null, delivered_at: '2026-08-08T14:00:05.000Z',
    };
    const store = makeStore({ commitment: oneShotText(), checkins: [sentNudge] });

    const res = await buildRouter().handle(inbound('later'), { ...TELNYX_ENV, DB: store.DB });
    expect((await res.json()).action).toBe('reschedule_ask_when');
    expect(store.state.checkins.find((c) => c.id === 'ci1').status).toBe('awaiting_time');
  });
});
