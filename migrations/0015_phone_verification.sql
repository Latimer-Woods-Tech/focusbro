-- FBQ-12 (focusbro#391): texts go only to a VERIFIED, UNIQUE number.
-- POST /api/consent stored any number a person typed as granted with no code
-- sent to it, and the inbound handler took `SELECT id FROM users WHERE phone = ?`
-- .first() — an arbitrary account when two share a number. Now a number is usable
-- for texts only once a one-time code sent to it is confirmed (phone_verified_at),
-- and a verified number belongs to exactly one account (partial unique index).
--
-- Existing numbers stay UNVERIFIED (phone_verified_at NULL) until confirmed: their
-- check-ins fall back to push and no text goes out. Nobody is texted by this deploy.
--
-- phone_verifications holds at most ONE pending code per user: a keyed HMAC of
-- the code (never the code), the number it was sent to, an expiry (unix s) and a
-- wrong-guess counter. It is deleted on success, expiry-replacement or lockout.
--
-- Additive: one nullable column, one partial unique index, one new table.
-- ROLLBACK: revert the code (pre-FBQ-12 code ignores all three); optionally
--   DROP INDEX IF EXISTS idx_users_phone_verified_unique;
--   DROP TABLE IF EXISTS phone_verifications;
--   (the column may stay; SQLite ALTER DROP COLUMN is unnecessary for rollback.)
ALTER TABLE users ADD COLUMN phone_verified_at DATETIME;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_verified_unique
  ON users(phone) WHERE phone_verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS phone_verifications (
  user_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
