-- FBQ-26a (focusbro#391). Two additive indexes so the cron's expiry purge is an
-- index range scan, not a full scan of sessions / auth_action_tokens every minute.
-- No column, table or data change.
--
-- ROLLBACK: revert the code (the purge simply stops); the indexes are harmless.
--           To remove them anyway: DROP INDEX IF EXISTS idx_sessions_expires;
--           DROP INDEX IF EXISTS idx_auth_action_expires;
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_action_expires ON auth_action_tokens(expires_at);
