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

import { checkinPromptCopy, checkinReplyHint, escalationCopy, nextOccurrenceISO, pickRecurrence, pickPersona, returnNudgeCopy } from './accountability.js';
import { sendWebPush, vapidConfigured } from './webpush.js';
import { evaluateContactGate, localHour } from './consent.js';
import { generateUUID } from './middleware.js';
import { recordEvent, EVENTS } from './events.js';

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

  // Text has no action buttons, so the nudge itself invites the reply — that's
  // what makes the two-way loop (DONE / LATER → "when do you want to try again?")
  // discoverable over SMS. Push carries its own in-app actions, so it stays clean.
  if (channel === 'text') return deliverText(env, row, `${message}\n\n${checkinReplyHint(row.persona)}`);
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
        // Instrument "the bro showed up" — a delivered nudge is the moat's core
        // signal (IMPROVEMENT_PLAN L1). Non-fatal; never aborts the batch.
        await recordEvent(env, {
          userId: row.user_id, type: EVENTS.CHECKIN_DELIVERED,
          data: { commitment_id: row.commitment_id, channel: row.channel === 'text' ? 'text' : 'push' },
        });
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

// ════════════════════════════════════════════════════════════
// ESCALATION LADDER  (Wingspan W1 — "a reminder that escalates until you start")
// ════════════════════════════════════════════════════════════
// The ADHD failure mode the research nailed: a push notification is swiped away
// in half a second of reflex. So when a *delivered* push check-in has gone
// quiet, the bro knocks ONCE more on a channel that lands differently — SMS.
//
// Bounded by construction, because an escalation engine is one bad loop away
// from a guilt engine:
//   • exactly ONE escalation per check-in, ever (escalated_at is a one-shot
//     latch, set whatever the outcome — never a retry storm, never hammering);
//   • consent-gated like every text (TCPA gate: granted consent, quiet hours
//     deferral, opt-out respected) — SMS consent IS the opt-in;
//   • only while the commitment is still active and the check-in unanswered;
//   • the copy is escalationCopy(): an ally knocking once more, never a scold.

/** Minutes a delivered push check-in stays quiet before the one SMS follow-up. */
export const ESCALATION_DELAY_MIN = 15;

/** Max escalations examined per cron tick. */
const ESCALATION_LIMIT = 50;

/**
 * Find delivered-but-quiet push check-ins past the escalation delay and send
 * each user the ONE warm SMS follow-up. Idempotent: every examined row leaves
 * with `escalated_at` set (except quiet-hours deferrals, which stay eligible
 * for a later tick), so no check-in is ever escalated twice.
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} [opts] { now?: ISO string, limit?: number }
 * @returns {Promise<{scanned:number, escalated:number, deferred:number, skipped:number, failed:number}>}
 */
export async function runEscalations(env, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : ESCALATION_LIMIT;
  const summary = { scanned: 0, escalated: 0, deferred: 0, skipped: 0, failed: 0 };

  const cutoff = new Date(new Date(now).getTime() - ESCALATION_DELAY_MIN * 60 * 1000).toISOString();

  const quiet = await env.DB.prepare(
    `SELECT c.id AS checkin_id, c.commitment_id, c.user_id, c.delivered_at,
            m.title, m.persona, COALESCE(ep.ceiling, 'text') AS ceiling
       FROM commitment_checkins c
       JOIN commitments m ON m.id = c.commitment_id
       LEFT JOIN escalation_prefs ep ON ep.user_id = c.user_id
      WHERE c.status = 'sent' AND c.channel = 'push'
        AND c.responded_at IS NULL AND c.escalated_at IS NULL
        AND c.delivered_at <= ?
        AND m.status = 'active'
      ORDER BY c.delivered_at ASC
      LIMIT ?`
  ).bind(cutoff, limit).all();

  const rows = (quiet && quiet.results) || [];
  for (const row of rows) {
    summary.scanned++;

    let outcome = null;
    if (row.ceiling === 'none') {
      // CEILING (the wedge): the person set their ladder to "just the nudge" — it
      // is never allowed to climb to a text for them. Latch so it's never
      // rescanned. A chosen ceiling is not a failure — it counts as skipped.
      outcome = { status: 'skipped', detail: 'ceiling_none' };
    } else {
      // CONSENT BY CONSTRUCTION: the escalation is a text, so it passes the same
      // TCPA gate as a text check-in. No granted consent → this user simply has
      // no escalation ladder (latch the row so it's never rescanned). Inside
      // quiet hours → leave untouched; a later tick escalates once the window
      // passes. The ladder never wakes anyone up.
      let gate;
      try {
        gate = await evaluateContactGate(env, { userId: row.user_id, channel: 'text', nowISO: now });
      } catch (err) {
        gate = { skip: (err && err.message) || 'consent_gate_error' };
      }
      if (gate.defer) { summary.deferred++; continue; }

      if (gate.skip) {
        outcome = { status: 'skipped', detail: gate.skip };
      } else {
        try {
          const message = `${escalationCopy({ title: row.title, persona: row.persona })}\n\n${checkinReplyHint(row.persona)}`;
          outcome = await deliverText(env, row, message);
        } catch (err) {
          outcome = { status: 'failed', detail: (err && err.message) || 'escalation_error' };
        }
      }
    }

    // One-shot latch, whatever happened: an escalation is offered exactly once.
    try {
      await env.DB.prepare(
        `UPDATE commitment_checkins SET escalated_at = ? WHERE id = ?`
      ).bind(now, row.checkin_id).run();
    } catch (err) {
      console.error('[checkins-cron] escalation latch failed:', err && err.message);
    }

    if (outcome.status === 'sent') {
      summary.escalated++;
      // The moat's second signal: the bro knocked twice. Non-fatal, never aborts.
      await recordEvent(env, {
        userId: row.user_id, type: EVENTS.CHECKIN_ESCALATED,
        data: { commitment_id: row.commitment_id, from: 'push', to: 'text' },
      });
    } else if (outcome.status === 'skipped') {
      summary.skipped++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}

// ════════════════════════════════════════════════════════════
// DELIVERY-LOOP SLO SIGNALS  (Contender #10, Phase A · reliability-as-SLO)
// ════════════════════════════════════════════════════════════
// R-242 (#78) gave the loop a LIVENESS signal — `cron:last_tick` + /health
// `stale` + the off-platform heartbeat.yml probe — so a total cron death (the
// #74 crontab→crons outage) can't run dead unnoticed again. But liveness is not
// enough: a cron that ticks every minute while EVERY send errors (a bad D1
// migration, Telnyx 500s, a push-key regression) would stamp a fresh `last_tick`
// and read perfectly healthy — the moat silently dead behind a green /health.
// That is the next silent-failure class, and this closes it: a CORRECTNESS
// signal that reports the loop degraded when deliveries keep failing.

/**
 * True when a delivery pass actually failed to deliver — i.e. a send/DB attempt
 * errored (parked `failed`, or will `retry`). Deliberately NOT counted as a
 * failure: `deferred` (held for quiet hours — a healthy, correct hold) and
 * `skipped` (no channel / no consent — a terminal, correct park). Only a real
 * send error moves this true, so the degraded signal can never be tripped by
 * the normal anti-shame / TCPA guard paths.
 * @param {{failed?:number, retry?:number}} summary  a runDueCheckins() summary
 */
export function isDeliveryFailingTick(summary = {}) {
  return (Number(summary.failed) || 0) > 0 || (Number(summary.retry) || 0) > 0;
}

/** Consecutive delivery-failing ticks before /health reports the loop degraded.
 *  Ticks are ~1/min, so 3 filters a single transient blip (one Telnyx 500) from
 *  a sustained outage without waiting long — degraded fires within ~3 minutes. */
export const DELIVERY_DEGRADED_STREAK = 3;

/** KV keys for the delivery-loop SLO signals. */
export const CRON_HEALTH_KEYS = Object.freeze({
  lastTick: 'cron:last_tick',
  failStreak: 'cron:delivery_fail_streak',
  lastSummary: 'cron:last_summary',
});

/**
 * Persist the delivery-loop SLO signals after a scheduled pass. Two distinct
 * signals, by design: LIVENESS (`cron:last_tick`, kept byte-compatible with
 * R-242 so /health `stale` + heartbeat.yml keep working) and CORRECTNESS (a
 * rolling `cron:delivery_fail_streak` + the last summary for at-a-glance
 * debugging). Best-effort per key — a KV blip on one signal never masks another
 * or aborts the caller. Returns the new fail streak (for logging/tests).
 * @returns {Promise<number>} the fail streak after this tick
 */
export async function recordCronHealth(env, { nowISO, delivery = {}, escalation = {} } = {}) {
  const kv = env && env.KV_CACHE;
  const now = nowISO || new Date().toISOString();
  let streak = 0;
  if (!kv) return streak;
  // LIVENESS — the loop ran (whatever the per-send outcomes).
  try { await kv.put(CRON_HEALTH_KEYS.lastTick, now); } catch { /* best-effort */ }
  // CORRECTNESS — bump the streak on a delivery-failing tick, reset otherwise.
  try {
    const prev = Number(await kv.get(CRON_HEALTH_KEYS.failStreak)) || 0;
    streak = isDeliveryFailingTick(delivery) ? prev + 1 : 0;
    await kv.put(CRON_HEALTH_KEYS.failStreak, String(streak));
  } catch { /* best-effort */ }
  try {
    await kv.put(CRON_HEALTH_KEYS.lastSummary, JSON.stringify({ at: now, delivery, escalation }));
  } catch { /* best-effort */ }
  return streak;
}

/**
 * Read the delivery-loop SLO signals back for /health. All staleness/degraded
 * math lives here so the route stays declarative. Every read is best-effort:
 * a missing/blipped signal reads as the SAFE value — `stale` (never
 * healthy-by-default) and `delivery_degraded:false` (a monitoring blip must not
 * fabricate an outage the deliveries didn't have).
 * @returns {Promise<object>} the /health `cron` block
 */
export async function readCronHealth(env, { nowMs, staleSeconds } = {}) {
  const kv = env && env.KV_CACHE;
  const at = typeof nowMs === 'number' ? nowMs : Date.now();
  let lastTick = null, failStreak = 0, lastSummary = null;
  try { lastTick = kv ? await kv.get(CRON_HEALTH_KEYS.lastTick) : null; } catch { /* best-effort */ }
  try { failStreak = kv ? (Number(await kv.get(CRON_HEALTH_KEYS.failStreak)) || 0) : 0; } catch { /* best-effort */ }
  try {
    const raw = kv ? await kv.get(CRON_HEALTH_KEYS.lastSummary) : null;
    lastSummary = raw ? JSON.parse(raw) : null;
  } catch { lastSummary = null; }
  const parsed = lastTick ? Date.parse(lastTick) : NaN;
  const ageSeconds = Number.isNaN(parsed) ? null : Math.round((at - parsed) / 1000);
  const threshold = Number(staleSeconds) > 0 ? Number(staleSeconds) : 600;
  const stale = ageSeconds == null ? true : ageSeconds > threshold;
  return {
    last_tick: lastTick,
    age_seconds: ageSeconds,
    stale,
    threshold_seconds: threshold,
    fail_streak: failStreak,
    delivery_degraded: failStreak >= DELIVERY_DEGRADED_STREAK,
    degraded_streak_threshold: DELIVERY_DEGRADED_STREAK,
    last_summary: lastSummary,
  };
}

// ════════════════════════════════════════════════════════════
// RETURN NUDGE  (Wingspan W4 / L3 · focusbro#40 — the ladder applied to RETURNING)
// ════════════════════════════════════════════════════════════
// The escalation ladder (W1 above) catches a *single* check-in that went quiet.
// This catches a whole PERSON who went quiet: someone who has given words before
// but has now drifted off the app entirely, with nothing already scheduled to
// bring them back. The bro reaches out ONCE — warm, no agenda — to hold the door
// open. This is the single most shame-prone moment in the product (every
// abandoned to-do app was a "you disappeared" machine), so the LAW is enforced by
// construction here as hard as anywhere:
//   • exactly ONE nudge per dormancy EPISODE — a per-user KV latch holds the last
//     nudge time; a user is eligible again only once they've been active SINCE it
//     (their last real event advances past the latch), so a persistently-dormant
//     person is never nudged twice. Never a daily drip, never a nag.
//   • opt-in by channel: push is already subscribed (app UX, not TCPA-scoped);
//     text passes the same TCPA gate as every text (consent + quiet hours + opt-out).
//   • an un-scheduled push must never buzz at 3am, so push is held to a sane local
//     daytime window (a quiet-hours defer leaves the user eligible for a later tick).
//   • only users with a real accountability footprint (a `commitment_created`
//     event) and NOTHING already in flight (no pending check-in) — so the nudge
//     never stacks on top of the check-in / escalation ladder.
//   • the copy is returnNudgeCopy(): an ally glad you exist, never a tally.
//
// Instrumentation note: a sent nudge is recorded with userId=NULL (the real user
// in event_data) on purpose — recording it as the user's OWN activity would reset
// the very dormancy this detects, and would inflate active-user/retention counts.

/** Days of total app silence before the one gentle return nudge. */
export const RETURN_NUDGE_QUIET_DAYS = 3;

/** Max dormant users examined per cron tick. */
const RETURN_NUDGE_LIMIT = 50;

/** Local-hour window (inclusive start, exclusive end) an un-scheduled push may land in. */
export const RETURN_NUDGE_DAY_START = 8;
export const RETURN_NUDGE_DAY_END = 21;

/** Per-user KV latch key holding the ISO time of the last return nudge. */
export function returnNudgeKey(userId) {
  return `returnnudge:${userId}`;
}

/**
 * The deep-link a tapped return nudge opens. The `?from=return` marker lets /me/
 * greet a nudged-back person with a specifically warm "glad you're here" welcome
 * (closing the outreach loop), instead of the generic re-entry door — the design
 * LAW at the re-engagement moment. See me.js `applyReturnWelcome`.
 */
export const RETURN_NUDGE_DEEPLINK = '/me/?from=return';

/**
 * True when the local hour at `nowISO` in `timezone` is inside the daytime
 * window. An unknown/blank timezone falls back to UTC rather than blocking — a
 * best-effort courtesy, not a hard gate (text still has its own quiet-hours gate).
 */
export function withinReturnDaytime(nowISO, timezone) {
  const h = localHour(nowISO, (typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'UTC');
  if (h === null) return true;
  return h >= RETURN_NUDGE_DAY_START && h < RETURN_NUDGE_DAY_END;
}

/** Best-effort per-user latch write — a KV blip never aborts the pass. */
async function latchReturnNudge(kv, userId, nowISO) {
  if (!kv) return;
  try { await kv.put(returnNudgeKey(userId), nowISO); } catch { /* best-effort */ }
}

/** Deliver the return nudge over Web Push to every active subscription. */
async function deliverReturnPush(env, userId, message) {
  if (!vapidConfigured(env)) return { status: 'skipped', detail: 'push_not_configured' };
  const subs = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND is_active = 1`
  ).bind(userId).all();
  const list = (subs && subs.results) || [];
  if (list.length === 0) return { status: 'skipped', detail: 'no_subscription' };

  const payload = {
    title: 'FocusBro',
    body: message,
    tag: 'return-nudge',
    data: { type: 'return_nudge', url: RETURN_NUDGE_DEEPLINK },
  };
  let anySent = false;
  let lastErr = 'push_failed';
  for (const sub of list) {
    const r = await sendWebPush(env, sub, payload);
    if (r.ok) anySent = true;
    else {
      lastErr = r.error || lastErr;
      if (r.gone) {
        try {
          await env.DB.prepare(`UPDATE push_subscriptions SET is_active = 0 WHERE endpoint = ?`).bind(sub.endpoint).run();
        } catch { /* non-fatal */ }
      }
    }
  }
  return anySent ? { status: 'sent', detail: 'push' } : { status: 'failed', detail: lastErr };
}

/**
 * Find people who have gone quiet across the whole app and send each ONE warm
 * return nudge. Idempotent per dormancy episode via the KV latch; degrades
 * gracefully (no channel / no consent → parked, never crashes, never touches the
 * timer). Pure-ish: takes an env with a D1-shaped `DB` and (optionally) `KV_CACHE`
 * plus a clock, so the whole machine is unit-tested without a live DB or network.
 *
 * @param {object} env  Worker env with a D1-shaped `DB` (+ optional KV_CACHE)
 * @param {object} [opts] { now?: ISO, limit?: number, quietDays?: number }
 * @returns {Promise<{scanned:number, nudged:number, deferred:number, skipped:number, failed:number}>}
 */
export async function runReturnNudges(env, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : RETURN_NUDGE_LIMIT;
  const quietDays = Number(opts.quietDays) > 0 ? Number(opts.quietDays) : RETURN_NUDGE_QUIET_DAYS;
  const summary = { scanned: 0, nudged: 0, deferred: 0, skipped: 0, failed: 0 };

  const cutoff = new Date(new Date(now).getTime() - quietDays * 24 * 60 * 60 * 1000).toISOString();

  // Dormant candidates: a real accountability user (has a commitment_created
  // event) whose most-recent event is older than the cutoff, with NOTHING
  // pending to reach them (so we never stack on the check-in / escalation ladder).
  const due = await env.DB.prepare(
    `SELECT e.user_id AS user_id, MAX(e.created_at) AS last_event_at
       FROM analytics_events e
      WHERE e.user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM analytics_events c
                     WHERE c.user_id = e.user_id AND c.event_type = 'commitment_created')
        AND NOT EXISTS (SELECT 1 FROM commitment_checkins ck
                     WHERE ck.user_id = e.user_id AND ck.status = 'pending')
      GROUP BY e.user_id
     HAVING MAX(e.created_at) <= ?
      ORDER BY last_event_at ASC
      LIMIT ?`
  ).bind(cutoff, limit).all();

  const rows = (due && due.results) || [];
  const kv = env && env.KV_CACHE;

  for (const row of rows) {
    summary.scanned++;
    const userId = row.user_id;

    // ONE nudge per dormancy episode: if the latch is newer than their last real
    // activity, we've already nudged this episode — skip until they return (which
    // advances last_event_at past the latch and re-opens eligibility).
    let latch = null;
    try { latch = kv ? await kv.get(returnNudgeKey(userId)) : null; } catch { latch = null; }
    if (latch && latch > row.last_event_at) { summary.skipped++; continue; }

    // Tone + local time come from their most recent commitment.
    const pref = await env.DB.prepare(
      `SELECT persona, timezone FROM commitments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).first();
    const persona = pickPersona(pref && pref.persona);
    const timezone = (pref && pref.timezone) || 'UTC';

    // Pick a reachable channel: push first (subscribed, no TCPA), else text if
    // consent was granted. No channel at all → nothing to reach them on.
    let channel = null;
    const sub = await env.DB.prepare(
      `SELECT 1 FROM push_subscriptions WHERE user_id = ? AND is_active = 1 LIMIT 1`
    ).bind(userId).first();
    if (sub) channel = 'push';
    else {
      const consented = await env.DB.prepare(
        `SELECT 1 FROM contact_consent WHERE user_id = ? AND channel = 'text' AND status = 'granted' LIMIT 1`
      ).bind(userId).first();
      if (consented) channel = 'text';
    }

    if (!channel) {
      // Latch so we don't rescan every tick; resets naturally on their return.
      summary.skipped++;
      await latchReturnNudge(kv, userId, now);
      continue;
    }

    const message = returnNudgeCopy({ persona });
    let outcome;
    if (channel === 'push') {
      // Never buzz an un-scheduled push in the middle of the night. Outside the
      // window: leave eligible for a later (daytime) tick — do NOT latch.
      if (!withinReturnDaytime(now, timezone)) { summary.deferred++; continue; }
      try {
        outcome = await deliverReturnPush(env, userId, message);
      } catch (err) {
        outcome = { status: 'failed', detail: (err && err.message) || 'return_push_error' };
      }
    } else {
      // Text passes the same TCPA gate as every text (consent + quiet hours). A
      // quiet-hours defer leaves the user eligible for a later tick (no latch).
      let gate;
      try {
        gate = await evaluateContactGate(env, { userId, channel: 'text', nowISO: now });
      } catch (err) {
        gate = { skip: (err && err.message) || 'consent_gate_error' };
      }
      if (gate.defer) { summary.deferred++; continue; }
      if (gate.skip) {
        outcome = { status: 'skipped', detail: gate.skip };
      } else {
        try {
          outcome = await deliverText(env, { user_id: userId }, message);
        } catch (err) {
          outcome = { status: 'failed', detail: (err && err.message) || 'return_text_error' };
        }
      }
    }

    // Latch on any terminal outcome (sent / skipped / failed): one attempt per
    // episode, no retry storm. A defer already `continue`d above without latching.
    await latchReturnNudge(kv, userId, now);

    if (outcome.status === 'sent') {
      summary.nudged++;
      // Aggregate-only signal — userId NULL so it never counts as the user's own
      // activity (that would reset the dormancy this very pass detects).
      await recordEvent(env, {
        userId: null, type: EVENTS.RETURN_NUDGE_SENT, data: { user_id: userId, channel },
      });
    } else if (outcome.status === 'skipped') {
      summary.skipped++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}
