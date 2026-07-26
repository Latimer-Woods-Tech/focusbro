-- Durable, provider-idempotent webhook receipt ledger.
-- ROLLBACK: DROP INDEX idx_webhook_inbox_status_received; DROP TABLE webhook_inbox;

CREATE TABLE webhook_inbox (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at DATETIME,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'completed', 'failed')),
  raw_payload TEXT NOT NULL,
  processing_started_at DATETIME,
  completed_at DATETIME,
  failed_at DATETIME,
  last_error TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX idx_webhook_inbox_status_received
  ON webhook_inbox(status, received_at);
