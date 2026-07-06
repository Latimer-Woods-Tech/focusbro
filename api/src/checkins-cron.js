// ════════════════════════════════════════════════════════════
// FOCUSBRO — SCHEDULED CHECK-IN DELIVERY  (Contender #10, Phase A · R-205)
// ════════════════════════════════════════════════════════════
// "You said you'd start the taxes at 2. Ready?" — delivered on time.
//
// The accountability core (accountability.js) records a commitment and a
// `commitment_checkins` row scheduled_for the moment you said. THIS module is
// the delivery half: a Worker cron that, every minute, finds check-ins whose
// time has come and sends the warm, anti-shame nudge over the user's channel
// (push now, text when a number + provider are configured; voice is Phase B,
// gated). It then marks each row so it's never sent twice.
//
// THE DESIGN LAW carries through: the only copy this cron emits is
// checkinPromptCopy() from the copy engine — an ally saying "I'm here, let's
// go," never a scold. There is no miss counter anywhere in this path.
//
// Pure + testable: runDueCheckins() takes an env with a D1-shaped `DB` and a
// clock, so the scan/status machine is unit-tested without a live database or
// network. Delivery is config-guarded and degrades gracefully — an unconfigured
// channel marks the check-in `skipped`, never crashes, never touches the timer.
// ════════════════════════════════════════════════════════════

import { checkinPromptCopy, nextOccurrenceISO, pickRecurrence } from './accountability.js';
import { sendWebPush, vapidConfigured } from './webpush.js';
import { evaluateContactGate } from './consent.js';
import { generateUUID } from './middleware.js';

/**
 * Keep a recurring commitment's rhythm alive: once its due check-in has left
 * `pending` (sent / skipped / failed), queue the next occurrence if one isn't
 * already scheduled. Idempotent, and a no-op for one-shots or a commitment
 * that is no longer active. This is the delivery-side safety net that
 * complements the in-app resolve path — the chain continues even when a
 * check-in is never answered or no channel is configured yet.
 *
 * @returns {Promise<boolean>} true if a new occurrence was inserted.
 */
export async function materializeNextOccurrence(env, row, nowISO) {
  if (pickRecurrence(row.recurrence) === 'none') return false;
  if (row.commitment_status && row.commitment_status !== 'active') return false;
  const nextISO = nextOccurrenceISO({
    recurrence: row.recurrence,
    timezone: row.timezone,
    localTime: row.local_time,
    afterISO: nowISO,
  });
  if (!nextISO) return false;

  const existing = await env.DB.prepare(
    `SELECT id FROM commitment_checkins
      WHERE commitment_id = ? AND status = 'pending' AND scheduled_for > ? LIMIT 1`
  ).bind(row.commitment_id, nowISO).first();
  if (existing) return false;

  await env.DB.prepare(
    `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  ).bind(generateUUID(), row.commitment_id, row.user_id, nextISO, row.channel).run();
  return true;
}

/** Max delivery attempts before a check-in is parked as `failed` (transient errors only). */
export const MAX_ATTEMPTS = 3;

/** Default batch size per cron tick. */
const DEFAULT_LIMIT = 100;

/**
 * Deliver a single already-loaded check-in row and return the outcome.
 * Does NOT touch the database — the caller applies the status transition.
 *
 * @param {object} env
 * @param {object} row  { checkin_id, commitment_id, user_id, channel, title, persona }
 * @returns {Promise<{ status: 'sent'|'skipped'|'failed', detail: string, deactivate?: string[] }>}
 *   `deactivate` lists push endpoints that returned 404/410 (gone) to be disabled.
 */
export async function deliverCheckin(env, row) {
  const message = checkinPromptCopy({ title: row.title, persona: row.persona });
  const channel = row.channel === 'text' ? 'text' : 'push';

  if (channel === 'text') return deliverText(env, row, message);
  return deliverPush(env, row, message);
}

/** Deliver over Web Push to every active subscription the user has. */
async function deliverPush(env, row, message) {
  if (!vapidConfigured(env)) return { status: 'skipped', detail: 'push_not_configured' };

  const subs = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions
      WHERE user_id = ? AND is_active = 1`
  ).bind(row.user_id).all();
  const list = (subs && subs.results) || [];
  if (list.length === 0) return { status: 'skipped', detail: 'no_subscription' };

  const payload = {
    title: 'FocusBro',
    body: message,
    tag: `checkin-${row.commitment_id}`,
    data: { type: 'checkin', commitment_id: row.commitment_id, checkin_id: row.checkin_id, url: '/' },
  };

  let anySent = false;
  let lastErr = 'push_failed';
  const deactivate = [];
  for (const sub of list) {
    const r = await sendWebPush(env, sub, payload);
    if (r.ok) anySent = true;
    else {
      lastErr = r.error || lastErr;
      if (r.gone) deactivate.push(sub.endpoint);
    }
  }

  if (anySent) return { status: 'sent', detail: 'push', deactivate };
  return { status: 'failed', detail: lastErr, deactivate };
}

/** Deliver over SMS via Telnyx, if a number and credentials are present. */
async function deliverText(env, row, message) {
  if (!env.TELNYX_API_KEY || !env.TELNYX_FROM_NUMBER) {
    return { status: 'skipped', detail: 'text_not_configured' };
  }

  const user = await env.DB.prepare(`SELECT phone FROM users WHERE id = ?`).bind(row.user_id).first();
  const to = user && typeof user.phone === 'string' ? user.phone.trim() : '';
  if (!to) return { status: 'skipped', detail: 'no_phone' };

  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.TELNYX_FROM_NUMBER, to, text: message }),
  }).catch((e) => ({ ok: false, status: 0, _netErr: e && e.message }));

  if (res.ok) return { status: 'sent', detail: 'text' };
  return { status: 'failed', detail: (res._netErr || `telnyx_status_${res.status || 0}`) };
}

/**
 * Find every pending check-in whose time has come and deliver it.
 * Idempotent: only rows with status='pending' AND scheduled_for<=now are
 * touched, and each is transitioned out of 'pending' (or its attempt count is
 * bumped) so a later tick won't re-send it.
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} [opts] { now?: ISO string, limit?: number }
 * @returns {Promise<{scanned:number, sent:number, skipped:number, failed:number, retry:number, deferred:number}>}
 */
export async function runDueCheckins(env, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_LIMIT;
  const summary = { scanned: 0, sent: 0, skipped: 0, failed: 0, retry: 0, deferred: 0, materialized: 0 };

  const due = await env.DB.prepare(
    `SELECT c.id AS checkin_id, c.commitment_id, c.user_id, c.channel,
            COALESCE(c.attempts, 0) AS attempts, m.title, m.persona,
            m.recurrence, m.timezone, m.local_time, m.status AS commitment_status
       FROM commitment_checkins c
       JOIN commitments m ON m.id = c.commitment_id
      WHERE c.status = 'pending' AND c.scheduled_for <= ?
      ORDER BY c.scheduled_for ASC
      LIMIT ?`
  ).bind(now, limit).all();

  const rows = (due && due.results) || [];
  for (const row of rows) {
    summary.scanned++;

    // CONSENT BY CONSTRUCTION (TCPA): text/voice cannot send without granted
    // consent, inside recipient quiet hours, or after opt-out. Push is app UX,
    // not TCPA-scoped, so evaluateContactGate returns {allow:true} for it.
    let outcome;
    try {
      const gate = await evaluateContactGate(env, {
        userId: row.user_id, channel: row.channel, nowISO: now,
      });
      if (gate.defer) {
        // Held inside quiet hours: leave the row pending (no attempt bump) so a
        // later tick delivers it once the window passes. Never dropped.
        summary.deferred++;
        continue;
      }
      if (gate.skip) {
        outcome = { status: 'skipped', detail: gate.skip };
      }
    } catch (err) {
      outcome = { status: 'failed', detail: (err && err.message) || 'consent_gate_error' };
    }

    if (!outcome) {
      try {
        outcome = await deliverCheckin(env, row);
      } catch (err) {
        outcome = { status: 'failed', detail: (err && err.message) || 'deliver_error' };
      }
    }

    // Disable any subscriptions the push service reported as gone.
    if (outcome.deactivate && outcome.deactivate.length) {
      for (const endpoint of outcome.deactivate) {
        try {
          await env.DB.prepare(
            `UPDATE push_subscriptions SET is_active = 0 WHERE endpoint = ?`
          ).bind(endpoint).run();
        } catch { /* non-fatal */ }
      }
    }

    let leftPending = false;
    try {
      if (outcome.status === 'sent') {
        await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'sent', delivered_at = ?, attempts = COALESCE(attempts,0) + 1, last_error = NULL
            WHERE id = ?`
        ).bind(now, row.checkin_id).run();
        summary.sent++;
        leftPending = true;
      } else if (outcome.status === 'skipped') {
        // No channel available for this user — park it (terminal, no shame, no retry storm).
        await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'skipped', attempts = COALESCE(attempts,0) + 1, last_error = ?
            WHERE id = ?`
        ).bind(outcome.detail, row.checkin_id).run();
        summary.skipped++;
        leftPending = true;
      } else {
        // Transient failure: bump attempts, park as 'failed' once the cap is hit.
        const nextAttempts = (Number(row.attempts) || 0) + 1;
        const terminal = nextAttempts >= MAX_ATTEMPTS;
        await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = ?, attempts = ?, last_error = ?
            WHERE id = ?`
        ).bind(terminal ? 'failed' : 'pending', nextAttempts, outcome.detail, row.checkin_id).run();
        if (terminal) { summary.failed++; leftPending = true; }
        else summary.retry++;
      }
    } catch (err) {
      console.error('[checkins-cron] status update failed:', err && err.message);
    }

    // Once this occurrence is off the pending queue, keep a recurring
    // commitment's rhythm going by queuing the next one (idempotent no-op
    // otherwise). A materialize failure never aborts the batch.
    if (leftPending) {
      try {
        if (await materializeNextOccurrence(env, row, now)) summary.materialized++;
      } catch (err) {
        console.error('[checkins-cron] materialize failed:', err && err.message);
      }
    }
  }

  return summary;
}
