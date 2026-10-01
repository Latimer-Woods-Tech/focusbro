-- FocusBro Pro: a $9.99 ONE-TIME unlock, bought on the website only.
-- One row per Stripe Checkout Session the person started. There is no webhook
-- (the restricted key cannot create one), so a row is born 'pending' when the
-- session is created and is reconciled by READING the session back from Stripe
-- (GET /v1/checkout/sessions/{id}) whenever anything checks the person's Pro
-- status. A person is Pro when at least one of their rows is 'paid'.
-- ROLLBACK: DROP INDEX idx_pro_purchases_user; DROP TABLE pro_purchases;
--           (only while no row is 'paid' — a paid row is a customer's receipt)

CREATE TABLE IF NOT EXISTS pro_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired')),
  amount_total INTEGER,
  currency TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_pro_purchases_user ON pro_purchases(user_id);
