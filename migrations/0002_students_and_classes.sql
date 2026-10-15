-- 0002_students_and_classes.sql
-- Students, classes, effective-dated enrollments, guardian links,
-- coach assignments.
--
-- DB-enforced invariants in this file:
--   - guardian_student_links: at most ONE primary guardian per student
--     (partial UNIQUE index on student_id WHERE is_primary = TRUE)
--   - student_enrollments: at most ONE currently-active enrollment per
--     student (partial UNIQUE on student_id WHERE effective_to IS NULL).
--     This is DB-enforced.
--   - Domain-enforced (NOT DB-enforced): non-overlap of FUTURE effective
--     periods (two future-dated rows whose [effective_from, effective_to)
--     intervals overlap is rejected by the enrollment domain operation
--     inside a SERIALIZABLE transaction, NOT by a DB constraint here).
--     We deliberately avoid EXCLUDE USING gist because it requires the
--     btree_gist extension, which is not guaranteed to be available under
--     PgLite or some managed PostgreSQL offerings.
--   - coach_student_assignments: UNIQUE (coach_user_id, student_id) to
--     prevent duplicate assignments.

CREATE TABLE students (
    id           uuid         PRIMARY KEY,
    academy_id   uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    full_name    text         NOT NULL,
    date_of_birth date,
    gender       text         CHECK (gender IN ('male', 'female', 'unspecified')),
    notes        text,
    -- Soft archive; does not delete history.
    archived_at  timestamptz,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    CHECK (full_name <> '')
);

CREATE INDEX students_academy_idx ON students(academy_id) WHERE archived_at IS NULL;

CREATE TABLE classes (
    id           uuid         PRIMARY KEY,
    academy_id   uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    name         text         NOT NULL,
    -- Default capacity; per-slot overrides live in schedule_slots.
    capacity     integer      NOT NULL DEFAULT 12,
    is_active     boolean      NOT NULL DEFAULT true,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    CHECK (name <> ''),
    CHECK (capacity > 0)
);

CREATE INDEX classes_academy_idx ON classes(academy_id) WHERE is_active = true;

CREATE TABLE student_enrollments (
    id             uuid         PRIMARY KEY,
    student_id     uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    class_id       uuid         NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
    -- Effective-dated. effective_to IS NULL means "currently active".
    -- The CHECK below enforces ordering when both dates are present.
    effective_from date         NOT NULL,
    effective_to   date,
    created_at     timestamptz  NOT NULL DEFAULT now(),
    updated_at     timestamptz  NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- At most one currently-active enrollment per student (DB-enforced).
CREATE UNIQUE INDEX student_enrollments_one_active_per_student
    ON student_enrollments(student_id)
    WHERE effective_to IS NULL;

CREATE INDEX student_enrollments_student_idx ON student_enrollments(student_id);
CREATE INDEX student_enrollments_class_idx ON student_enrollments(class_id);

CREATE TABLE guardian_student_links (
    id               uuid         PRIMARY KEY,
    guardian_user_id uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    student_id       uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    is_primary       boolean      NOT NULL DEFAULT false,
    relationship     text,        -- e.g. 'mother', 'father', 'guardian'
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (guardian_user_id, student_id)
);

-- At most one primary guardian per student (DB-enforced).
CREATE UNIQUE INDEX guardian_links_one_primary_per_student
    ON guardian_student_links(student_id)
    WHERE is_primary = TRUE;

CREATE INDEX guardian_links_student_idx ON guardian_student_links(student_id);
CREATE INDEX guardian_links_guardian_idx ON guardian_student_links(guardian_user_id);

CREATE TABLE coach_student_assignments (
    id              uuid         PRIMARY KEY,
    coach_user_id   uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    student_id      uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    -- Optional class scope; if NULL, assignment is student-wide for this coach.
    class_id        uuid         REFERENCES classes(id) ON DELETE RESTRICT,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (coach_user_id, student_id)
);

CREATE INDEX coach_assignments_student_idx ON coach_student_assignments(student_id) WHERE is_active = true;
CREATE INDEX coach_assignments_coach_idx ON coach_student_assignments(coach_user_id) WHERE is_active = true;
