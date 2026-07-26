-- Complete the sync persistence contract used by the Worker.  The original
-- production baseline omitted these fields even though the pre-migration
-- development schema and sync module require them.
-- ROLLBACK: NONE — SQLite/D1 cannot drop a column without rebuilding a table.

ALTER TABLE sync_logs ADD COLUMN data_size INTEGER;

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_name TEXT,
  device_type TEXT DEFAULT 'web',
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sync_logs_timestamp ON sync_logs(synced_at);
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_devices_last_activity ON devices(last_activity);
