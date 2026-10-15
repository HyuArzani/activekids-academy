-- 0006_payments_and_expenses.sql
-- Payments, payment allocations, academy expenses.
--
-- Payment flow:
--   1. Parent submits a payment record (amount + evidence metadata).
--      status='submitted'.
--   2. Admin reviews and either confirms (status='confirmed') or rejects
--      (status='rejected'). Confirmation must occur inside a SERIALIZABLE
--      transaction together with allocation inserts.
--   3. payment_allocations distribute a confirmed payment across one or more
--      student_packages. The sum of allocations must not exceed the
--      confirmed amount — enforced in the confirmation domain operation,
--      not by a multi-row DB CHECK.
--
-- DB-enforced invariants:
--   - payment_allocations UNIQUE (payment_id, student_package_id)
--   - payments.status CHECK enum
--   - payments.submitted_amount >= 0 (numeric, two decimal places)
--   - When status='confirmed', reviewed_by/reviewed_at are NOT NULL
--     (CHECK constraint).
--   - payment_allocations.amount > 0

CREATE TABLE payments (
    id              uuid         PRIMARY KEY,
    academy_id      uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    -- The parent user who submitted the payment evidence.
    payer_user_id   uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    student_id      uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    submitted_amount numeric(12,2) NOT NULL,
    currency        text         NOT NULL DEFAULT 'IDR',
    -- Evidence metadata only — no file upload infrastructure in the MVP.
    -- The actual receipt is referenced by a URL/metadata blob stored here.
    evidence_url    text,
    evidence_meta   jsonb,
    status          text         NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted', 'confirmed', 'rejected', 'refunded')),
    reviewed_by     uuid         REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     timestamptz,
    reviewer_note   text,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CHECK (submitted_amount >= 0),
    -- A confirmed payment must have reviewer info. Rejected must too.
    CHECK (
        status NOT IN ('confirmed', 'rejected')
        OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE INDEX payments_academy_idx ON payments(academy_id);
CREATE INDEX payments_student_idx ON payments(student_id);
CREATE INDEX payments_status_idx ON payments(status);

CREATE TABLE payment_allocations (
    id                 uuid         PRIMARY KEY,
    payment_id         uuid         NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    student_package_id uuid         NOT NULL REFERENCES student_packages(id) ON DELETE RESTRICT,
    -- Amount allocated to this package from the parent payment.
    amount             numeric(12,2) NOT NULL,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (payment_id, student_package_id),
    CHECK (amount > 0)
);

CREATE INDEX allocations_payment_idx ON payment_allocations(payment_id);
CREATE INDEX allocations_package_idx ON payment_allocations(student_package_id);

CREATE TABLE academy_expenses (
    id            uuid         PRIMARY KEY,
    academy_id    uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    category      text         NOT NULL,
    amount        numeric(12,2) NOT NULL,
    currency      text         NOT NULL DEFAULT 'IDR',
    incurred_on   date         NOT NULL,
    note          text,
    created_by    uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now(),
    CHECK (amount >= 0),
    CHECK (category <> '')
);

CREATE INDEX expenses_academy_idx ON academy_expenses(academy_id, incurred_on);
