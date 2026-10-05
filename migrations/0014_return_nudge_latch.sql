-- FBQ-07 (focusbro#391): the return nudge reaches newly dormant people.
-- The "already reached out this quiet spell" latch lived in KV, so the scan could
-- only skip latched people in JavaScript AFTER taking the 50 longest-quiet ones;
-- 50 already-nudged people then filled every batch forever. The latch moves to
-- D1 so the scan excludes those people in SQL. `nudged_at` is written with
-- datetime() — the same 'YYYY-MM-DD HH:MM:SS' text as analytics_events.created_at
-- — so a return later the same UTC day compares as later (the ISO latch did not).
--
-- Backfill: everyone who was SENT a nudge keeps their latch (their latest
-- return_nudge_sent), so nobody already reached this spell is reached again on
-- deploy. KV latches for a skipped/failed attempt are not carried over: those
-- people are scanned once more (no channel → latched again, nothing sent).
--
-- Additive: one new table, keyed by user (the primary key is the lookup index).
-- ROLLBACK: revert the code; the pre-FBQ-07 code never reads this table.
--           To remove it anyway: DROP TABLE IF EXISTS return_nudge_latch;
CREATE TABLE IF NOT EXISTS return_nudge_latch (
  user_id TEXT PRIMARY KEY,
  nudged_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT OR REPLACE INTO return_nudge_latch (user_id, nudged_at)
SELECT n.user_id, MAX(n.created_at)
  FROM (SELECT CASE WHEN json_valid(event_data) THEN json_extract(event_data, '$.user_id') END AS user_id,
               created_at
          FROM analytics_events
         WHERE event_type = 'return_nudge_sent') n
 WHERE n.user_id IN (SELECT id FROM users)
 GROUP BY n.user_id;
