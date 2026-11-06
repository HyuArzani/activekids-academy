-- 0018_training_plans.sql
-- Coach training plans: a coach writes a plan for a specific training
-- occurrence (warm-up, drills, game play, notes). The plan is optionally
-- visible to parents of enrolled students (visible_to_parents flag,
-- default false — parents only see plans the coach explicitly shares).
--
-- Forward-only, additive. One plan per occurrence (UNIQUE) — a coach
-- edits their plan rather than creating multiple versions.

CREATE TABLE training_plans (
    id                  uuid         PRIMARY KEY,
    academy_id          uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    occurrence_id       uuid         NOT NULL REFERENCES training_occurrences(id) ON DELETE CASCADE,
    author_user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title               text         NOT NULL,
    content             text         NOT NULL,
    -- Parents of enrolled students may read this plan only when true.
    visible_to_parents  boolean      NOT NULL DEFAULT false,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    -- One plan per occurrence: upsert semantics on conflict.
    UNIQUE (occurrence_id),
    CHECK (length(title) > 0),
    CHECK (length(content) > 0)
);

CREATE INDEX training_plans_academy_idx
    ON training_plans(academy_id);
CREATE INDEX training_plans_occurrence_idx
    ON training_plans(occurrence_id);
