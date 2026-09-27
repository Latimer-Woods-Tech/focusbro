-- A word without a password (activation): a visitor who types what they are
-- avoiding on the homepage can give the word immediately. The account is a
-- GUEST — a real users row (every FK still holds), a synthetic non-routable
-- address (RFC 2606 `.invalid`), an unknowable password hash — until the person
-- claims it with an email and a password (POST /auth/claim). Nothing about the
-- accountability mechanic changes; only the door does.
-- ROLLBACK: NONE — SQLite/D1 cannot drop a column without rebuilding a table.

ALTER TABLE users ADD COLUMN is_guest INTEGER DEFAULT 0;
CREATE INDEX idx_users_is_guest ON users(is_guest);
