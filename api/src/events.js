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
 * Normalize a caller-supplied event time to SQLite's `datetime()` shape
 * (`YYYY-MM-DD HH:MM:SS`, UTC), matching the format `datetime('now')` writes so
 * the cohort day-extraction (`substr(created_at,1,10)`) is consistent across
 * rows. Returns null for a missing or unparseable value (caller falls back to
 * server time).
 *
 * @param {string|number|Date|null} at
 * @returns {string|null}
 */
function normalizeEventTime(at) {
  if (at === null || at === undefined || at === '') return null;
  const d = at instanceof Date ? at : new Date(at);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Record a first-party accountability event. NON-FATAL by design: any failure
 * (missing table on a cold path, malformed data) is swallowed with a warning so
 * instrumentation can never break the flow it observes.
 *
 * `at` lets a caller preserve WHEN the event actually happened (e.g. a
 * client-timestamped focus session synced to the server later) so the retention
 * cohort reflects the real day, not the sync day; omit it for server-time
 * events. An unparseable `at` degrades to server time rather than dropping the row.
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} p    { userId?, type, data?, at? }
 * @returns {Promise<boolean>} true iff the row was written.
 */
export async function recordEvent(env, { userId = null, type, data = {}, at = null } = {}) {
  if (!env || !env.DB || !type) return false;
  try {
    let payload = '{}';
    try { payload = JSON.stringify(data == null ? {} : data); } catch { payload = '{}'; }
    const createdAt = normalizeEventTime(at);
    if (createdAt) {
      await env.DB.prepare(
        `INSERT INTO analytics_events (user_id, event_type, event_data, created_at)
         VALUES (?, ?, ?, ?)`
      ).bind(userId, String(type), payload, createdAt).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO analytics_events (user_id, event_type, event_data, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(userId, String(type), payload).run();
    }
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
 * Compute D1 / D7 return-cohort retention over the whole first-party event
 * history — the "retention half" of L1 (docs/IMPROVEMENT_PLAN.md), the number
 * the coach pitch and the voice-moat thesis are both unprovable without. This
 * is engine-independent: it reads only `analytics_events`, so it measures every
 * signal that lands there — today the commitment lifecycle only. (R-239 aimed to
 * bridge free-tier timer usage in via a `/events` ingest route, but that route
 * lived in the never-mounted extended-routes.js monolith — removed in #44 — and
 * the shipped client emits no timer telemetry at all, so the bridge was inert
 * end-to-end. Landing it for real needs a client emitter + live ingest route,
 * honoring the browser-first privacy copy; see the R-239 follow-up on #10.)
 *
 * DEFINITION — rolling return, not day-exact. A user's cohort is the UTC day of
 * their *first-ever* event. They "returned by DN" if they have ANY event on a
 * later UTC day within N days of that first day. Rolling (rather than active
 * *on* day N exactly) is the honest choice for a small dogfood/early cohort:
 * "did the bro get them to come back at all within the first day / week", which
 * is the retention question the pitch actually asks. A user is only *eligible*
 * for a DN rate once N days have elapsed since their first day (so a brand-new
 * user can never drag the rate down before they've had the chance to return).
 *
 * DESIGN LAW: retention is a positive, internal record. Not returning is never
 * a per-person tally or a shame surface — it only shapes an aggregate rate, and
 * nothing user-facing is emitted here.
 *
 * @param {object} env  Worker env with a D1-shaped `DB`
 * @param {object} [opts] { nowISO? }
 * @returns {Promise<object>} { d1: {eligible, returned, rate}, d7: {...}, new_users_7d }
 */
export async function computeReturnCohorts(env, opts = {}) {
  const now = opts.nowISO ? new Date(opts.nowISO) : new Date();
  const nowDay = now.toISOString().slice(0, 10); // UTC YYYY-MM-DD

  const empty = {
    d1: { eligible: 0, returned: 0, rate: null },
    d7: { eligible: 0, returned: 0, rate: null },
    new_users_7d: 0,
  };
  if (!env || !env.DB) return empty;

  // One pass: per user, their first-ever UTC day + whether they came back within
  // 1 and 7 days of it. Then fold into eligible/returned counts, gating each DN
  // rate on N full days having elapsed since the user's first day.
  const row = await env.DB.prepare(
    `WITH firsts AS (
       SELECT user_id, MIN(substr(created_at, 1, 10)) AS first_day
         FROM analytics_events
        WHERE user_id IS NOT NULL
        GROUP BY user_id
     ),
     rets AS (
       SELECT f.user_id, f.first_day,
         MAX(CASE WHEN substr(e.created_at, 1, 10) > f.first_day
                   AND substr(e.created_at, 1, 10) <= date(f.first_day, '+1 day')
                  THEN 1 ELSE 0 END) AS ret_d1,
         MAX(CASE WHEN substr(e.created_at, 1, 10) > f.first_day
                   AND substr(e.created_at, 1, 10) <= date(f.first_day, '+7 day')
                  THEN 1 ELSE 0 END) AS ret_d7
         FROM firsts f
         JOIN analytics_events e ON e.user_id = f.user_id
        GROUP BY f.user_id, f.first_day
     )
     SELECT
       SUM(CASE WHEN first_day <= date(?1, '-1 day') THEN 1 ELSE 0 END) AS d1_eligible,
       SUM(CASE WHEN first_day <= date(?1, '-1 day') THEN ret_d1 ELSE 0 END) AS d1_returned,
       SUM(CASE WHEN first_day <= date(?1, '-7 day') THEN 1 ELSE 0 END) AS d7_eligible,
       SUM(CASE WHEN first_day <= date(?1, '-7 day') THEN ret_d7 ELSE 0 END) AS d7_returned,
       SUM(CASE WHEN first_day >= date(?1, '-7 day') THEN 1 ELSE 0 END) AS new_users_7d
       FROM rets`
  ).bind(nowDay).first();

  if (!row) return empty;
  const d1e = Number(row.d1_eligible) || 0;
  const d1r = Number(row.d1_returned) || 0;
  const d7e = Number(row.d7_eligible) || 0;
  const d7r = Number(row.d7_returned) || 0;
  return {
    d1: { eligible: d1e, returned: d1r, rate: d1e > 0 ? round2(d1r / d1e) : null },
    d7: { eligible: d7e, returned: d7r, rate: d7e > 0 ? round2(d7r / d7e) : null },
    new_users_7d: Number(row.new_users_7d) || 0,
  };
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
 * window — a simple, dependency-free in-window retention signal. The stricter
 * cohort view (D1/D7 rolling return, whole-history) is attached under
 * `retention` via computeReturnCohorts(); see IMPROVEMENT_PLAN L1.
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
    retention: {
      d1: { eligible: 0, returned: 0, rate: null },
      d7: { eligible: 0, returned: 0, rate: null },
      new_users_7d: 0,
    },
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

  // D1/D7 return-cohort retention (whole-history, not window-bounded). Non-fatal:
  // a cohort-query failure must never take down the rest of the metrics summary.
  let retention = empty.retention;
  try {
    retention = await computeReturnCohorts(env, { nowISO: now.toISOString() });
  } catch (err) {
    console.warn('[events] computeReturnCohorts failed:', err && err.message);
  }

  return {
    ...empty,
    by_type,
    totals,
    resolved,
    kept_word_rate,
    reschedule_rate,
    active_users,
    returning_users,
    retention,
  };
}

/** Round to 2 decimals without floating-point surprises. */
function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}
