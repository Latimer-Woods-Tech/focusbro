-- FBQ-05 R4 (focusbro#391): one OPEN occurrence per (word, instant).
-- materializeNextOccurrence (cron) and ensureNextOccurrence (app) were
-- check-then-insert, so both could queue tomorrow's occurrence: two nudges.
-- The index is PARTIAL on the open statuses, deliberately:
--   * pause cancels tomorrow's row at T and resume re-inserts T; the cancelled
--     row is outside the index, so the resume is not dropped;
--   * settled history (sent / kept / skipped / cancelled ...) may share an
--     instant with an open row and is never touched.
-- Inserts end with ON CONFLICT(...) WHERE status IN ('pending','sending') DO
-- NOTHING; re-pends go through rependCheckin, which merges onto an existing
-- open occurrence instead of colliding.
--
-- Step 1 resolves open duplicates already in the table, deterministically: the
-- lowest rowid (the oldest insert) stays open, every later twin is retired as
-- skipped / 'duplicate_occurrence'. Nothing is deleted. On a table with no
-- duplicates it changes zero rows, so the index creation below cannot fail.
--
-- ROLLBACK: the index is safe to leave in place under reverted code EXCEPT the
--           re-pend UPDATEs (snooze, "help me start", SMS "when?" reply) would
--           throw UNIQUE on a collision again. If the code is reverted, drop it:
--             DROP INDEX IF EXISTS idx_checkins_open_occurrence;
UPDATE commitment_checkins
   SET status = 'skipped', last_error = 'duplicate_occurrence', lease_until = NULL
 WHERE status IN ('pending', 'sending')
   AND EXISTS (SELECT 1 FROM commitment_checkins k
                WHERE k.commitment_id = commitment_checkins.commitment_id
                  AND k.scheduled_for = commitment_checkins.scheduled_for
                  AND k.status IN ('pending', 'sending')
                  AND k.rowid < commitment_checkins.rowid);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_open_occurrence
  ON commitment_checkins(commitment_id, scheduled_for)
  WHERE status IN ('pending', 'sending');
