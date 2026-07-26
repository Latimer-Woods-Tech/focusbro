-- Give every persisted sync snapshot a concurrency revision and make retries
-- idempotent per user. Existing snapshots use their stable primary key as the
-- initial revision so clients can safely begin conditional writes after upgrade.
-- ROLLBACK: NONE — SQLite/D1 cannot drop columns or indexes without a table rebuild.

ALTER TABLE user_data_snapshots ADD COLUMN revision_id TEXT;
ALTER TABLE user_data_snapshots ADD COLUMN idempotency_key TEXT;

UPDATE user_data_snapshots
SET revision_id = id
WHERE revision_id IS NULL;

CREATE UNIQUE INDEX idx_snapshots_user_revision
  ON user_data_snapshots(user_id, revision_id);

CREATE UNIQUE INDEX idx_snapshots_user_idempotency
  ON user_data_snapshots(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
