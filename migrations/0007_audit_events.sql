-- 0007_audit_events.sql
-- Audit log. Last in the migration order so it can reference users + academies.
-- audit_events does NOT FK to the mutated table — target_type/target_id are
-- free-form so audit rows remain even if the target row is later deleted
-- (preserving an immutable audit trail). The actor FK is SET NULL on user
-- deletion to keep the audit row alive.

CREATE TABLE audit_events (
    id              uuid         PRIMARY KEY,
    academy_id      uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    -- NULL for system-initiated actions (e.g. session expiry sweep).
    actor_user_id   uuid         REFERENCES users(id) ON DELETE SET NULL,
    -- Stable, snake_case action name (e.g. 'student.create', 'package.skip').
    action          text         NOT NULL,
    target_type     text         NOT NULL,
    target_id       uuid,
    occurred_at     timestamptz  NOT NULL DEFAULT now(),
    -- JSON snapshots. Sensitive fields (password, token, hash, evidence)
    -- are redacted by the audit writer before insertion.
    before          jsonb,
    after           jsonb,
    reason          text,
    CHECK (action <> ''),
    CHECK (target_type <> '')
);

CREATE INDEX audit_academy_idx ON audit_events(academy_id, occurred_at DESC);
CREATE INDEX audit_action_idx ON audit_events(action, occurred_at DESC);
CREATE INDEX audit_target_idx ON audit_events(target_type, target_id);
