-- 0014_student_training_video_extensions.sql
-- Stage 7B.2: Extend student_training_videos with optional fields for
-- training date, category, and notes. The base table (migration 0005)
-- has: id, student_id, uploaded_by, title, youtube_url, is_published,
-- created_at, updated_at. This migration adds the missing fields.
--
-- Forward-only, additive. Old rows get NULL for the new columns.

ALTER TABLE student_training_videos ADD COLUMN training_date date;
ALTER TABLE student_training_videos ADD COLUMN category text;
ALTER TABLE student_training_videos ADD COLUMN notes text;

-- Index for academy-scoped queries via student → academy JOIN.
CREATE INDEX student_training_videos_student_idx
    ON student_training_videos(student_id);
