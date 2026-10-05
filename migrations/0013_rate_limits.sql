-- FBQ-13 (focusbro#391): atomic rate limiting. The login, guest and register
-- limits lived in KV as read-then-write counters; KV is eventually consistent
-- and has no increment, so 40 concurrent POST /auth/guest all got 201 against a
-- limit of 10. One row per limiter key, spent with a single
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement (api/src/rate-limit.js),
-- which D1 serializes. Fixed window: reset_at is the unix second the current
-- window ends; a hit after it restarts the count at 1.
--
-- Keys hold SHA-256 hashes of the email / IP, never the raw values.
-- Additive: one new table and one index; nothing existing is touched.
-- ROLLBACK: revert the code (the pre-FBQ-13 code never reads this table), then
--           optionally: DROP TABLE IF EXISTS rate_limits;
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);
