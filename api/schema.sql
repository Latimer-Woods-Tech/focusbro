-- ════════════════════════════════════════════════════════════
-- FOCUSBRO CLOUDFLARE D1 DATABASE SCHEMA
-- Multi-device sync, user accounts, data backup
-- ════════════════════════════════════════════════════════════

-- ── USERS TABLE ──
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  avatar_url TEXT,
  phone TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME,
  email_verified_at DATETIME,
  subscription_tier TEXT DEFAULT 'free',
  is_active BOOLEAN DEFAULT 1
);

-- ── USER DATA BACKUPS (for version history) ──
CREATE TABLE IF NOT EXISTS user_data_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  snapshot_data TEXT NOT NULL,
  snapshot_size INTEGER,
  size_bytes INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user ON user_data_snapshots(user_id);

-- Create index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── DATA SYNC LOGS (track sync history) ──
CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT,
  action TEXT,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  data_size INTEGER,
  status TEXT DEFAULT 'success',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_user ON sync_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_timestamp ON sync_logs(synced_at);

-- ── API KEYS ──
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- ── AUDIT LOG (security & compliance) ──
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT DEFAULT 'success',
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);

-- ── SESSIONS TABLE (for multi-device tracking) ──
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  device_name TEXT,
  token TEXT NOT NULL,
  token_hash TEXT,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  is_active BOOLEAN DEFAULT 1,
  revoked_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash
  ON sessions(token_hash) WHERE token_hash IS NOT NULL;

-- ── SINGLE-USE ACCOUNT ACTION TOKENS ──
-- Only a SHA-256 digest is stored. A database read cannot recover a live link.
CREATE TABLE IF NOT EXISTS auth_action_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_action_user_purpose
  ON auth_action_tokens(user_id, purpose, created_at);

-- ── DEVICES TABLE (multi-device sync) ──
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_name TEXT,
  device_type TEXT DEFAULT 'web',
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_activity ON devices(last_activity);

-- ── FOCUS ANALYTICS + STREAKS ──
CREATE TABLE IF NOT EXISTS focus_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tool TEXT,
  duration_seconds INTEGER DEFAULT 0,
  data TEXT DEFAULT '{}',
  client_timestamp DATETIME NOT NULL,
  server_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_streaks (
  user_id TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_active_date TEXT,
  total_sessions INTEGER DEFAULT 0,
  total_focus_seconds INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_user_time ON focus_events(user_id, client_timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON focus_events(user_id, event_type);

-- ── ANALYTICS EVENTS TABLE (product metrics) ──
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT, -- nullable for privacy-minimal anonymous acquisition visits
  event_type TEXT NOT NULL,
  event_data TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  client_event_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_type_time ON analytics_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_user_time ON analytics_events(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_client_event ON analytics_events(user_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

-- ── DELIVERY + USER PREFERENCES ──
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id TEXT PRIMARY KEY,
  morning_motivation INTEGER DEFAULT 0,
  morning_time TEXT DEFAULT '08:00',
  break_reminders INTEGER DEFAULT 1,
  medication_reminders INTEGER DEFAULT 1,
  milestones INTEGER DEFAULT 1,
  custom_schedule TEXT DEFAULT '{}',
  timezone TEXT DEFAULT 'UTC',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS escalation_prefs (
  user_id TEXT PRIMARY KEY,
  ceiling TEXT DEFAULT 'text',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS focus_presence (
  client_id TEXT PRIMARY KEY,
  last_seen DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_prefs_user ON notification_prefs(user_id);
CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON focus_presence(last_seen);

-- ── INTEGRATIONS + FUTURE BILLING CONTRACT ──
CREATE TABLE IF NOT EXISTS slack_integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  webhook_url TEXT,
  access_token TEXT,
  team_id TEXT,
  channel_id TEXT,
  post_sessions INTEGER DEFAULT 1,
  update_presence INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  plan TEXT DEFAULT 'free',
  status TEXT DEFAULT 'active',
  current_period_end DATETIME,
  trial_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slack_user ON slack_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_stripe ON subscriptions(stripe_customer_id);

-- ── WEBHOOK INBOX (durable provider idempotency) ──
CREATE TABLE IF NOT EXISTS webhook_inbox (
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
  signature_ed25519 TEXT,
  signed_timestamp TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status_received
  ON webhook_inbox(status, received_at);

-- ════════════════════════════════════════════════════════════
-- ACCOUNTABILITY CORE  (Contender track — issue #10, Phase A)
-- "The bro who calls to make sure you did the thing."
-- Mechanic transplanted from wordis-bond: a parent "word given" (commitments,
-- cf. test_suites) + scheduled resolution rows with an outcome
-- (commitment_checkins, cf. test_runs) + kept-word streak tracking.
-- DESIGN LAW: never shame — accountability_streaks tracks kept words only;
-- there is deliberately NO miss counter.
-- ════════════════════════════════════════════════════════════

-- ── COMMITMENTS (the word you gave) ──
CREATE TABLE IF NOT EXISTS commitments (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  title            TEXT NOT NULL,
  details          TEXT DEFAULT '',
  start_at         DATETIME NOT NULL,          -- when you said you'd start
  checkin_at       DATETIME,                   -- when the bro checks back
  channel          TEXT DEFAULT 'push',        -- push | text  (voice = Phase B, engine-gated)
  persona          TEXT DEFAULT 'ally',        -- ally | hype  (both warm; never shame)
  timezone         TEXT DEFAULT 'UTC',
  recurrence       TEXT DEFAULT 'none',        -- none | daily | weekdays  (cadence; cf. wordis-bond scheduled runs)
  local_time       TEXT,                        -- HH:MM wall-clock in `timezone`; anchors each recurring occurrence (DST-correct)
  status           TEXT DEFAULT 'active',      -- active | kept | missed | rescheduled | released | paused | cancelled  (a recurring commitment stays 'active' unless paused)
  rescheduled_from TEXT,                        -- prior commitment id, if this is a no-shame retry
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── COMMITMENT CHECK-INS (each scheduled moment the bro shows up) ──
CREATE TABLE IF NOT EXISTS commitment_checkins (
  id            TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  scheduled_for DATETIME NOT NULL,
  channel       TEXT DEFAULT 'push',
  status        TEXT DEFAULT 'pending',        -- pending | sent | kept | missed | reschedule
  responded_at  DATETIME,
  note          TEXT DEFAULT '',
  delivered_at  DATETIME,
  attempts      INTEGER DEFAULT 0,
  last_error    TEXT,
  escalated_at  DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(commitment_id) REFERENCES commitments(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── KEPT-WORD STREAKS (no miss tally, by design) ──
CREATE TABLE IF NOT EXISTS accountability_streaks (
  user_id        TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  total_kept     INTEGER DEFAULT 0,
  last_kept_date TEXT,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_commitments_checkin_at ON commitments(checkin_at);
CREATE INDEX IF NOT EXISTS idx_checkins_commitment ON commitment_checkins(commitment_id);
CREATE INDEX IF NOT EXISTS idx_checkins_scheduled ON commitment_checkins(user_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_checkins_due ON commitment_checkins(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_checkins_escalation ON commitment_checkins(status, delivered_at);
-- Kept-word log: every word a user KEPT, newest first (GET /api/accountability/kept). Momentum-only.
CREATE INDEX IF NOT EXISTS idx_checkins_user_status ON commitment_checkins(user_id, status);

-- ── COACH ROSTER (skeleton coach dashboard — Contender #10, Phase A) ──
-- A consent-gated link between a coach (operator) and a client they support.
-- The coach sees the client's kept-word momentum only once status='active'
-- (the client accepted). Full white-label/wholesale billing is Phase C.
-- DESIGN LAW: this table carries no miss tally — a coach's view is momentum, not blame.
CREATE TABLE IF NOT EXISTS coach_clients (
  id             TEXT PRIMARY KEY,
  coach_user_id  TEXT NOT NULL,               -- the operator/coach
  client_user_id TEXT NOT NULL,               -- the person they support
  client_label   TEXT DEFAULT '',             -- coach's private label for the client
  status         TEXT DEFAULT 'pending',      -- pending | active | declined | removed
  invited_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  responded_at   DATETIME,                     -- when the client accepted/declined
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(coach_user_id, client_user_id),
  FOREIGN KEY(coach_user_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(client_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_coach_clients_coach ON coach_clients(coach_user_id, status);
CREATE INDEX IF NOT EXISTS idx_coach_clients_client ON coach_clients(client_user_id, status);

-- ── COACH NOTE-SHARING CONSENT ──
CREATE TABLE IF NOT EXISTS coach_note_consent (
  user_id TEXT PRIMARY KEY,
  shared INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── CONTACT CONSENT (TCPA consent-by-construction — Contender #10, Phase A) ──
-- Delivery-side consent state for TCPA-scoped channels (text now; voice = Phase B).
-- A text/voice check-in cannot be delivered unless a 'granted' row exists here.
-- Quiet hours (recipient-local whole hours) HOLD a due check-in inside the window.
-- A one-word STOP (app or inbound SMS) sets status='revoked' — durable + instant.
-- consent_text stores the exact disclosure the person agreed to (proof of consent).
-- NOTE: this is the app's enforcement copy; the org-wide durable consent ledger is
-- the shared CRM/consent schema (Foundry #2001), synced in the Phase B integration.
CREATE TABLE IF NOT EXISTS contact_consent (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  channel         TEXT NOT NULL,               -- text | voice
  status          TEXT DEFAULT 'granted',      -- granted | revoked
  consent_text    TEXT DEFAULT '',             -- exact disclosure agreed to
  consent_version TEXT DEFAULT '',
  phone           TEXT,                          -- number consent was captured for
  quiet_start     INTEGER,                       -- recipient-local hour [0..23], quiet window start
  quiet_end       INTEGER,                       -- recipient-local hour [0..23], quiet window end
  timezone        TEXT DEFAULT 'UTC',            -- IANA zone for quiet-hours math
  granted_at      DATETIME,
  revoked_at      DATETIME,
  revoke_source   TEXT,                          -- user | sms
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, channel),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_consent_user ON contact_consent(user_id, channel);

-- ── OPERATOR PLATFORM (Contender #10, Phase C · @latimer-woods-tech/operator) ──
-- Identity + operator→client hierarchy tables for the shared operator platform,
-- backed by D1 through the thin D1OperatorStore adapter (src/operator-store.js).
-- FocusBro mounts the hub instead of hand-rolling a coach hierarchy. The money
-- tables (price books / ledger / payouts) are intentionally absent — that is
-- Phase D (tiers & billing, founder-gated on Stripe live-mode).
CREATE TABLE IF NOT EXISTS operators (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  connect_account_id TEXT,
  charge_mode        TEXT NOT NULL DEFAULT 'direct',
  white_label        TEXT,
  default_currency   TEXT NOT NULL DEFAULT 'usd',
  metadata           TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operators_slug ON operators(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operators_connect_account ON operators(connect_account_id) WHERE connect_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operator_clients (
  id              TEXT PRIMARY KEY,
  operator_id     TEXT NOT NULL,
  external_org_id TEXT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  retail_override TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_operator_clients_operator ON operator_clients(operator_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_clients_external ON operator_clients(operator_id, external_org_id) WHERE external_org_id IS NOT NULL;

-- ── COACH ↔ OPERATOR MAP (Contender #10, Phase C) ──
-- Thin glue between a FocusBro user and their operator id; one row per coach.
-- NOT a second hierarchy — the hierarchy lives in operator_clients.
CREATE TABLE IF NOT EXISTS coach_operators (
  user_id     TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE
);

-- ── COACH CHECK-IN CONFIG (Contender #10, Phase C) ──
-- FocusBro-native: cadence, voice persona, and the opening line. The script is
-- anti-shame-validated at the write boundary before it is ever stored here.
CREATE TABLE IF NOT EXISTS coach_checkin_config (
  operator_id   TEXT PRIMARY KEY,
  cadence       TEXT NOT NULL,
  voice_persona TEXT NOT NULL,
  script        TEXT NOT NULL,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE
);
