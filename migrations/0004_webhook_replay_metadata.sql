-- Preserve the original signed delivery metadata for authorized replay.
-- ROLLBACK: NONE — SQLite/D1 cannot drop columns without a table rebuild.

ALTER TABLE webhook_inbox ADD COLUMN signature_ed25519 TEXT;
ALTER TABLE webhook_inbox ADD COLUMN signed_timestamp TEXT;
