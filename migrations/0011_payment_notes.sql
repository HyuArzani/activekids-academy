-- 0011_payment_notes.sql
-- Stage 5.1: Persist optional payment notes.
--
-- The Stage 5 manual-payment API accepts a `notes` field but the payments
-- table previously had no column for it. This migration adds a nullable
-- `notes` column so the field is persisted in the same transaction as the
-- payment + package purchase.
--
-- Compatibility:
--   - Nullable column; old rows get NULL.
--   - submitPayment/confirmPayment (existing) do not set notes; their rows
--     keep notes = NULL. No change to their behavior.
--   - No new CHECK constraints (notes is free text, optional).

ALTER TABLE payments ADD COLUMN notes text;
