-- FBQ-06 (focusbro#391): a check-in held back does not occupy the delivery batch.
-- runDueCheckins holds a due row for recipient quiet hours or the late-text
-- night guard WITHOUT claiming it (FBQ-05). Before this the held row kept its
-- old scheduled_for, sorted first on every tick and filled the 100-row batch at
-- 2-3 queries each, so one due push behind 105 held texts waited the whole quiet
-- window. A held row now records next_attempt_at (the ISO-8601 UTC instant the
-- hold ends, same format as scheduled_for) and the scan skips it until then.
-- Every writer that re-pends a row clears it (rependCheckin, the lease sweep,
-- the claim, a consent save).
--
-- The index serves the scan exactly: rows keyed by status, then the instant they
-- become eligible, so a held row is not even read before its hold ends and the
-- ORDER BY needs no sort. (Composite, not partial: without ANALYZE stats SQLite
-- chose idx_checkins_due over a partial expression index; this one it picks
-- on an empty table too — checked with EXPLAIN QUERY PLAN.)
--
-- Additive: one nullable column (NULL on every existing row; no row rewritten)
-- and one index.
-- ROLLBACK: revert the code. Column and index are safe to leave in place; the
--           pre-FBQ-06 code never reads the column. To remove the index anyway:
--             DROP INDEX IF EXISTS idx_checkins_eligible;
ALTER TABLE commitment_checkins ADD COLUMN next_attempt_at TEXT;

CREATE INDEX IF NOT EXISTS idx_checkins_eligible
  ON commitment_checkins(status, COALESCE(next_attempt_at, scheduled_for));
