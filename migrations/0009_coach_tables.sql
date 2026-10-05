-- FBQ-10 (focusbro#391): the coach tables, from a migration at last.
-- `operators`, `operator_clients`, `coach_operators` and `coach_checkin_config`
-- were created only by `initializeDatabase` in api/src/index.js, which nothing
-- calls, and no migration created them — production's sqlite_master (read
-- 2026-10-05) listed none of the four, so coach onboarding, the roster's
-- coach_operators lookup and the cron's coach-voice JOIN could not work.
-- These statements match the runtime definitions exactly (columns, types,
-- defaults, constraints, foreign keys, indexes); coach-tables-migration.test.js
-- compares the two. Additive and idempotent: IF NOT EXISTS throughout, so a
-- database that already holds the tables applies this cleanly and keeps its rows.
-- ROLLBACK: safe to leave in place (a code revert leaves valid, unused tables).
--           Only if they must go, and only while empty:
--           DROP TABLE coach_checkin_config; DROP TABLE coach_operators;
--           DROP TABLE operator_clients; DROP TABLE operators;

-- ── OPERATOR PLATFORM (@latimer-woods-tech/operator, via src/operator-store.js) ──
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  connect_account_id TEXT,
  charge_mode TEXT NOT NULL DEFAULT 'direct',
  white_label TEXT,
  default_currency TEXT NOT NULL DEFAULT 'usd',
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operators_slug ON operators(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operators_connect_account
  ON operators(connect_account_id) WHERE connect_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operator_clients (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  external_org_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  retail_override TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_operator_clients_operator ON operator_clients(operator_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_clients_external
  ON operator_clients(operator_id, external_org_id) WHERE external_org_id IS NOT NULL;

-- ── COACH ↔ OPERATOR MAP: one row per coach; the hierarchy lives in operator_clients ──
CREATE TABLE IF NOT EXISTS coach_operators (
  user_id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE
);

-- ── COACH CHECK-IN CONFIG: cadence, voice persona, opening line ──
CREATE TABLE IF NOT EXISTS coach_checkin_config (
  operator_id TEXT PRIMARY KEY,
  cadence TEXT NOT NULL,
  voice_persona TEXT NOT NULL,
  script TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE
);
