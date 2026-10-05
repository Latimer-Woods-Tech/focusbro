// ════════════════════════════════════════════════════════════
// RETENTION PURGE (FBQ-26a, focusbro#391) — rows that are dead are deleted.
// ════════════════════════════════════════════════════════════
// Nothing deleted expired sessions, spent or expired auth tokens, or old
// analytics events, so all three grew for ever. The cron now sweeps them, a
// bounded slice per tick (PURGE_BATCH rows per table, 3 D1 calls per tick), so a
// big backlog drains over minutes and one tick never does unbounded work.
//
//   sessions           expires_at older than SESSION_GRACE. A session is refreshable
//                      for 5 minutes past expiry (index.js), so the grace is wider
//                      than that: a live credential is never touched.
//   auth_action_tokens expires_at older than TOKEN_GRACE. Past expiry a token can
//                      neither be redeemed nor replayed; a consumed one that is
//                      still unexpired is kept until it expires (replay protection).
//   analytics_events   older than ANALYTICS_RETENTION_DAYS — an env var. docs/RETENTION.md
//                      states NO period for analytics events, and none is invented
//                      here: unset (or below the floor) means analytics is NOT purged.
//
// A purge failure is isolated by the caller and never blocks check-in delivery.

/** Rows deleted per table per tick. */
export const PURGE_BATCH = 500;
/** Expired sessions are kept this long past expiry (the refresh window is 5 minutes). */
export const SESSION_GRACE = '-1 day';
/** Expired auth tokens are kept this long past expiry. */
export const TOKEN_GRACE = '-1 day';
/** Below this the env override is ignored: return-nudge and cohort metrics read recent events. */
export const MIN_ANALYTICS_RETENTION_DAYS = 30;

/** Parsed ANALYTICS_RETENTION_DAYS, or null when unset / not a whole number >= the floor. */
export function analyticsRetentionDays(env) {
  const raw = env && env.ANALYTICS_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_ANALYTICS_RETENTION_DAYS ? n : null;
}

const changes = (r) => (r && r.meta && Number.isFinite(r.meta.changes) ? r.meta.changes : 0);

/**
 * Delete one bounded slice of dead rows from each table.
 * @param {object} env  needs `DB`; optional `ANALYTICS_RETENTION_DAYS`
 * @param {{batch?: number}} [opts]
 * @returns {Promise<{sessions:number, tokens:number, analytics:number, calls:number}>}
 */
export async function runRetentionPurge(env, { batch = PURGE_BATCH } = {}) {
  const out = { sessions: 0, tokens: 0, analytics: 0, calls: 0 };
  const del = async (sql, ...binds) => {
    out.calls++;
    return changes(await env.DB.prepare(sql).bind(...binds).run());
  };
  out.sessions = await del(
    `DELETE FROM sessions WHERE id IN (
       SELECT id FROM sessions WHERE expires_at < datetime('now', ?1) LIMIT ?2)`,
    SESSION_GRACE, batch);
  out.tokens = await del(
    `DELETE FROM auth_action_tokens WHERE id IN (
       SELECT id FROM auth_action_tokens WHERE expires_at < datetime('now', ?1) LIMIT ?2)`,
    TOKEN_GRACE, batch);
  const days = analyticsRetentionDays(env);
  if (days !== null) {
    out.analytics = await del(
      `DELETE FROM analytics_events WHERE id IN (
         SELECT id FROM analytics_events WHERE created_at < datetime('now', ?1) LIMIT ?2)`,
      `-${days} days`, batch);
  }
  return out;
}
