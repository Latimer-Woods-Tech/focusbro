// ════════════════════════════════════════════════════════════
// FOCUSBRO — ACCOUNTABILITY INSTRUMENTATION  (Contender #10, Phase A · R-235)
// ════════════════════════════════════════════════════════════
// "Prove the accountability loop retains" (docs/IMPROVEMENT_PLAN.md, L1) is the
// binding constraint of the whole product: the voice-call moat is unjustified,
// and the coach pitch unsellable, until the loop's real signals are measured.
// This is that measurement layer — first-party, D1-native (NOT the Neon-backed
// @latimer-woods-tech/analytics package; FocusBro is D1-only per CLAUDE.md).
//
// It records the loop's own lifecycle transitions — a word given, a word kept,
// a no-shame reschedule, a word set down, a check-in delivered — into a single
// first-party `analytics_events` table (the same table billing.js and sync.js
// already write to, which until now was never CREATE'd, so those writes were
// silently failing). `computeLoopMetrics()` reads them back into the numbers the
// founder/coach pitch needs: kept-word rate, reschedule rate, active + returning
// users, counts by type.
//
// DESIGN LAW carries through even here: these events are an internal, positive
// record. "reschedule" is counted as a protected outcome, never a "miss" score;
// nothing user-facing is emitted from this module, and no copy is generated. A
// missed check-in is counted only so the kept-word RATE is honest — it is never
// surfaced to a person as a tally.
//
// Worker-safe + non-fatal by construction: recordEvent() swallows its own errors
// so instrumentation can NEVER break a commitment resolve, a delivery, or a
// timer. It is a leaf module (no imports) so accountability.js, checkins-cron.js,
// and index.js can all consume it without a cycle.
// ════════════════════════════════════════════════════════════

/** Canonical event-type names for the accountability loop. */
export const EVENTS = Object.freeze({
  COMMITMENT_CREATED: 'commitment_created',
  COMMITMENT_KEPT: 'commitment_kept',
  COMMITMENT_RESCHEDULE: 'commitment_reschedule',
  COMMITMENT_MISSED: 'commitment_missed',
  COMMITMENT_RELEASED: 'commitment_released',
  CHECKIN_DELIVERED: 'checkin_delivered',
});

/** Map a check-in outcome to its event type (or null if it isn't one we log). */
export function outcomeEvent(outcome) {
  if (outcome === 'kept') return EVENTS.COMMITMENT_KEPT;
  if (outcome === 'reschedule' || outcome === 'rescheduled') return EVENTS.COMMITMENT_RESCHEDULE;
  if (outcome === 'missed') return EVENTS.COMMITMENT_MISSED;
  return null;
}

/**
 * Record a first-party accountability event. NON-FATAL by design: any failure
 * (missing table on a cold path, malformed data) is swallowed with a warning so
 * instrumentation can never break the flow it observes.
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} p    { userId?, type, data? }
 * @returns {Promise<boolean>} true iff the row was written.
 */
export async function recordEvent(env, { userId = null, type, data = {} } = {}) {
  if (!env || !env.DB || !type) return false;
  try {
    let payload = '{}';
    try { payload = JSON.stringify(data == null ? {} : data); } catch { payload = '{}'; }
    await env.DB.prepare(
      `INSERT INTO analytics_events (user_id, event_type, event_data, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).bind(userId, String(type), payload).run();
    return true;
  } catch (err) {
    console.warn('[events] recordEvent failed:', err && err.message);
    return false;
  }
}

/** Clamp a "since N days" window to a sane range (default 7, 1..90). */
export function clampSinceDays(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 7;
  if (v > 90) return 90;
  return v;
}

/**
 * Compute the accountability loop's retention/health metrics over a window.
 * Reads only the first-party `analytics_events` rows this module writes.
 *
 * kept_word_rate is kept / (kept + reschedule + missed) — reschedule counts in
 * the denominator (a word that moved was not kept THIS time) but is never itself
 * a "miss"; the rate exists so the founder/coach number is honest, not to shame.
 *
 * returning_users counts distinct users seen on ≥2 distinct UTC days in the
 * window — a simple, dependency-free retention signal (the real D1/D7 cohort
 * math lands once session events are instrumented; see IMPROVEMENT_PLAN L1).
 *
 * @param {object} env
 * @param {object} [opts] { sinceDays?, nowISO? }
 * @returns {Promise<object>} metrics summary (see shape below)
 */
export async function computeLoopMetrics(env, opts = {}) {
  const sinceDays = clampSinceDays(opts.sinceDays);
  const now = opts.nowISO ? new Date(opts.nowISO) : new Date();
  const sinceISO = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const empty = {
    window: { since: sinceISO, until: now.toISOString(), days: sinceDays },
    by_type: {},
    totals: {
      commitments_created: 0, checkins_delivered: 0,
      commitments_kept: 0, commitments_reschedule: 0, commitments_missed: 0,
      commitments_released: 0,
    },
    resolved: 0,
    kept_word_rate: null,
    reschedule_rate: null,
    active_users: 0,
    returning_users: 0,
  };

  // Counts by type in the window.
  const byTypeRows = await env.DB.prepare(
    `SELECT event_type, COUNT(*) AS n
       FROM analytics_events
      WHERE created_at >= ?
      GROUP BY event_type`
  ).bind(sinceISO).all();

  const by_type = {};
  for (const r of (byTypeRows && byTypeRows.results) || []) {
    by_type[r.event_type] = Number(r.n) || 0;
  }

  const totals = {
    commitments_created: by_type[EVENTS.COMMITMENT_CREATED] || 0,
    checkins_delivered: by_type[EVENTS.CHECKIN_DELIVERED] || 0,
    commitments_kept: by_type[EVENTS.COMMITMENT_KEPT] || 0,
    commitments_reschedule: by_type[EVENTS.COMMITMENT_RESCHEDULE] || 0,
    commitments_missed: by_type[EVENTS.COMMITMENT_MISSED] || 0,
    commitments_released: by_type[EVENTS.COMMITMENT_RELEASED] || 0,
  };

  const resolved = totals.commitments_kept + totals.commitments_reschedule + totals.commitments_missed;
  const kept_word_rate = resolved > 0 ? round2(totals.commitments_kept / resolved) : null;
  const reschedule_rate = resolved > 0 ? round2(totals.commitments_reschedule / resolved) : null;

  // Distinct active users in the window.
  const activeRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n
       FROM analytics_events
      WHERE created_at >= ? AND user_id IS NOT NULL`
  ).bind(sinceISO).first();
  const active_users = (activeRow && Number(activeRow.n)) || 0;

  // Returning users: seen on ≥2 distinct UTC days in the window.
  const returningRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT user_id
         FROM analytics_events
        WHERE created_at >= ? AND user_id IS NOT NULL
        GROUP BY user_id
       HAVING COUNT(DISTINCT substr(created_at, 1, 10)) >= 2
     )`
  ).bind(sinceISO).first();
  const returning_users = (returningRow && Number(returningRow.n)) || 0;

  return {
    ...empty,
    by_type,
    totals,
    resolved,
    kept_word_rate,
    reschedule_rate,
    active_users,
    returning_users,
  };
}

/** Round to 2 decimals without floating-point surprises. */
function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}
