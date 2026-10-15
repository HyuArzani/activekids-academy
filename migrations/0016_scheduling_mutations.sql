-- 0016_scheduling_mutations.sql
-- Stage 9: Parent scheduling mutations (move, skip, makeup) with idempotency.
--
-- This migration:
--   A. Creates entitlement_idempotency_records — a dedicated response-cache +
--      dedup table for the three parent mutation endpoints. Stores the full
--      successful response blob (jsonb) so that a replay returns the original
--      result rather than re-evaluating against mutable current state.
--   B. Adds 'normal_moved' to the entitlement_events.event_type CHECK
--      constraint. A normal_moved event is created by each committed parent
--      normal-move and is the source of the move-count (derived via COUNT,
--      not a mutable counter).
--
-- Design decisions (approved):
--   - No mutable move counter on session_entitlements. The move limit is
--     env-based (NORMAL_MOVE_LIMIT_PER_ENTITLEMENT, default 2). The move count
--     is derived from COUNT(entitlement_events WHERE event_type='normal_moved').
--   - No move_allowance column on student_packages.
--   - Single unique index on (entitlement_id, idempotency_key) — no redundant
--     table-level UNIQUE constraint.
--   - FK ON DELETE RESTRICT to preserve audit/idempotency history.
--   - no_op flag distinguishes no-op moves (which store a record but consume
--     no move allowance and create no normal_moved event).

-- === A. entitlement_idempotency_records =================================

CREATE TABLE entitlement_idempotency_records (
    id              uuid         PRIMARY KEY,
    academy_id      uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    entitlement_id  uuid         NOT NULL REFERENCES session_entitlements(id) ON DELETE RESTRICT,
    idempotency_key text         NOT NULL,
    body_hash       text         NOT NULL,
    operation       text         NOT NULL CHECK (operation IN ('move', 'skip', 'makeup')),
    result          jsonb        NOT NULL,
    no_op           boolean      NOT NULL DEFAULT false,
    created_at      timestamptz  NOT NULL DEFAULT now()
);

-- Single unique index (per-entitlement key scope). Same key on different
-- entitlements is independent; same key on the same entitlement must
-- hash-match or be rejected as idempotency_key_reuse.
CREATE UNIQUE INDEX entitlement_idempotency_key_idx
    ON entitlement_idempotency_records(entitlement_id, idempotency_key);

-- === B. Add 'normal_moved' event type ====================================

-- The constraint was created inline (unnamed) in migration 0004 and explicitly
-- re-created as entitlement_events_event_type_check in migration 0009.
-- DROP IF EXISTS is idempotent and safe.
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
        'occurrence_assigned',
        'normal_moved'
    ));
