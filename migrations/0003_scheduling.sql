-- 0003_scheduling.sql
-- Versioned recurring schedule slots and concrete training occurrences.
--
-- Key invariants:
--   - schedule_versions: at most ONE currently-active version per class
--     (partial UNIQUE on class_id WHERE effective_to IS NULL, DB-enforced).
--     Non-overlap of FUTURE effective periods is domain-enforced inside a
--     SERIALIZABLE transaction, NOT by a DB exclusion constraint (to avoid
--     the btree_gist extension dependency).
--   - training_occurrences: UNIQUE (schedule_slot_id, occurrence_date)
--     — guarantees idempotent occurrence generation.
--   - Each training_occurrence preserves the schedule_version_id and the
--     slot snapshot at the time of generation; subsequent schedule changes
--     do NOT rewrite already-generated occurrences.

CREATE TABLE schedule_versions (
    id             uuid         PRIMARY KEY,
    class_id       uuid         NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
    effective_from date         NOT NULL,
    effective_to   date,
    status         text         NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'superseded', 'draft')),
    created_at     timestamptz  NOT NULL DEFAULT now(),
    updated_at     timestamptz  NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- At most one currently-active schedule version per class (DB-enforced).
CREATE UNIQUE INDEX schedule_versions_one_active_per_class
    ON schedule_versions(class_id)
    WHERE effective_to IS NULL AND status = 'active';

CREATE INDEX schedule_versions_class_idx ON schedule_versions(class_id);

CREATE TABLE schedule_slots (
    id                 uuid         PRIMARY KEY,
    schedule_version_id uuid        NOT NULL REFERENCES schedule_versions(id) ON DELETE RESTRICT,
    -- ISO weekday: 0=Sunday … 6=Saturday. Tuesday=2, Saturday=6 per seed.
    weekday            smallint     NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_time         time         NOT NULL,
    end_time           time         NOT NULL,
    -- Optional per-slot capacity override.
    capacity_override  integer,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    CHECK (end_time > start_time),
    CHECK (capacity_override IS NULL OR capacity_override > 0)
);

CREATE INDEX schedule_slots_version_idx ON schedule_slots(schedule_version_id);

CREATE TABLE training_occurrences (
    id                  uuid         PRIMARY KEY,
    academy_id          uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    class_id             uuid         NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
    schedule_slot_id    uuid         NOT NULL REFERENCES schedule_slots(id) ON DELETE RESTRICT,
    -- Snapshot of the version that produced this occurrence. Future schedule
    -- changes do not rewrite this row.
    schedule_version_id uuid         NOT NULL REFERENCES schedule_versions(id) ON DELETE RESTRICT,
    -- Academy-local date (Asia/Jakarta). The concrete start_at/end_at are
    -- timestamptz for tz-aware comparisons; occurrence_date is the
    -- canonical dedupe key alongside the slot.
    occurrence_date     date         NOT NULL,
    start_at            timestamptz  NOT NULL,
    end_at              timestamptz  NOT NULL,
    status              text         NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned', 'completed', 'cancelled')),
    -- Per-occurrence capacity snapshot (inherits from slot at generation time).
    capacity            integer      NOT NULL,
    cancelled_at        timestamptz,
    cancelled_reason    text,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    -- Idempotent generation (DB-enforced).
    UNIQUE (schedule_slot_id, occurrence_date),
    CHECK (end_at > start_at),
    CHECK (capacity > 0)
);

CREATE INDEX training_occurrences_class_date_idx
    ON training_occurrences(class_id, occurrence_date);
CREATE INDEX training_occurrences_academy_date_idx
    ON training_occurrences(academy_id, occurrence_date);
CREATE INDEX training_occurrences_status_idx
    ON training_occurrences(status) WHERE status = 'planned';
