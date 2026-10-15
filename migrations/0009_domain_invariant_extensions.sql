-- 0009_domain_invariant_extensions.sql
-- Phase 3: Domain invariant extensions.
--
-- This migration adds 6 changes to enforce the 10 non-negotiable
-- entitlement invariants at the DB level where possible:
--
--   A. Make original_occurrence_id nullable so entitlements can be
--      created WITHOUT an occurrence reference (unassigned entitlements
--      remain visible and recoverable, per Decision 3). The original
--      occurrence is set when the entitlement is first assigned to an
--      occurrence, and then becomes immutable.
--
--   B. Update the original_occurrence_id immutability trigger: allow
--      NULL → value (initial assignment) but forbid value → different
--      value (reassignment once set).
--
--   C. student_packages.class_id_at_purchase immutability trigger
--      (invariant #7: class change preserves paid entitlements).
--
--   D. session_entitlements status/assignment consistency CHECKs:
--      - status='completed' requires assigned_occurrence_id NOT NULL
--      - status='awaiting_makeup' requires assigned_occurrence_id NULL
--      - status='completed' requires original_occurrence_id NOT NULL
--
--   E. Occurrence capacity trigger (defense-in-depth). NOTE: This trigger
--      alone is NOT sufficient under concurrent requests under READ
--      COMMITTED. The domain service must ALSO use SERIALIZABLE +
--      SELECT FOR UPDATE. This trigger catches non-concurrent violations
--      and single-row over-capacity inserts. Real concurrency safety
--      requires real PostgreSQL verification (PgLite is single-process).
--
--   F. entitlement_events: add 'excused_absence' event type and require
--      non-empty reason for admin_corrected events (invariant #9).

-- === A. Make original_occurrence_id nullable ==============================
-- Per Decision 3: a package purchase must create exactly N entitlements
-- even if there are not enough generated occurrences to assign immediately.
-- Unassigned entitlements have original_occurrence_id = NULL. When an
-- occurrence is later assigned, original_occurrence_id is set and becomes
-- immutable.
ALTER TABLE session_entitlements ALTER COLUMN original_occurrence_id DROP NOT NULL;

-- === B. Update immutability trigger ========================================
-- Allow NULL → value (initial assignment) but forbid value → different
-- value (reassignment once set). The trigger from migration 0004 is
-- still attached; we only replace the function body.
CREATE OR REPLACE FUNCTION prevent_entitlement_original_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Once original_occurrence_id is set (NOT NULL), it is immutable.
    -- NULL → value (initial assignment) is allowed.
    -- value → same value (no change) is allowed.
    -- value → different value is FORBIDDEN.
    -- value → NULL is FORBIDDEN (can't un-set once set).
    IF OLD.original_occurrence_id IS NOT NULL
       AND NEW.original_occurrence_id IS DISTINCT FROM OLD.original_occurrence_id THEN
        RAISE EXCEPTION 'session_entitlements.original_occurrence_id is immutable once set';
    END IF;
    RETURN NEW;
END;
$$;

-- === C. student_packages.class_id_at_purchase immutability ==============
-- Per invariant #7: changing a student's class preserves existing paid
-- entitlements. The class_id_at_purchase is set at purchase time and
-- must never change.
CREATE OR REPLACE FUNCTION prevent_package_class_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.class_id_at_purchase IS DISTINCT FROM OLD.class_id_at_purchase THEN
        RAISE EXCEPTION 'student_packages.class_id_at_purchase is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_package_immutable_class
    BEFORE UPDATE ON student_packages
    FOR EACH ROW
    EXECUTE FUNCTION prevent_package_class_change();

-- === D. session_entitlements status/assignment CHECKs ====================
-- These enforce valid states at the DB level:
--   - Can't complete without an assigned occurrence (student must attend).
--   - Awaiting makeup means no current assignment (released).
--   - Completed entitlements must have an original occurrence reference.
ALTER TABLE session_entitlements
    ADD CONSTRAINT entitlement_completed_requires_assignment
    CHECK (status <> 'completed' OR assigned_occurrence_id IS NOT NULL);

ALTER TABLE session_entitlements
    ADD CONSTRAINT entitlement_awaiting_makeup_no_assignment
    CHECK (status <> 'awaiting_makeup' OR assigned_occurrence_id IS NULL);

ALTER TABLE session_entitlements
    ADD CONSTRAINT entitlement_completed_requires_original
    CHECK (status <> 'completed' OR original_occurrence_id IS NOT NULL);

-- === E. Occurrence capacity trigger (defense-in-depth) ===================
-- When an entitlement is assigned to an occurrence (INSERT or UPDATE with
-- assigned_occurrence_id NOT NULL and status='active'), count the active
-- entitlements already assigned to that occurrence. If the count + 1
-- exceeds the occurrence's capacity, reject.
--
-- IMPORTANT: This trigger is NOT sufficient for concurrent safety under
-- READ COMMITTED. Two concurrent transactions could both pass the count
-- check and both insert. The domain service MUST use SERIALIZABLE
-- isolation + SELECT FOR UPDATE on the occurrence row to serialize
-- access. This trigger provides defense-in-depth for non-concurrent
-- violations and catches single-row over-capacity.
CREATE OR REPLACE FUNCTION enforce_occurrence_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    occ_capacity integer;
    active_count integer;
BEGIN
    IF NEW.assigned_occurrence_id IS NOT NULL AND NEW.status = 'active' THEN
        SELECT capacity INTO occ_capacity
          FROM training_occurrences
         WHERE id = NEW.assigned_occurrence_id;
        IF occ_capacity IS NULL THEN
            RAISE EXCEPTION 'Referenced training_occurrence not found (id=%)', NEW.assigned_occurrence_id;
        END IF;
        SELECT COUNT(*) INTO active_count
          FROM session_entitlements
         WHERE assigned_occurrence_id = NEW.assigned_occurrence_id
           AND status = 'active'
           AND id <> NEW.id;
        IF active_count + 1 > occ_capacity THEN
            RAISE EXCEPTION 'Occurrence capacity exceeded (%/%)', active_count + 1, occ_capacity;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_capacity
    BEFORE INSERT OR UPDATE ON session_entitlements
    FOR EACH ROW
    EXECUTE FUNCTION enforce_occurrence_capacity();

-- === F. entitlement_events: excused_absence + admin_corrected reason =====
-- Add 'excused_absence' to the allowed event types (per Decision 1:
-- excused absence does NOT consume skip; it's recorded distinctly from
-- a student-initiated skip).
ALTER TABLE entitlement_events DROP CONSTRAINT IF EXISTS entitlement_events_event_type_check;
ALTER TABLE entitlement_events ADD CONSTRAINT entitlement_events_event_type_check
    CHECK (event_type IN (
        'created',
        'skip_requested',
        'makeup_assigned',
        'admin_corrected',
        'cancelled_reassigned',
        'completed',
        'excused_absence',
        'occurrence_assigned'
    ));

-- Admin corrections require a non-empty reason (invariant #9).
ALTER TABLE entitlement_events
    ADD CONSTRAINT admin_corrected_requires_reason
    CHECK (event_type <> 'admin_corrected' OR (reason IS NOT NULL AND reason <> ''));
