-- FocusBro's production schema as inventoried on 2026-07-26.
--
-- This is a bootstrap migration for databases created after migrations were
-- introduced. The pre-existing production database was created by the Worker
-- before it had a migration ledger, so its ledger is baselined separately
-- after the same schema is verified. Keep the two historic migrations below
-- this one in sequence: 0001 creates auth_action_tokens and 0002 adds
-- users.email_verified_at.
--
-- ROLLBACK: NONE — this establishes the initial production-compatible schema.

PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  avatar_url TEXT,
  subscription_tier TEXT DEFAULT 'free',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME,
  is_active INTEGER DEFAULT 1,
  phone TEXT
);

CREATE TABLE user_data_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL,
  snapshot_data TEXT NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sync_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL,
  device_id TEXT,
  action TEXT,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending',
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL,
  device_id TEXT,
  device_name TEXT,
  token TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  is_active INTEGER DEFAULT 1,
  token_hash TEXT,
  revoked_at DATETIME,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE focus_events (
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

CREATE TABLE user_streaks (
  user_id TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_active_date TEXT,
  total_sessions INTEGER DEFAULT 0,
  total_focus_seconds INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE push_subscriptions (
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

CREATE TABLE notification_prefs (
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

CREATE TABLE slack_integrations (
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

CREATE TABLE subscriptions (
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

CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT DEFAULT '',
  start_at DATETIME NOT NULL,
  checkin_at DATETIME,
  channel TEXT DEFAULT 'push',
  persona TEXT DEFAULT 'ally',
  timezone TEXT DEFAULT 'UTC',
  status TEXT DEFAULT 'active',
  rescheduled_from TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  recurrence TEXT DEFAULT 'none',
  local_time TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE commitment_checkins (
  id TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scheduled_for DATETIME NOT NULL,
  channel TEXT DEFAULT 'push',
  status TEXT DEFAULT 'pending',
  responded_at DATETIME,
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME,
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  escalated_at DATETIME,
  FOREIGN KEY(commitment_id) REFERENCES commitments(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE accountability_streaks (
  user_id TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  total_kept INTEGER DEFAULT 0,
  last_kept_date TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE coach_clients (
  id TEXT PRIMARY KEY,
  coach_user_id TEXT NOT NULL,
  client_user_id TEXT NOT NULL,
  client_label TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(coach_user_id, client_user_id),
  FOREIGN KEY(coach_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(client_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE contact_consent (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT DEFAULT 'granted',
  consent_text TEXT DEFAULT '',
  consent_version TEXT DEFAULT '',
  phone TEXT,
  quiet_start INTEGER,
  quiet_end INTEGER,
  timezone TEXT DEFAULT 'UTC',
  granted_at DATETIME,
  revoked_at DATETIME,
  revoke_source TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, channel),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  client_event_id TEXT
);

CREATE TABLE escalation_prefs (
  user_id TEXT PRIMARY KEY,
  ceiling TEXT DEFAULT 'text',
  default_persona TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE focus_presence (
  client_id TEXT PRIMARY KEY,
  last_seen DATETIME NOT NULL
);

CREATE TABLE coach_note_consent (
  user_id TEXT PRIMARY KEY,
  shared INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_events_user_time ON focus_events(user_id, client_timestamp);
CREATE INDEX idx_events_type ON focus_events(user_id, event_type);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
CREATE INDEX idx_notif_prefs_user ON notification_prefs(user_id);
CREATE INDEX idx_slack_user ON slack_integrations(user_id);
CREATE INDEX idx_sub_user ON subscriptions(user_id);
CREATE INDEX idx_sub_stripe ON subscriptions(stripe_customer_id);
CREATE INDEX idx_snapshots_user ON user_data_snapshots(user_id);
CREATE INDEX idx_sync_logs_user ON sync_logs(user_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_commitments_user ON commitments(user_id, status);
CREATE INDEX idx_commitments_checkin_at ON commitments(checkin_at);
CREATE INDEX idx_checkins_commitment ON commitment_checkins(commitment_id);
CREATE INDEX idx_checkins_scheduled ON commitment_checkins(user_id, scheduled_for);
CREATE INDEX idx_checkins_due ON commitment_checkins(status, scheduled_for);
CREATE INDEX idx_coach_clients_coach ON coach_clients(coach_user_id, status);
CREATE INDEX idx_coach_clients_client ON coach_clients(client_user_id, status);
CREATE INDEX idx_contact_consent_user ON contact_consent(user_id, channel);
CREATE INDEX idx_analytics_type_time ON analytics_events(event_type, created_at);
CREATE INDEX idx_analytics_user_time ON analytics_events(user_id, created_at);
CREATE UNIQUE INDEX idx_analytics_client_event
  ON analytics_events(user_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
CREATE INDEX idx_checkins_escalation ON commitment_checkins(status, delivered_at);
CREATE INDEX idx_presence_last_seen ON focus_presence(last_seen);
CREATE UNIQUE INDEX idx_sessions_token_hash
  ON sessions(token_hash) WHERE token_hash IS NOT NULL;
