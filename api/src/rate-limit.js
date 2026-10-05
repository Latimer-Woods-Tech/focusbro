// FBQ-13 (focusbro#391): atomic, D1-backed fixed-window rate limiting.
//
// KV cannot increment atomically (it is eventually consistent; a get-then-put
// let 40 concurrent guest creates through a 10-per-IP limit). Here every spend
// is ONE statement — INSERT ... ON CONFLICT DO UPDATE ... RETURNING — which D1
// serializes, so N concurrent spends see the counts 1..N exactly once each.
// Schema: migrations/0013_rate_limits.sql. Keys are hashes, never raw emails/IPs.

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Spend one unit from each key's window and return each key's count AFTER the
 * spend ({ [key]: { count, resetAt } }). A key whose window has ended restarts at 1.
 */
export async function spendLimits(env, keys, windowSeconds) {
  const now = nowSeconds();
  const rows = keys.map((_, i) => `(?${i + 3}, 1, ?1 + ?2)`).join(', ');
  const { results } = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES ${rows}
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ?1 THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ?1 THEN excluded.reset_at ELSE rate_limits.reset_at END
     RETURNING key, count, reset_at`,
  ).bind(now, windowSeconds, ...keys).all();
  // Opportunistic sweep of long-dead windows (~1% of spends) keeps the table small.
  if (Math.random() < 0.01) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now - 86400).run();
  }
  return Object.fromEntries(results.map((r) => [r.key, { count: Number(r.count), resetAt: Number(r.reset_at) }]));
}

/** Give back one unit on each key (a spend that turned out not to count). */
export async function refundLimit(env, keys) {
  await env.DB.prepare(
    `UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE key IN (${keys.map(() => '?').join(', ')})`,
  ).bind(...keys).run();
}

/** Forget every window whose key equals `key` or starts with `key + ':'`. */
export async function clearLimits(env, key) {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?1 OR key LIKE ?1 || ':%'").bind(key).run();
}

/** Seconds until the latest of the given windows ends (for Retry-After). */
export const retryAfterSeconds = (resetAts) => Math.max(1, Math.max(...resetAts) - nowSeconds());
