-- 0005_attendance_reports_videos.sql
-- Attendance, semesters, student reports, training videos.
--
-- DB-enforced invariants:
--   - attendance_records UNIQUE (training_occurrence_id, student_id) — a
--     student cannot have two attendance rows for the same session.
--   - student_reports UNIQUE (student_id, semester_id) — at most one
--     report per student per semester.
--   - student_training_videos.youtube_url CHECK: must start with the
--     allowed YouTube host scheme. Full URL validation also runs in the
--     domain layer (Zod) before insertion; the DB CHECK is the last line
--     of defense, not the only one.

CREATE TABLE semesters (
    id           uuid         PRIMARY KEY,
    academy_id   uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    name         text         NOT NULL,
    start_date   date         NOT NULL,
    end_date     date         NOT NULL,
    is_active     boolean      NOT NULL DEFAULT true,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date),
    CHECK (name <> '')
);

CREATE INDEX semesters_academy_idx ON semesters(academy_id) WHERE is_active = true;

CREATE TABLE attendance_records (
    id                    uuid         PRIMARY KEY,
    training_occurrence_id uuid        NOT NULL REFERENCES training_occurrences(id) ON DELETE RESTRICT,
    student_id            uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    -- Optional: the entitlement this attendance fulfills.
    entitlement_id        uuid         REFERENCES session_entitlements(id) ON DELETE SET NULL,
    status                text         NOT NULL
                          CHECK (status IN ('present', 'absent', 'excused', 'late')),
    recorded_by           uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recorded_at           timestamptz  NOT NULL DEFAULT now(),
    notes                 text,
    created_at            timestamptz  NOT NULL DEFAULT now(),
    updated_at            timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (training_occurrence_id, student_id)
);

CREATE INDEX attendance_student_idx ON attendance_records(student_id);
CREATE INDEX attendance_occurrence_idx ON attendance_records(training_occurrence_id);

CREATE TABLE student_reports (
    id           uuid         PRIMARY KEY,
    student_id   uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    semester_id  uuid         NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT,
    author_user_id uuid       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    body         text         NOT NULL,
    -- Published reports are visible to parents/guardians.
    published_at timestamptz,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (student_id, semester_id),
    CHECK (body <> '')
);

CREATE INDEX reports_student_idx ON student_reports(student_id);
CREATE INDEX reports_semester_idx ON student_reports(semester_id);

CREATE TABLE student_training_videos (
    id              uuid         PRIMARY KEY,
    student_id      uuid         NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    -- The user who added the video (admin or coach only).
    uploaded_by     uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title           text         NOT NULL,
    -- Validated YouTube URL. Host allowlist enforced here (last line) and in
    -- the domain layer (first line, with proper parsing).
    youtube_url     text         NOT NULL,
    is_published    boolean      NOT NULL DEFAULT false,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CHECK (title <> ''),
    CHECK (youtube_url ~ '^https://(www\.)?youtube\.com/watch\?v=|^https://youtu\.be/'),
    -- youtube_url must not be empty after validation
    CHECK (length(youtube_url) > 12)
);

CREATE INDEX videos_student_idx ON student_training_videos(student_id) WHERE is_published = true;
