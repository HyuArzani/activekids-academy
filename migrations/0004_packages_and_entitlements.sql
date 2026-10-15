-- 0004_packages_and_entitlements.sql
-- Package plans, student packages, session entitlements, entitlement events.
--
-- Critical invariants:
--   - session_entitlements.original_occurrence_id is IMMUTABLE. Enforced by
--     a BEFORE UPDATE trigger that raises on any change. The original
--     occurrence is the one the entitlement was created against when the
--     package was generated; it is NEVER silently rewritten when a session
--     is skipped, moved, or reassigned.
--   - assigned_occurrence_id is mutable (skip → NULL, makeup → new future
--     occurrence, admin-correct → arbitrary with required non-empty reason).
--   - skip_used: ONE skip per student_packages row (NOT per entitlement),
--     domain-enforced inside a SERIALIZABLE transaction with a SELECT FOR
--     UPDATE on the parent student_packages row. The CHECK constraints below
--     enforce per-entitlement status transitions and skip_used consistency.
--   - entitlement count == package_plan.session_count: enforced by the
--     package creation domain operation, NOT by a single-row CHECK (multi-row
--     invariant). The operation asserts the count before COMMIT.
--
-- DB-enforced:
--   - original_occurrence_id immutability (trigger)
--   - session_entitlements.status CHECK enum
--   - skip_used + status consistency: if status='skipped', skip_used must be TRUE
--   - UNIQUE(student_package_id, sequence) → no duplicate sequence numbers

CREATE TABLE package_plans (
    id             uuid         PRIMARY KEY,
    academy_id     uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    name           text         NOT NULL,
    -- Arbitrary session count; no hardcode. Seed ships 4 and 8.
    session_count  integer      NOT NULL,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at     timestamptz  NOT NULL DEFAULT now(),
    updated_at     timestamptz  NOT NULL DEFAULT now(),
    CHECK (name <> ''),
    CHECK (session_count > 0)
);

CREATE INDEX package_plans_academy_idx ON package_plans(academy_id) WHERE is_active = true;

CREATE TABLE student_packages (
    id                       uuid         PRIMARY KEY,
    student_id               uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    package_plan_id          uuid         NOT NULL REFERENCES package_plans(id) ON DELETE RESTRICT,
    -- The class the package was purchased against. Per the approved
    -- class-change policy, paid entitlements remain associated with this
    -- original class even if the student later enrolls in a different class.
    class_id_at_purchase     uuid         NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
    -- Skip allowance snapshot (currently one per package). Stored here so
    -- it can be configured per-package in the future without schema change.
    skip_allowance           integer      NOT NULL DEFAULT 1,
    status                   text         NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'completed', 'cancelled')),
    purchased_at             timestamptz  NOT NULL DEFAULT now(),
    created_at               timestamptz  NOT NULL DEFAULT now(),
    updated_at               timestamptz  NOT NULL DEFAULT now(),
    CHECK (skip_allowance >= 0)
);

CREATE INDEX student_packages_student_idx ON student_packages(student_id);
CREATE INDEX student_packages_class_idx ON student_packages(class_id_at_purchase);

CREATE TABLE session_entitlements (
    id                       uuid         PRIMARY KEY,
    student_package_id       uuid         NOT NULL REFERENCES student_packages(id) ON DELETE RESTRICT,
    -- 1-based sequence within the package; UNIQUE per package.
    sequence                 integer      NOT NULL,
    -- IMMUTABLE: the occurrence the entitlement was originally created
    -- against. Never rewritten by skip/makeup/reassign. Enforced by trigger.
    original_occurrence_id   uuid         NOT NULL REFERENCES training_occurrences(id) ON DELETE RESTRICT,
    -- Mutable: the occurrence the student is currently expected to attend.
    -- NULL means "awaiting makeup" (e.g. after a skip or academy cancel).
    assigned_occurrence_id   uuid         REFERENCES training_occurrences(id) ON DELETE RESTRICT,
    status                   text         NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'skipped', 'awaiting_makeup', 'completed', 'cancelled')),
    -- TRUE if this entitlement has consumed the package's skip allowance.
    skip_used                boolean      NOT NULL DEFAULT false,
    -- Audit-link metadata (full event history in entitlement_events).
    created_at               timestamptz  NOT NULL DEFAULT now(),
    updated_at               timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (student_package_id, sequence),
    -- Invariant: status='skipped' implies skip_used=TRUE.
    CHECK (status <> 'skipped' OR skip_used = TRUE)
);

CREATE INDEX entitlements_package_idx ON session_entitlements(student_package_id);
CREATE INDEX entitlements_assigned_idx
    ON session_entitlements(assigned_occurrence_id)
    WHERE status = 'active';
CREATE INDEX entitlements_status_idx ON session_entitlements(status);

-- Immutability trigger: forbid changing original_occurrence_id on UPDATE.
CREATE OR REPLACE FUNCTION prevent_entitlement_original_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.original_occurrence_id IS DISTINCT FROM OLD.original_occurrence_id THEN
        RAISE EXCEPTION 'session_entitlements.original_occurrence_id is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_entitlement_immutable_original
    BEFORE UPDATE ON session_entitlements
    FOR EACH ROW
    EXECUTE FUNCTION prevent_entitlement_original_change();

CREATE TABLE entitlement_events (
    id                uuid         PRIMARY KEY,
    entitlement_id    uuid         NOT NULL REFERENCES session_entitlements(id) ON DELETE RESTRICT,
    -- 'created' | 'skip_requested' | 'makeup_assigned' | 'admin_corrected'
    -- | 'cancelled_reassigned' | 'completed'
    event_type        text         NOT NULL
                      CHECK (event_type IN (
                          'created',
                          'skip_requested',
                          'makeup_assigned',
                          'admin_corrected',
                          'cancelled_reassigned',
                          'completed'
                      )),
    occurred_at       timestamptz  NOT NULL DEFAULT now(),
    actor_user_id     uuid         REFERENCES users(id) ON DELETE SET NULL,
    reason            text,
    before_state      jsonb,
    after_state       jsonb,
    CHECK (reason IS NULL OR reason <> '')
);

CREATE INDEX entitlement_events_entitlement_idx ON entitlement_events(entitlement_id, occurred_at);
