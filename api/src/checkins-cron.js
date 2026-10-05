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

import { checkinPromptCopy, checkinReplyHint, escalationCopy, nextOccurrenceISO, pickRecurrence, pickPersona, returnNudgeCopy, ON_OPEN_OCCURRENCE_CONFLICT } from './accountability.js';
import { validateCheckinScript, mapCoachPersona } from './coach-onboarding.js';
import { sendWebPush, vapidConfigured } from './webpush.js';
import { signReplyTicket } from './checkin-reply.js';
import { checkinActionLabels } from './me.js';
import { evaluateContactGate, localHour, nextInstantWhere } from './consent.js';
import { isProUser } from './pro.js';
import { generateUUID } from './middleware.js';
import { recordEvent, EVENTS } from './events.js';

// ════════════════════════════════════════════════════════════
// PER-TICK SUBREQUEST BUDGET  (FBQ-09)
// ════════════════════════════════════════════════════════════
// A scheduled invocation may make at most 1,000 subrequests on the paid plan (50
// on free) and every D1 call and outbound fetch is one. A worst-case tick (100
// deliveries + 50 escalations + 50 return nudges) made ~1,150, and the late stages
// sit in try/catch, so they would have died silently behind a green heartbeat.
// Now every D1 call and send is counted against ONE budget threaded through the
// three stages; a stage that finds its ceiling reached finishes the row in hand
// (a claimed row is never abandoned mid-send) and stops, leaving the rest due for
// the next tick. Ceilings reserve a slice for the late stages so a deliveries
// backlog can never starve them for good: deliveries stop at limit - 2R,
// escalations at limit - R, return nudges at limit (R = 15% of limit).
// A D1 batch() is one subrequest, so it is counted as one.

/** Subrequests one tick may spend: well under the 1,000 cap, leaving room for the heartbeat + summary writes. */
export const TICK_BUDGET = 800;
const STAGE_RESERVE = 0.15;
/** Worst-case calls one row may still make after the budget check passed (claim, lookups, <=5 pushes, writes). */
const ROW_MARGIN = 12;
const BUDGET = Symbol('tickBudget');

/** A fresh tick budget. `hasRoom(stage)`: may that stage still START another row? */
export function makeTickBudget(limit = TICK_BUDGET) {
  const reserve = Math.floor(limit * STAGE_RESERVE);
  const ceilings = { delivery: limit - 2 * reserve, escalation: limit - reserve, return_nudge: limit };
  return {
    limit, used: 0,
    hasRoom(stage) { return this.used + ROW_MARGIN <= ceilings[stage]; },
    summary() { return { limit, used: this.used, exhausted: this.used + ROW_MARGIN > limit }; },
  };
}

/** Count `n` outbound fetches against the tick budget carried on `env` (no-op without one). */
function spendFetch(env, n = 1) {
  const b = env && env[BUDGET];
  if (b) b.used += n;
}

/** `env` with a DB whose every query (and fetch, via spendFetch) counts against `budget`. */
function meterEnv(env, budget) {
  const wrap = (st) => ({
    raw: st,
    bind: (...a) => wrap(st.bind(...a)),
    run: (...a) => { budget.used++; return st.run(...a); },
    first: (...a) => { budget.used++; return st.first(...a); },
    all: (...a) => { budget.used++; return st.all(...a); },
  });
  const DB = { prepare: (sql) => wrap(env.DB.prepare(sql)) };
  if (typeof env.DB.batch === 'function') {
    DB.batch = (list) => { budget.used++; return env.DB.batch(list.map((x) => x.raw || x)); };
  }
  return { ...env, DB, [BUDGET]: budget };
}

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
  const nextISO = nextOccurrenceFor(row, nowISO);
  if (!nextISO) return false;
  return changed(await occurrenceInsert(env, row, nextISO, nowISO).run());
}

/** The next occurrence's instant, or null for a one-shot / inactive commitment. */
function nextOccurrenceFor(row, nowISO) {
  if (pickRecurrence(row.recurrence) === 'none') return null;
  if (row.commitment_status && row.commitment_status !== 'active') return null;
  return nextOccurrenceISO({
    recurrence: row.recurrence,
    timezone: row.timezone,
    localTime: row.local_time,
    afterISO: nowISO,
  }) || null;
}

/**
 * The next-occurrence INSERT as ONE statement (FBQ-09: it was a SELECT then an
 * INSERT). The NOT EXISTS is the fast path, the partial unique index (FBQ-05 R4)
 * the guarantee: the app's resolve path inserting the same occurrence in between
 * turns a lost race into a no-op instead of a second nudge. `andWhere` lets a
 * batch condition it on the finishing write having landed.
 */
function occurrenceInsert(env, row, nextISO, nowISO, andWhere = { sql: '', binds: [] }) {
  return env.DB.prepare(
    `INSERT INTO commitment_checkins (id, commitment_id, user_id, scheduled_for, channel, status)
     SELECT ?, ?, ?, ?, ?, 'pending'
      WHERE NOT EXISTS (SELECT 1 FROM commitment_checkins
             WHERE commitment_id = ? AND status = 'pending' AND scheduled_for > ?)${andWhere.sql}
     ${ON_OPEN_OCCURRENCE_CONFLICT}`
  ).bind(generateUUID(), row.commitment_id, row.user_id, nextISO, row.channel, row.commitment_id, nowISO, ...andWhere.binds);
}

/** True when a D1 write reports it changed at least one row. */
function changed(res) {
  return !!(res && res.meta && res.meta.changes > 0);
}

/** Max delivery attempts before a check-in is parked as `failed` (transient errors only). */
export const MAX_ATTEMPTS = 3;

/**
 * How long past its scheduled moment a check-in may still go out as a timely
 * nudge. Beyond this the moment has passed: "ready to start the taxes you said
 * you'd do at 2?" arriving this late is a nag about a gone moment — the exact
 * opposite of the on-time ally the design LAW requires — so a stale occurrence
 * is RETIRED without a late send instead of firing it. A one-shot is parked
 * no-shame (never a miss, never a count); a recurring commitment still
 * materializes its next occurrence on-beat, and the silent-miss warm door
 * (R-286/R-288) greets the person warmly on return. Deliberately longer than any
 * overnight quiet-hours deferral (which IS delivered on purpose once its window
 * opens — evaluated before this guard), so this only ever catches an
 * unambiguously-passed moment: a recovered cron outage (the #74 crons death), a
 * stuck consent/quiet-hours gate, or a long provider backlog.
 */
export const MAX_CHECKIN_LATENESS_MIN = 24 * 60;

/**
 * True when a delivery provider's HTTP status describes a PERMANENT failure —
 * one that can never succeed on retry (e.g. Telnyx 400/422 for a mistyped or
 * unreachable number). These are parked `failed` on the first attempt instead
 * of burning the remaining ticks against a send that will never land.
 *
 * Retryable-therefore-NOT-permanent: network/timeout (status 0), any 5xx
 * (server-side, transient), and the two 4xx that are explicitly transient —
 * 408 Request Timeout and 429 Too Many Requests (back off and retry). Anything
 * unknown falls through as transient, so we never fail-fast on a status we
 * can't confidently call permanent.
 *
 * @param {number} status  an HTTP status code (0 for a network error)
 */
export function isPermanentDeliveryError(status) {
  const s = Number(status) || 0;
  if (s === 408 || s === 429) return false;
  return s >= 400 && s < 500;
}

/** Default batch size per cron tick. */
const DEFAULT_LIMIT = 100;

/**
 * Pages one tick may scan (FBQ-06). A row held for quiet hours / the night guard
 * is parked with `next_attempt_at` and drops out of the scan until its hold ends,
 * but the tick that FIRST holds it still spends a batch slot on it. When a full
 * page held rows, the tick scans again (now without them) so a due row queued
 * behind a wall of newly held ones still goes out this tick. Bounded at 2 so a
 * cold tick (every row newly held, ~3 queries each) stays well under the D1
 * per-invocation call cap; a longer wall clears on the following ticks.
 */
const MAX_SCAN_PAGES = 2;

/**
 * Park a held row until its hold ends (FBQ-06): the scan skips it until then, so
 * it costs nothing per tick and never occupies the batch. Conditional on
 * 'pending' so an answer or re-pend that moved it is never overwritten. A null
 * `until` (no end found) leaves the row scannable, as before. Non-fatal.
 */
async function holdUntil(env, checkinId, until) {
  if (!until) return;
  try {
    await env.DB.prepare(
      `UPDATE commitment_checkins SET next_attempt_at = ? WHERE id = ? AND status = 'pending'`
    ).bind(until, checkinId).run();
  } catch (err) {
    console.error('[checkins-cron] hold failed:', err && err.message);
  }
}

/**
 * Minutes a claimed check-in stays `sending` before another tick may reclaim it
 * (FBQ-05). A claim is taken per row, right before that row's send, so it only
 * has to outlive ONE row's delivery. 15 minutes is the platform's wall-time cap
 * for a scheduled invocation, so a lease can never expire under a cron tick that
 * is still alive and still sending: an expired lease means the claimer is gone.
 * The cost is that a row whose tick died waits up to 15 minutes, well inside
 * the 24h staleness window (MAX_CHECKIN_LATENESS_MIN).
 * FBQ-08: every push send now has a 5s timeout, so one row's delivery is bounded
 * to seconds; 15 minutes is therefore generous, and deliberately left unchanged
 * (a shorter lease would only add duplicate-send risk for no benefit).
 */
export const SEND_LEASE_MIN = 15;

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
  // A coached client hears their COACH's configured voice + opening line; a
  // self-directed user is completely unchanged. This is the delivery half of the
  // coach's pen (coach-onboarding.js slice 1 validated + stored it) — the line a
  // coach authored is now the first thing the person actually hears.
  const coach = await resolveCoachCheckin(env, row.user_id);
  const persona = coach ? mapCoachPersona(coach.voice_persona) : row.persona;
  const opener = coach ? safeCoachOpener(coach.script) : '';

  // Seed the nudge on the per-occurrence check-in id so a recurring commitment
  // rotates its wording across days (never the same wallpaper line twice running)
  // while a retry of THIS occurrence always reads identically. Falls back to the
  // commitment id if the row somehow lacks a check-in id.
  const nudge = checkinPromptCopy({
    title: row.title, persona, seed: row.checkin_id ?? row.commitment_id,
  });
  const message = opener ? `${opener}\n\n${nudge}` : nudge;
  const channel = row.channel === 'text' ? 'text' : 'push';

  // Text has no action buttons, so the nudge itself invites the reply — that's
  // what makes the two-way loop (DONE / LATER / HELP ME START) discoverable over
  // SMS. Push carries its own in-app actions, so it stays clean.
  if (channel === 'text') return deliverText(env, row, `${message}\n\n${checkinReplyHint(persona)}`);
  return deliverPush(env, row, message);
}

/**
 * A coach's opening line, but ONLY if it still passes the never-shame battery
 * at read time. The line is already validated at the write boundary
 * (coach-onboarding.js), so this is defence in depth: a line that somehow fails
 * validation — an older row, a direct DB write — is dropped and the client gets
 * the warm standard nudge instead. A shaming line can never reach a person, even
 * one stored out-of-band. THE DESIGN LAW, enforced twice.
 * @param {string} script
 * @returns {string} the safe opening line, or '' to fall back to the standard nudge
 */
function safeCoachOpener(script) {
  const v = validateCheckinScript(script);
  return v.ok ? v.value : '';
}

/**
 * Resolve the coach-configured opening line + voice for a client's check-in, or
 * null when this user is not a consented client of a coach who has set up
 * check-ins.
 *
 * CONSENT BY CONSTRUCTION: only an `active` coach_clients link is ever
 * considered — a pending / declined / removed link never lets a coach's voice
 * reach the person. A client linked to more than one coach resolves
 * deterministically to their earliest active link, so the voice never flickers
 * between ticks. One indexed `.first()` lookup (idx_coach_clients_client), so a
 * check-in is never fanned out into a double send. Non-fatal: any error resolves
 * to null and the standard nudge is delivered — the coach layer never breaks a
 * self-directed check-in.
 * @param {object} env
 * @param {string} userId
 * @returns {Promise<{script:string, voice_persona:string}|null>}
 */
async function resolveCoachCheckin(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT kcfg.script AS script, kcfg.voice_persona AS voice_persona
         FROM coach_clients cc
         JOIN coach_operators co ON co.user_id = cc.coach_user_id
         JOIN coach_checkin_config kcfg ON kcfg.operator_id = co.operator_id
        WHERE cc.client_user_id = ? AND cc.status = 'active'
        ORDER BY cc.created_at ASC, cc.id ASC
        LIMIT 1`,
    ).bind(userId).first();
    return row && row.script ? row : null;
  } catch {
    return null;
  }
}

/**
 * The voice a check-in to this user should speak in across the WHOLE ladder — the
 * first nudge, the escalation knock, the return nudge. When they are the consented
 * client of a coach who has set up check-ins, it is the coach's mapped voice; when
 * they are self-directed, it is the fallback (the commitment's own persona). Same
 * consent-by-construction + deterministic single-link resolution as the delivery
 * path (`resolveCoachCheckin`), so a coached client never hears their coach's voice
 * open the conversation and then a stranger's voice finish it. Non-fatal by
 * inheritance: a resolution error falls back to the person's own persona.
 *
 * @param {object} env
 * @param {string} userId
 * @param {string} fallbackPersona  the persona to speak in when there is no coach
 * @returns {Promise<string>} the persona the copy engine should speak in
 */
async function checkinVoice(env, userId, fallbackPersona) {
  const coach = await resolveCoachCheckin(env, userId);
  return coach ? mapCoachPersona(coach.voice_persona) : fallbackPersona;
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

  // The notification IS the check-in. Two buttons answer it in place — the two
  // the /me/ card leads with — so keeping a word never requires opening an app.
  // "I did it" resolves through a one-tap ticket (a service worker has no
  // session); "Not yet" lands on the word with the warm reschedule open. And a
  // plain tap lands on the word itself — never the toolkit home.
  const labels = checkinActionLabels();
  const reply = await signReplyTicket(env.JWT_SECRET, row.checkin_id);
  const wordUrl = `/me/?word=${encodeURIComponent(row.commitment_id)}`;
  const payload = {
    title: 'FocusBro',
    body: message,
    tag: `checkin-${row.commitment_id}`,
    actions: [
      { action: 'kept', title: labels.kept },
      { action: 'not-yet', title: labels.missed },
    ],
    data: { type: 'checkin', commitment_id: row.commitment_id, checkin_id: row.checkin_id, url: wordUrl, reply },
  };

  let anySent = false;
  let lastErr = 'push_failed';
  const deactivate = [];
  const suspect = [];
  // FBQ-08 R3: bounded concurrent fan-out; each send carries its own timeout, so
  // one hung endpoint costs at most PUSH_TIMEOUT_MS, not the whole tick.
  const results = await sendAll(env, list, payload);
  results.forEach((r, i) => {
    if (r.ok) anySent = true;
    else {
      lastErr = r.error || lastErr;
      if (r.gone) deactivate.push(list[i].endpoint);
      else if (r.suspect) suspect.push(list[i].endpoint);
    }
  });

  if (anySent) return { status: 'sent', detail: 'push', deactivate, suspect, pushOk: true };
  return { status: 'failed', detail: lastErr, deactivate, suspect };
}

/** Max pushes in flight for one check-in (a user holds at most 5 active subscriptions). */
const PUSH_CONCURRENCY = 5;

/** sendWebPush over `subs`, PUSH_CONCURRENCY at a time, results in input order. */
async function sendAll(env, subs, payload) {
  const out = [];
  spendFetch(env, subs.length);
  for (let i = 0; i < subs.length; i += PUSH_CONCURRENCY) {
    out.push(...await Promise.all(subs.slice(i, i + PUSH_CONCURRENCY).map((s) => sendWebPush(env, s, payload))));
  }
  return out;
}

/**
 * FBQ-08 R5: retire 400/403 subscriptions only with proof the server side works.
 * A 400/403 is what a dead subscription answers, but also what EVERY subscription
 * answers if our VAPID key/subject or encryption is misconfigured, and a mass
 * deactivation of the whole user base is unrecoverable (people would have to
 * re-subscribe). So they are retired only when another push in the same pass
 * succeeded (the config demonstrably works); otherwise they are kept and the
 * condition is logged loudly. 404/410 never wait: those are unambiguous.
 */
async function settleSuspects(env, suspects, anyPushOk) {
  if (!suspects.length) return;
  if (!anyPushOk) {
    console.error(`[checkins-cron] push_vapid_suspect: ${suspects.length} endpoint(s) answered 400/403 and NO push succeeded in this pass — kept active (check VAPID_* config)`);
    return;
  }
  for (const endpoint of suspects) {
    try {
      await env.DB.prepare(`UPDATE push_subscriptions SET is_active = 0 WHERE endpoint = ?`).bind(endpoint).run();
    } catch { /* non-fatal */ }
  }
}

/** Deliver over SMS via Telnyx, if a number and credentials are present. */
async function deliverText(env, row, message) {
  if (!env.TELNYX_API_KEY || !env.TELNYX_FROM_NUMBER) {
    return { status: 'skipped', detail: 'text_not_configured' };
  }

  const user = await env.DB.prepare(`SELECT phone FROM users WHERE id = ?`).bind(row.user_id).first();
  const to = user && typeof user.phone === 'string' ? user.phone.trim() : '';
  if (!to) return { status: 'skipped', detail: 'no_phone' };

  spendFetch(env);
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.TELNYX_FROM_NUMBER, to, text: message }),
  }).catch((e) => ({ ok: false, status: 0, _netErr: e && e.message }));

  if (res.ok) return { status: 'sent', detail: 'text' };
  // A network error (no HTTP status) is transient; an HTTP error is permanent
  // only for a non-retryable 4xx (bad/unreachable number). The caller uses
  // `permanent` to decide fail-fast vs. retry-to-cap.
  const permanent = res._netErr ? false : isPermanentDeliveryError(res.status);
  return { status: 'failed', detail: (res._netErr || `telnyx_status_${res.status || 0}`), permanent };
}

/**
 * Find every pending check-in whose time has come and deliver it.
 * Safe under overlapping ticks (FBQ-05): each due row is claimed
 * ('pending' → 'sending' under a lease) before it is sent, so only one tick
 * ever sends it, and the finishing write applies only while the claim still
 * holds, so an answer recorded mid-send is never overwritten.
 *
 *   pending ──claim──▶ sending ──sent / skipped / failed──▶ (terminal)
 *      ▲                  │ └──retryable failure──▶ pending
 *      └──lease expired───┘   (answered mid-send: kept/missed/… stands)
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} [opts] { now?: ISO string, limit?: number }
 * @returns {Promise<{scanned:number, sent:number, skipped:number, failed:number, retry:number, deferred:number, reclaimed:number, contended:number, superseded:number}>}
 */
export async function runDueCheckins(rawEnv, opts = {}) {
  const budget = opts.budget || makeTickBudget();
  const env = meterEnv(rawEnv, budget);
  const now = opts.now || new Date().toISOString();
  const nowMs = Date.parse(now);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_LIMIT;
  const summary = { scanned: 0, sent: 0, skipped: 0, failed: 0, retry: 0, deferred: 0, stale: 0, materialized: 0, reclaimed: 0, contended: 0, superseded: 0, skipped_for_budget: 0 };
  const leaseUntil = new Date((Number.isNaN(nowMs) ? Date.now() : nowMs) + SEND_LEASE_MIN * 60 * 1000).toISOString();

  // FBQ-05 R3: a claim whose lease has passed belongs to an invocation that died
  // mid-send. Return it to the queue so it is not stranded (it may have gone out
  // once; at-least-once beats never). A NULL lease on a 'sending' row is treated
  // as expired for the same reason.
  try {
    const swept = await env.DB.prepare(
      `UPDATE commitment_checkins SET status = 'pending', lease_until = NULL, next_attempt_at = NULL, last_error = 'lease_expired'
        WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < ?)`
    ).bind(now).run();
    summary.reclaimed = changed(swept) ? swept.meta.changes : 0;
  } catch (err) {
    console.error('[checkins-cron] lease sweep failed:', err && err.message);
  }

  // FBQ-06: a held row (next_attempt_at in the future) is outside the scan, and
  // idx_checkins_eligible orders pending rows by the instant they become due, so
  // a held row is not even read until its hold ends. A hold is only ever set on
  // a due row and every re-pend clears it, so the eligible instant is never
  // before scheduled_for; the claim below re-checks scheduled_for regardless.
  const seen = new Set();
  const scanPage = async () => {
    const due = await env.DB.prepare(
    `SELECT c.id AS checkin_id, c.commitment_id, c.user_id, c.channel,
            c.scheduled_for, COALESCE(c.attempts, 0) AS attempts, m.title, m.persona,
            m.recurrence, m.timezone, m.local_time, m.status AS commitment_status,
            EXISTS (SELECT 1 FROM pro_purchases pp
                     WHERE pp.user_id = c.user_id AND pp.status = 'paid') AS is_pro,
            EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id
                     AND u.phone_verified_at IS NOT NULL AND TRIM(COALESCE(u.phone, '')) != '') AS phone_ok
       FROM commitment_checkins c
       JOIN commitments m ON m.id = c.commitment_id
      WHERE c.status = 'pending' AND COALESCE(c.next_attempt_at, c.scheduled_for) <= ?
      ORDER BY COALESCE(c.next_attempt_at, c.scheduled_for) ASC
      LIMIT ?`
    ).bind(now, limit).all();
    const fetched = (due && due.results) || [];
    // A row this tick already handled (left pending for a retry) is not re-run.
    return { rows: fetched.filter((r) => !seen.has(r.checkin_id)), full: fetched.length >= limit, held: 0 };
  };

  // FBQ-08 R5: 400/403 endpoints seen this tick, retired at the end only if some
  // push in the same tick succeeded (see settleSuspects).
  let tickPushOk = false;
  const tickSuspects = [];

  let page = { rows: [], full: true, held: -1 };
  for (let pages = 0; ;) {
    // FBQ-09: out of budget → start no new row (the one in hand was finished
    // last iteration); what is left stays 'pending' for the next tick.
    if (!budget.hasRoom('delivery')) { summary.skipped_for_budget = page.rows.length; break; }
    if (!page.rows.length) {
      // Scan again only while the last page was full AND held rows filled it.
      if (!page.full || page.held === 0 || pages >= MAX_SCAN_PAGES) break;
      page = await scanPage();
      pages++;
      if (!page.rows.length) break;
    }
    const scanned = page.rows.shift();
    seen.add(scanned.checkin_id);
    summary.scanned++;

    // PRO (2026-10-01): a text check-in is a FocusBro Pro feature — every SMS
    // costs money. A free person's text check-in is delivered as a PUSH instead
    // (same nudge, same moment). The stored channel is left as the person chose
    // it, so it starts texting the moment Pro is on. With no push subscription
    // the row parks with an explicit reason — never dropped silently, never a
    // text. Decided BEFORE the consent gate, so a free person's phone and
    // consent row are never even read on this path.
    // FBQ-12 (default ruling): a number that has not been verified has NO text
    // channel — the same push fallback applies (hasVerifiedTextChannel's SQL twin).
    const textNotPro = scanned.channel === 'text' && !Number(scanned.is_pro);
    const textUnverified = scanned.channel === 'text' && !textNotPro && !Number(scanned.phone_ok);
    const row = (textNotPro || textUnverified) ? { ...scanned, channel: 'push' } : scanned;

    // CONSENT BY CONSTRUCTION (TCPA): text/voice cannot send without granted
    // consent, inside recipient quiet hours, or after opt-out. Push is app UX,
    // not TCPA-scoped, so evaluateContactGate returns {allow:true} for it.
    let outcome;
    try {
      const gate = await evaluateContactGate(env, {
        userId: row.user_id, channel: row.channel, nowISO: now,
      });
      if (gate.defer) {
        // Held inside quiet hours: leave the row pending (no attempt bump) and
        // parked until the window ends, when a tick delivers it. Never dropped.
        summary.deferred++;
        page.held++;
        await holdUntil(env, row.checkin_id, gate.until);
        continue;
      }
      if (gate.skip) {
        outcome = { status: 'skipped', detail: gate.skip };
      }
    } catch (err) {
      outcome = { status: 'failed', detail: (err && err.message) || 'consent_gate_error' };
    }

    // Too old to be a timely nudge? Retire it instead of nagging late (see
    // MAX_CHECKIN_LATENESS_MIN). Checked only AFTER the quiet-hours defer above
    // (a deferred row `continue`s and never reaches here), so a check-in held
    // pending on purpose overnight and delivered when its window opens is never
    // mistaken for stale — only an unambiguously-passed moment (recovered cron
    // outage, stuck gate, provider backlog) lands here. Parked no-shame; the
    // recurring materialize below keeps the rhythm on-beat.
    if (!outcome && !Number.isNaN(nowMs) && row.scheduled_for) {
      const scheduledMs = Date.parse(row.scheduled_for);
      if (!Number.isNaN(scheduledMs) && nowMs - scheduledMs > MAX_CHECKIN_LATENESS_MIN * 60 * 1000) {
        outcome = { status: 'skipped', detail: 'stale' };
      }
    }

    // NIGHT GUARD (R-291, extended to the FIRST rung) — a scheduled text is
    // delivered at the person's CHOSEN local_time on time, so it needs no
    // structural night floor (unlike the UNSCHEDULED escalation / return nudge).
    // But a recovered-cron backlog, a stuck gate, or a provider backlog can slip
    // that delivery hours late — and the ONLY night guards left on this path are
    // the opt-in TCPA quiet-hours gate (a no-op for a text-consented user who
    // never set a window: quiet_start === quiet_end → NO quiet hours) and a 24h
    // staleness cap far too wide to stop a 3am landing. So a check-in the person
    // scheduled for a DAYTIME hour could still buzz at 3am the exact way #335's
    // escalation once could — the trust-breaking intrusion the LAW forbids. When
    // the night landing is purely an artifact of LATENESS (its chosen local hour
    // was daytime, but delivery would land at night NOW), defer to a later
    // daytime tick — leave it pending, no attempt bump, exactly like a
    // quiet-hours defer. A person who deliberately scheduled a NIGHT check-in
    // (scheduled_for's own local hour is at night) is honored, untouched — the
    // guard narrows nothing they chose. Text only: push is silent app UX, not a
    // ring that wakes anyone. Read the SAME recipient clock the TCPA gate uses.
    // Checked AFTER the stale retire above, so a genuinely stale (>24h) night
    // check-in is parked no-shame, not deferred toward forever.
    if (!outcome && row.channel === 'text') {
      const guardTz = await nightGuardTimezone(env, row.user_id, row.timezone);
      const schedHour = localHour(row.scheduled_for, guardTz);
      const schedWasDaytime =
        schedHour !== null && schedHour >= RETURN_NUDGE_DAY_START && schedHour < RETURN_NUDGE_DAY_END;
      if (schedWasDaytime && !withinUnscheduledDaytime(now, guardTz)) {
        summary.deferred++;
        page.held++;
        await holdUntil(env, row.checkin_id, nextInstantWhere(now, (iso) => withinUnscheduledDaytime(iso, guardTz)));
        continue;
      }
    }

    // FBQ-05 R1: claim the row before sending. Held rows `continue`d above
    // without claiming, so a hold never strands a row as 'sending'. A row with
    // an outcome already (gate skip, stale) sends nothing and is finished below
    // from 'pending'. Losing the claim means another tick (or an answer) got
    // there first: leave the row alone.
    const claimed = !outcome;
    if (claimed) {
      let claim = null;
      try {
        claim = await env.DB.prepare(
          `UPDATE commitment_checkins SET status = 'sending', lease_until = ?, next_attempt_at = NULL
            WHERE id = ? AND status = 'pending' AND scheduled_for <= ?`
        ).bind(leaseUntil, row.checkin_id, now).run();
      } catch (err) {
        console.error('[checkins-cron] claim failed:', err && err.message);
        summary.retry++;
        continue;
      }
      if (!changed(claim)) { summary.contended++; continue; }
    }

    if (!outcome) {
      try {
        outcome = await deliverCheckin(env, row);
      } catch (err) {
        outcome = { status: 'failed', detail: (err && err.message) || 'deliver_error' };
      }
      // Name WHY a free person's text check-in could not be delivered as push.
      if (textNotPro && outcome.status === 'skipped') {
        outcome = { ...outcome, detail: `text_is_pro_${outcome.detail}` };
      }
      if (textUnverified && outcome.status === 'skipped') {
        outcome = { ...outcome, detail: `phone_unverified_${outcome.detail}` };
      }
    }

    if (outcome.pushOk) tickPushOk = true;
    if (outcome.suspect && outcome.suspect.length) tickSuspects.push(...outcome.suspect);

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

    // FBQ-05 R2: every finishing write applies only while the row is still ours
    // — 'sending' under this tick's lease, or (no claim taken) still 'pending'.
    // A person who answered during the send moved it off 'sending'; their
    // answer stands and the write below changes nothing.
    const ours = claimed
      ? { sql: `status = 'sending' AND lease_until = ?`, binds: [leaseUntil] }
      : { sql: `status = 'pending'`, binds: [] };
    if (outcome.status === 'sent') {
      // Instrument "the bro showed up" — a delivered nudge is the moat's core
      // signal (IMPROVEMENT_PLAN L1). Recorded on the send itself, whatever the
      // row says afterwards. Non-fatal; never aborts the batch.
      await recordEvent(env, {
        userId: row.user_id, type: EVENTS.CHECKIN_DELIVERED,
        data: { commitment_id: row.commitment_id, channel: row.channel === 'text' ? 'text' : 'push' },
      });
    }

    let leftPending = false;
    let batchedNext = false;
    try {
      if (outcome.status === 'sent') {
        const upd = env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'sent', delivered_at = ?, attempts = COALESCE(attempts,0) + 1, last_error = NULL, lease_until = NULL
            WHERE id = ? AND ${ours.sql}`
        ).bind(now, row.checkin_id, ...ours.binds);
        // FBQ-09 R2: the finishing write and the next occurrence go in ONE batch
        // (one subrequest, one transaction). The finishing write stays conditional
        // on the lease; the insert only lands if it did. If the batch itself
        // throws (the insert can never be allowed to cost the 'sent' mark: an
        // unmarked row would be re-sent), fall back to the plain write alone.
        const nextISO = nextOccurrenceFor(row, now);
        let res, nextRes = null;
        if (nextISO && env.DB.batch) {
          try {
            [res, nextRes] = await env.DB.batch([upd, occurrenceInsert(env, row, nextISO, now, {
              sql: ` AND EXISTS (SELECT 1 FROM commitment_checkins WHERE id = ? AND status = 'sent' AND delivered_at = ?)`,
              binds: [row.checkin_id, now],
            })]);
            batchedNext = true;
          } catch (err) {
            console.error('[checkins-cron] finish batch failed, writing alone:', err && err.message);
          }
        }
        if (!res) res = await upd.run();
        if (changed(nextRes)) summary.materialized++;
        if (changed(res)) { summary.sent++; leftPending = true; } else summary.superseded++;
      } else if (outcome.status === 'skipped') {
        // Terminal park, no shame, no retry storm: either no channel is available
        // for this user, or the moment aged out (detail 'stale'). Both leave the
        // occupancy queue and, for a recurring commitment, let the next
        // occurrence materialize below so the rhythm continues on-beat.
        const res = await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = 'skipped', attempts = COALESCE(attempts,0) + 1, last_error = ?, lease_until = NULL
            WHERE id = ? AND ${ours.sql}`
        ).bind(outcome.detail, row.checkin_id, ...ours.binds).run();
        if (!changed(res)) summary.superseded++;
        else { if (outcome.detail === 'stale') summary.stale++; else summary.skipped++; leftPending = true; }
      } else {
        // Delivery failure: bump attempts. Park as 'failed' once the retry cap
        // is hit — OR immediately when the error is permanent (a Telnyx 4xx for
        // a bad/unreachable number can never succeed, so retrying it two more
        // ticks just delays the terminal park and wastes API calls).
        const nextAttempts = (Number(row.attempts) || 0) + 1;
        const terminal = outcome.permanent === true || nextAttempts >= MAX_ATTEMPTS;
        // A retry releases the claim back to 'pending' for the next tick.
        const res = await env.DB.prepare(
          `UPDATE commitment_checkins
              SET status = ?, attempts = ?, last_error = ?, lease_until = NULL
            WHERE id = ? AND ${ours.sql}`
        ).bind(terminal ? 'failed' : 'pending', nextAttempts, outcome.detail, row.checkin_id, ...ours.binds).run();
        // A failed send still counts toward the fail streak, answered or not.
        if (terminal) summary.failed++; else summary.retry++;
        if (terminal && changed(res)) leftPending = true;
      }
    } catch (err) {
      console.error('[checkins-cron] status update failed:', err && err.message);
    }

    // Once this occurrence is off the pending queue, keep a recurring
    // commitment's rhythm going by queuing the next one (idempotent no-op
    // otherwise). A materialize failure never aborts the batch.
    if (leftPending && !batchedNext) {
      try {
        if (await materializeNextOccurrence(env, row, now)) summary.materialized++;
      } catch (err) {
        console.error('[checkins-cron] materialize failed:', err && err.message);
      }
    }
  }

  await settleSuspects(env, tickSuspects, tickPushOk);
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

/**
 * The oldest a quiet push check-in may be and still earn its SMS escalation.
 * The escalation is the second, MORE intrusive knock on the same moment, so the
 * same "a passed moment is gone" logic that retires a late nudge
 * (`MAX_CHECKIN_LATENESS_MIN`, R-290) must bound the escalation too — otherwise a
 * recovered escalation-cron outage (the #74 crons-death class) would fire "still
 * haven't started the taxes you said you'd do at 2?" hours or days after the
 * moment passed: a stale nag, the exact opposite of the on-time ally the design
 * LAW requires. Deliberately mirrors the nudge threshold (independently tunable
 * here should the product later want a tighter escalation window); measured from
 * `delivered_at`, since the escalation's timeliness is relative to when the push
 * that it follows up actually landed.
 */
export const MAX_ESCALATION_LATENESS_MIN = MAX_CHECKIN_LATENESS_MIN;

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
export async function runEscalations(rawEnv, opts = {}) {
  const budget = opts.budget || makeTickBudget();
  const env = meterEnv(rawEnv, budget);
  const now = opts.now || new Date().toISOString();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : ESCALATION_LIMIT;
  const summary = { scanned: 0, escalated: 0, deferred: 0, skipped: 0, failed: 0, skipped_for_budget: 0 };

  const cutoff = new Date(new Date(now).getTime() - ESCALATION_DELAY_MIN * 60 * 1000).toISOString();
  // The far edge of the window: a push that has been quiet longer than this has
  // aged out — knocking now would nag about a gone moment (see
  // MAX_ESCALATION_LATENESS_MIN). It simply falls out of the scan and is never
  // escalated (it only gets older, so it can never re-enter the window), which
  // is the same silent, no-shame retirement a stale nudge gets — no latch or
  // failure count needed.
  const staleCutoff = new Date(new Date(now).getTime() - MAX_ESCALATION_LATENESS_MIN * 60 * 1000).toISOString();

  const quiet = await env.DB.prepare(
    `SELECT c.id AS checkin_id, c.commitment_id, c.user_id, c.delivered_at,
            m.title, m.persona, m.timezone AS commitment_timezone,
            COALESCE(ep.ceiling, 'text') AS ceiling,
            EXISTS (SELECT 1 FROM pro_purchases pp
                     WHERE pp.user_id = c.user_id AND pp.status = 'paid') AS is_pro
       FROM commitment_checkins c
       JOIN commitments m ON m.id = c.commitment_id
       LEFT JOIN escalation_prefs ep ON ep.user_id = c.user_id
      WHERE c.status = 'sent' AND c.channel = 'push'
        AND c.responded_at IS NULL AND c.escalated_at IS NULL
        AND c.delivered_at <= ?
        AND c.delivered_at >= ?
        AND m.status = 'active'
      ORDER BY c.delivered_at ASC
      LIMIT ?`
  ).bind(cutoff, staleCutoff, limit).all();

  const rows = (quiet && quiet.results) || [];
  for (const row of rows) {
    // FBQ-09: stop before a new row when the stage's budget ceiling is reached; the rest stay eligible.
    if (!budget.hasRoom('escalation')) { summary.skipped_for_budget = rows.length - summary.scanned; break; }
    summary.scanned++;

    let outcome = null;
    if (row.ceiling === 'none') {
      // CEILING (the wedge): the person set their ladder to "just the nudge" — it
      // is never allowed to climb to a text for them. Latch so it's never
      // rescanned. A chosen ceiling is not a failure — it counts as skipped.
      outcome = { status: 'skipped', detail: 'ceiling_none' };
    } else if (!Number(row.is_pro)) {
      // PRO (2026-10-01): the text follow-up is a FocusBro Pro feature. A free
      // person's EFFECTIVE ceiling is the push nudge alone, whatever they stored
      // (their 'text' choice is kept and starts working the moment Pro is on).
      // Latched like a chosen ceiling — a skip, never a failure. Checked BEFORE
      // the consent gate so a free person's phone is never even looked up.
      outcome = { status: 'skipped', detail: 'not_pro' };
    } else {
      // NIGHT GUARD (R-291) — the escalation is UNSCHEDULED, MORE intrusive
      // outreach: a second knock on a moment the person did NOT pick for this
      // instant (unlike the scheduled check-in at their chosen local_time). So,
      // exactly like the return nudge, it must be held out of the middle of the
      // night BY CONSTRUCTION. The TCPA quiet-hours gate below cannot be the only
      // night guard: it is opt-in, and a text-consented user who never set a
      // window has quiet_start === quiet_end → NO quiet hours — so a recovered
      // escalation-cron outage (the #74 crons-death class this file keeps citing)
      // could otherwise fire a 3am "still waiting on you" knock, the exact
      // trust-breaking intrusion the LAW forbids. Read the phone's jurisdiction
      // (the consent-row timezone — the SAME clock the quiet-hours gate uses) so
      // the structural and legal night guards can never disagree on "night"; fall
      // back to the commitment zone, then UTC. Outside the daytime window → defer
      // WITHOUT latching (escalated_at stays NULL) → eligible for a later daytime
      // tick, exactly like a quiet-hours defer and like the return nudge.
      const guardTz = await nightGuardTimezone(env, row.user_id, row.commitment_timezone);
      if (!withinUnscheduledDaytime(now, guardTz)) { summary.deferred++; continue; }

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
          // Speak in the coach's voice if this client has one — the escalation is
          // the same conversation's second knock, so it must not switch voices
          // mid-ladder. Self-directed clients are unchanged (own persona).
          const persona = await checkinVoice(env, row.user_id, row.persona);
          // Seed on the per-occurrence check-in id so a recurring commitment that
          // goes quiet each day rotates its escalation wording across days (never
          // the same wallpaper knock twice running), while this occurrence always
          // reads identically. Falls back to the commitment id if a check-in id is
          // somehow absent — mirrors deliverCheckin's nudge seeding.
          const message = `${escalationCopy({ title: row.title, persona, seed: row.checkin_id ?? row.commitment_id })}\n\n${checkinReplyHint(persona)}`;
          outcome = await deliverText(env, row, message);
        } catch (err) {
          outcome = { status: 'failed', detail: (err && err.message) || 'escalation_error' };
        }
      }
    }

    // One-shot latch, whatever happened: an escalation is offered exactly once.
    // FBQ-11b: `escalated_at` only says "never re-escalate"; whether a text
    // actually went out is `escalation_sent_at`, written in the SAME statement and
    // only on a successful send. The inbound reply match requires it, so a skipped
    // or failed escalation can never be answered by a stray "yes".
    try {
      await env.DB.prepare(
        `UPDATE commitment_checkins SET escalated_at = ?, escalation_sent_at = ? WHERE id = ?`
      ).bind(now, outcome.status === 'sent' ? now : null, row.checkin_id).run();
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
  // the newest APPLIED migration, read from d1_migrations on the tick (the
  // cron already touches D1) so /health can report it without touching D1
  schemaApplied: 'cron:schema_applied',
  // consecutive ticks where a stage threw inside its try/catch (FBQ-09). Separate
  // from failStreak: that one means "sends are failing" and drives delivery_degraded.
  stageErrorStreak: 'cron:stage_error_streak',
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
export async function recordCronHealth(env, { nowISO, delivery = {}, escalation = {}, returnNudges = null, budget = null, stageErrors = [], schemaApplied = null } = {}) {
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
    // FBQ-09: what the tick did NOT do is part of the summary (budget, per-stage
    // skipped_for_budget inside each stage object, stage_errors), so /health shows it.
    await kv.put(CRON_HEALTH_KEYS.lastSummary, JSON.stringify({
      at: now, delivery, escalation, return_nudges: returnNudges, budget, stage_errors: stageErrors,
    }));
  } catch { /* best-effort */ }
  // STAGE ERRORS get their OWN streak. fail_streak means "deliveries are failing"
  // and feeds delivery_degraded, which pages; a bug in the escalation SQL is not a
  // failed delivery, and folding it in would raise a false delivery outage and
  // change what the existing signal means. It must still be visible: a tick whose
  // stage threw bumps this streak, a clean tick resets it.
  try {
    const prev = Number(await kv.get(CRON_HEALTH_KEYS.stageErrorStreak)) || 0;
    await kv.put(CRON_HEALTH_KEYS.stageErrorStreak, String(stageErrors && stageErrors.length ? prev + 1 : 0));
  } catch { /* best-effort */ }
  if (schemaApplied) { try { await kv.put(CRON_HEALTH_KEYS.schemaApplied, String(schemaApplied)); } catch { /* best-effort */ } }
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
  let lastTick = null, failStreak = 0, stageErrorStreak = 0, lastSummary = null, schemaApplied = null;
  try { lastTick = kv ? await kv.get(CRON_HEALTH_KEYS.lastTick) : null; } catch { /* best-effort */ }
  try { schemaApplied = kv ? (await kv.get(CRON_HEALTH_KEYS.schemaApplied)) || null : null; } catch { /* best-effort */ }
  try { failStreak = kv ? (Number(await kv.get(CRON_HEALTH_KEYS.failStreak)) || 0) : 0; } catch { /* best-effort */ }
  try { stageErrorStreak = kv ? (Number(await kv.get(CRON_HEALTH_KEYS.stageErrorStreak)) || 0) : 0; } catch { /* best-effort */ }
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
    stage_error_streak: stageErrorStreak,
    last_summary: lastSummary,
    schema_applied: schemaApplied,
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
//   • exactly ONE nudge per dormancy EPISODE — a per-user D1 latch
//     (return_nudge_latch) holds the last nudge time; a user is eligible again
//     only once they've been active SINCE it (their last real event advances
//     past the latch), so a persistently-dormant person is never nudged twice.
//     Never a daily drip, never a nag. The scan excludes latched people IN SQL
//     (FBQ-07): a JS skip let 50 already-nudged people fill every batch forever.
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

/**
 * The retired (pre-FBQ-07) per-user KV latch key. The latch now lives in D1
 * (return_nudge_latch); account deletion still clears any legacy KV entry.
 */
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

/**
 * The escalation ladder's night guard reuses the SAME structural daytime window
 * as the return nudge. Both are UNSCHEDULED outreach the person did not ask for
 * at this instant (unlike a scheduled check-in at their chosen local_time), so
 * both must be held out of the middle of the night BY CONSTRUCTION — never left
 * to the opt-in TCPA quiet-hours gate alone. An alias, not a second copy, so the
 * two guards can never drift apart.
 */
export const withinUnscheduledDaytime = withinReturnDaytime;

/**
 * The timezone whose civil clock every night guard reads — the SAME clock the
 * TCPA quiet-hours gate uses, so the structural and legal night guards can never
 * disagree on what "night" is. The user's granted text-consent row wins (that IS
 * the phone's jurisdiction); fall back to the commitment's own zone, then UTC.
 * Best-effort: any DB error falls back to the commitment zone. One source for
 * both the escalation guard and the late-check-in guard so they never drift.
 * @param {object} env
 * @param {string} userId
 * @param {string} [commitmentTz]
 * @returns {Promise<string>}
 */
async function nightGuardTimezone(env, userId, commitmentTz) {
  try {
    const tzRow = await env.DB.prepare(
      `SELECT timezone FROM contact_consent WHERE user_id = ? AND channel = 'text' AND status = 'granted' LIMIT 1`,
    ).bind(userId).first();
    return (tzRow && tzRow.timezone) || commitmentTz || 'UTC';
  } catch {
    return commitmentTz || 'UTC';
  }
}

/**
 * Per-user latch write. datetime(?) stores the same 'YYYY-MM-DD HH:MM:SS' text
 * as analytics_events.created_at, so a return later the same UTC day compares
 * as later (FBQ-07 R2). Best-effort: a D1 blip never aborts the pass.
 */
async function latchReturnNudge(env, userId, nowISO) {
  try {
    await env.DB.prepare(
      `INSERT INTO return_nudge_latch (user_id, nudged_at) VALUES (?, datetime(?))
       ON CONFLICT(user_id) DO UPDATE SET nudged_at = excluded.nudged_at, retry_after = NULL`
    ).bind(userId, nowISO).run();
  } catch { /* best-effort */ }
}

/**
 * Hold a deferred return-nudge candidate out of the scan until `until` (FBQ-07b).
 * Writes only `retry_after`; a person never nudged gets a sentinel `nudged_at`
 * that can never satisfy the latch test, so the hold is NOT a latch and the
 * exactly-once-per-dormancy guarantee is untouched. A null `until` holds nothing
 * (the person stays scannable, as before). Best-effort, like the latch.
 */
async function holdReturnNudge(env, userId, until) {
  if (!until) return;
  try {
    await env.DB.prepare(
      `INSERT INTO return_nudge_latch (user_id, nudged_at, retry_after) VALUES (?, '1970-01-01 00:00:00', datetime(?))
       ON CONFLICT(user_id) DO UPDATE SET retry_after = excluded.retry_after`
    ).bind(userId, until).run();
  } catch { /* best-effort */ }
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
  const suspects = [];
  const results = await sendAll(env, list, payload);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok) anySent = true;
    else {
      lastErr = r.error || lastErr;
      if (r.suspect) suspects.push(list[i].endpoint);
      if (r.gone) {
        try {
          await env.DB.prepare(`UPDATE push_subscriptions SET is_active = 0 WHERE endpoint = ?`).bind(list[i].endpoint).run();
        } catch { /* non-fatal */ }
      }
    }
  }
  await settleSuspects(env, suspects, anySent);
  return anySent ? { status: 'sent', detail: 'push' } : { status: 'failed', detail: lastErr };
}

/**
 * Find people who have gone quiet across the whole app and send each ONE warm
 * return nudge. Idempotent per dormancy episode via the D1 latch; degrades
 * gracefully (no channel / no consent → parked, never crashes, never touches the
 * timer). Pure-ish: takes an env with a D1-shaped `DB` plus a clock, so the whole machine is unit-tested without a live DB or network.
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} [opts] { now?: ISO, limit?: number, quietDays?: number }
 * @returns {Promise<{scanned:number, nudged:number, deferred:number, skipped:number, failed:number}>}
 */
export async function runReturnNudges(rawEnv, opts = {}) {
  const budget = opts.budget || makeTickBudget();
  const env = meterEnv(rawEnv, budget);
  const now = opts.now || new Date().toISOString();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : RETURN_NUDGE_LIMIT;
  const quietDays = Number(opts.quietDays) > 0 ? Number(opts.quietDays) : RETURN_NUDGE_QUIET_DAYS;
  const summary = { scanned: 0, nudged: 0, deferred: 0, skipped: 0, failed: 0, skipped_for_budget: 0 };

  const cutoff = new Date(new Date(now).getTime() - quietDays * 24 * 60 * 60 * 1000).toISOString();

  // Dormant candidates: a real accountability user (has a commitment_created
  // event) whose most-recent event is older than the cutoff, with NOTHING
  // pending to reach them (so we never stack on the check-in / escalation ladder),
  // and NOT already nudged this episode (latch at/after their last event; their
  // return advances last_event_at past it and re-opens eligibility).
  // Cost (FBQ-07 R3): the people with a word come from idx_analytics_type_time,
  // then ONE index seek each for their latest event on idx_analytics_user_time —
  // linear in people, not quadratic in events. Every time is compared as
  // datetime() text, the format analytics_events.created_at is written in.
  const due = await env.DB.prepare(
    `WITH people AS (
       SELECT DISTINCT c.user_id AS user_id FROM analytics_events c
        WHERE c.event_type = 'commitment_created' AND c.user_id IS NOT NULL
     ), quiet AS (
       SELECT p.user_id AS user_id,
              (SELECT MAX(e.created_at) FROM analytics_events e WHERE e.user_id = p.user_id) AS last_event_at
         FROM people p
     )
     SELECT q.user_id AS user_id, q.last_event_at AS last_event_at
       FROM quiet q
      WHERE q.last_event_at <= datetime(?)
        AND NOT EXISTS (SELECT 1 FROM commitment_checkins ck
                     WHERE ck.user_id = q.user_id AND ck.status IN ('pending', 'sending'))
        AND NOT EXISTS (SELECT 1 FROM return_nudge_latch rn
                     WHERE rn.user_id = q.user_id
                       AND (rn.nudged_at >= q.last_event_at OR rn.retry_after > datetime(?)))
      ORDER BY q.last_event_at ASC
      LIMIT ?`
  ).bind(cutoff, now, limit).all();

  const rows = (due && due.results) || [];

  for (const row of rows) {
    if (!budget.hasRoom('return_nudge')) { summary.skipped_for_budget = rows.length - summary.scanned; break; }
    summary.scanned++;
    const userId = row.user_id;

    // Tone + local time come from their most recent commitment.
    const pref = await env.DB.prepare(
      `SELECT persona, timezone FROM commitments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).first();
    // A coached client hears their coach's voice welcoming them back — and, on
    // this fresh re-entry after days of silence, their coach's authored opening
    // LINE too. The return nudge is a natural re-entry greeting (unlike the
    // mid-conversation escalation knock, which stays voice-only — an opener there
    // would be redundant). Resolved once: the coach lends BOTH their voice and
    // their opener, or the person keeps their own tone with no opener. A
    // self-directed user is byte-for-byte unchanged. The stored line is
    // re-validated at read (safeCoachOpener) exactly as the first-nudge delivery
    // path does, so a shaming line planted out-of-band can never reach a
    // returning person — THE DESIGN LAW, enforced twice.
    const coach = await resolveCoachCheckin(env, userId);
    const persona = coach ? mapCoachPersona(coach.voice_persona) : pickPersona(pref && pref.persona);
    const opener = coach ? safeCoachOpener(coach.script) : '';
    const timezone = (pref && pref.timezone) || 'UTC';

    // Pick a reachable channel: push first (subscribed, no TCPA), else text if
    // consent was granted. No channel at all → nothing to reach them on. For a
    // text we also carry the consent row's timezone — the phone's jurisdiction —
    // because that, not the commitment zone, is the clock that locates the
    // recipient for the night guard below.
    let channel = null;
    let consentTimezone = null;
    const sub = await env.DB.prepare(
      `SELECT 1 FROM push_subscriptions WHERE user_id = ? AND is_active = 1 LIMIT 1`
    ).bind(userId).first();
    if (sub) channel = 'push';
    // PRO (2026-10-01): the text fallback is a Pro feature — a free person with
    // no push subscription is simply not reached (latched below, no SMS).
    else if (await isProUser(env, userId)) {
      const consented = await env.DB.prepare(
        `SELECT timezone FROM contact_consent WHERE user_id = ? AND channel = 'text' AND status = 'granted' LIMIT 1`
      ).bind(userId).first();
      if (consented) { channel = 'text'; consentTimezone = consented.timezone || null; }
    }

    if (!channel) {
      // Latch so we don't rescan every tick; resets naturally on their return.
      summary.skipped++;
      await latchReturnNudge(env, userId, now);
      continue;
    }

    // Seed the return copy on this dormancy EPISODE: the user id + the activity
    // timestamp that anchors it (`last_event_at`). Stable while they stay quiet
    // (one nudge per episode reads consistently), but different next episode
    // (their return advances `last_event_at`), so a repeat-returner never meets
    // the identical welcome-back line — the re-entry greeting sheds wallpaper
    // decay the same way the nudge and knock already do down the ladder.
    const nudge = returnNudgeCopy({ persona, seed: `${userId}:${row.last_event_at}` });
    const message = opener ? `${opener}\n\n${nudge}` : nudge;
    let outcome;
    // An UNSCHEDULED return outreach must never land in the middle of the night —
    // on ANY channel. This is the one moment the person didn't ask for (unlike a
    // scheduled check-in at their chosen local_time), so a 3am buzz is exactly the
    // trust-breaking intrusion the design LAW forbids. Push has always had this
    // structural floor; a text at 3am is even more intrusive, and the TCPA
    // quiet-hours gate below cannot be the only night guard because it is opt-in
    // (a text-consented user who never set a window has s === e → no quiet hours).
    // So gate BOTH channels on the daytime window first; outside it, defer without
    // latching (eligible for a later daytime tick). Text still passes its own TCPA
    // quiet-hours gate below as an additional, user-configurable narrowing.
    //
    // The night guard has to read the clock that actually locates the RECIPIENT.
    // For push that's the person's commitment timezone (a device they carry). For
    // text it's the phone's jurisdiction on the consent row — the SAME zone the
    // TCPA quiet-hours gate below uses — so the structural floor and the legal one
    // can never disagree on "night". Using the commitment zone for a text let a
    // consent-tz-3am SMS through whenever the two zones differed and quiet hours
    // were unset. Consent tz missing → fall back to the commitment zone (then UTC
    // inside withinReturnDaytime).
    const guardTimezone = channel === 'text' ? (consentTimezone || timezone) : timezone;
    if (!withinReturnDaytime(now, guardTimezone)) {
      // FBQ-07b: hold until the daytime window opens, so a night full of deferred people never fills the batch.
      await holdReturnNudge(env, userId, nextInstantWhere(now, (iso) => withinReturnDaytime(iso, guardTimezone)));
      summary.deferred++; continue;
    }
    if (channel === 'push') {
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
      if (gate.defer) { await holdReturnNudge(env, userId, gate.until); summary.deferred++; continue; }
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
    await latchReturnNudge(env, userId, now);

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
