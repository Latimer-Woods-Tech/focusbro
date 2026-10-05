-- FBQ-21 R3 (focusbro#391): a full refund or an upheld dispute revokes Pro.
-- Reconcile-by-read used to treat 'paid' as terminal, so buy -> refund kept Pro
-- forever. A paid row is now re-read from Stripe at most once a day:
--   refund_checked_at  when the charge/refund state was last read (throttle)
--   refunded_at        set when Stripe says the charge was fully refunded or the
--                      dispute was lost; Pro = a 'paid' row with refunded_at NULL.
-- 'status' stays 'paid' (its CHECK constraint cannot be altered in SQLite); the
-- row is the customer's receipt and is never deleted.
-- Additive: two nullable columns. ROLLBACK: revert the code (old code ignores
-- both and reads 'paid' as Pro); the columns may stay.
ALTER TABLE pro_purchases ADD COLUMN refund_checked_at DATETIME;
ALTER TABLE pro_purchases ADD COLUMN refunded_at DATETIME;
