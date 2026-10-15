-- 0010_payment_manual_workflow.sql
-- Stage 5: Manual payment recording, idempotency, guardian contact phone,
-- expense→payment traceability for refunds.
--
-- Design notes:
--   - Manual workflow: an Admin records a payment as already-confirmed
--     (no submitted→confirmed approval step). recorded_by captures the
--     recording Admin; reviewed_by/reviewed_at are set to the same Admin
--     to satisfy the existing CHECK (confirmed requires reviewer info).
--   - payer_user_id becomes nullable: a payment may have a linked
--     guardian (payer_user_id) OR a manually entered payer_name.
--   - idempotency_key + idempotency_body_hash: dedup within an academy.
--   - NO refund status transitions, NO refund_resolved_at. Refunds are
--     recorded as academy_expenses with related_payment_id.
--   - payments.status enum still includes 'refunded' (pre-existing,
--     dormant). Stage 5 does not transition any payment to 'refunded'.
--
-- Backward compatibility:
--   - Old payments rows keep payer_user_id set, recorded_by NULL,
--     payment_method/payment_date/idempotency_* NULL. The new CHECKs use
--     recorded_by IS NOT NULL as the "new-style" marker so old rows are
--     exempt from method/date requirements.
--   - Old guardian_student_links rows get contact_phone NULL.
--   - Old academy_expenses rows get related_payment_id NULL.

-- === A. payments: manual workflow columns ================================

ALTER TABLE payments ALTER COLUMN payer_user_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN payer_name text;
ALTER TABLE payments ADD COLUMN payment_method text
    CHECK (payment_method IS NULL OR payment_method IN ('cash', 'bank_transfer'));
ALTER TABLE payments ADD COLUMN reference_number text;
ALTER TABLE payments ADD COLUMN payment_date date;
ALTER TABLE payments ADD COLUMN recorded_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN idempotency_key text;
ALTER TABLE payments ADD COLUMN idempotency_body_hash text;

-- Either a linked payer (guardian user) or a non-empty manual payer name.
ALTER TABLE payments ADD CONSTRAINT payments_payer_check
    CHECK (payer_user_id IS NOT NULL OR (payer_name IS NOT NULL AND payer_name <> ''));

-- New-style rows (recorded_by IS NOT NULL) require method + date + idempotency key.
ALTER TABLE payments ADD CONSTRAINT payments_new_record_complete
    CHECK (
        recorded_by IS NULL
        OR (payment_method IS NOT NULL AND payment_date IS NOT NULL AND idempotency_key IS NOT NULL AND idempotency_key <> '')
    );

-- Idempotency: unique key within academy, non-null only.
CREATE UNIQUE INDEX payments_idempotency_key_idx
    ON payments(academy_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- === B. guardian_student_links: optional contact phone ==================

ALTER TABLE guardian_student_links ADD COLUMN contact_phone text;

-- === C. academy_expenses: optional related payment (refunds) ============

ALTER TABLE academy_expenses ADD COLUMN related_payment_id uuid REFERENCES payments(id) ON DELETE RESTRICT;

CREATE INDEX expenses_related_payment_idx
    ON academy_expenses(related_payment_id)
    WHERE related_payment_id IS NOT NULL;
