-- 0013_registration_applications.sql
-- Stage 7B: Public parent registration applications.
--
-- This is a registration APPLICATION, not account creation. A submitted
-- application does NOT create a student, guardian, package, entitlement,
-- occurrence, payment, or authenticated account. An Admin must review and
-- approve before operational records are created.
--
-- Lifecycle: pending → approved | rejected.
--
-- Idempotency: idempotency_key + idempotency_body_hash (SHA-256 of the
-- normalized request body). Same key + same hash → return the original.
-- Same key + different hash → 409. NULL key = no idempotency guarantee.
--
-- Source: 'website' (direct public submission) | 'google_form' (future
-- server-side integration). The source is server-controlled or set via
-- a secure integration mechanism — never trusted from an unauthenticated
-- client claim without verification.
--
-- Rate limiting: reuses the existing DB-backed IP rate limiter
-- (checkRateLimit with identifier_type='ip') — the same infrastructure
-- used for login attempts. No new rate-limit table needed.

CREATE TABLE registration_applications (
    id                    uuid         PRIMARY KEY,
    academy_id            uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    -- Parent/guardian info
    parent_full_name      text         NOT NULL,
    parent_phone          text         NOT NULL,
    parent_email          text,
    preferred_contact     text
                          CHECK (preferred_contact IS NULL
                                 OR preferred_contact IN ('phone', 'email', 'whatsapp')),
    -- Child info
    child_full_name       text         NOT NULL,
    child_date_of_birth   date,
    -- Class preference (free text or class UUID; the Admin resolves it
    -- during approval — no FK because the preference may reference a class
    -- that doesn't exist yet, or the parent may not know the UUID).
    class_preference      text,
    preferred_day         text,
    notes                 text,
    -- Submission metadata (server-controlled)
    source                text         NOT NULL DEFAULT 'website'
                          CHECK (source IN ('website', 'google_form')),
    idempotency_key       text,
    idempotency_body_hash text,
    -- Lifecycle
    status                text         NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
    -- Review metadata (NULL until reviewed)
    reviewed_by           uuid         REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at           timestamptz,
    rejection_reason      text,
    -- Link to the created student (NULL until approved).
    student_id            uuid         REFERENCES students(id) ON DELETE SET NULL,
    -- Submission IP (for abuse tracking + rate limiting)
    submitted_ip         text,
    submitted_at          timestamptz  NOT NULL DEFAULT now(),
    created_at            timestamptz  NOT NULL DEFAULT now(),
    updated_at            timestamptz  NOT NULL DEFAULT now(),
    CHECK (parent_full_name <> ''),
    CHECK (child_full_name <> ''),
    CHECK (parent_phone <> ''),
    -- rejection_reason only set when status='rejected'.
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
    -- student_id only set when status='approved'.
    CHECK (status <> 'approved' OR student_id IS NOT NULL)
);

-- Idempotency: unique key within academy (non-null only).
CREATE UNIQUE INDEX registration_idempotency_idx
    ON registration_applications(academy_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Admin review queries (list pending by academy).
CREATE INDEX registration_academy_status_idx
    ON registration_applications(academy_id, status, submitted_at DESC);
