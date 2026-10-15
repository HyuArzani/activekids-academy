-- 0015_registration_guardian_resolution.sql
-- Stage 7B.3: Support safe Admin-controlled resolution of existing
-- guardian associations during registration approval.
--
-- When a public registration's parent_email matches an existing user,
-- the approval CONFLICTs (preventing unsafe auto-linking). The Admin
-- must then verify the parent's identity and explicitly select the
-- existing guardian. This migration adds:
--   - resolved_guardian_user_id: the Admin-selected existing guardian
--     (NULL until the Admin resolves). When set, approval links the
--     child to THIS guardian instead of creating a new user.
--   - resolution_reason: the Admin's audit reason for the selection.
--   - resolved_by: the Admin who made the decision.
--   - resolved_at: when the decision was made.
--
-- These fields are set ONLY by an authenticated Admin via a protected
-- endpoint — never by a public applicant.
--
-- Forward-only, additive. Old rows get NULL for all new columns.

ALTER TABLE registration_applications
    ADD COLUMN resolved_guardian_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN resolution_reason text,
    ADD COLUMN resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN resolved_at timestamptz;

-- Index for Admin queries (list resolved/pending).
CREATE INDEX registration_resolved_idx
    ON registration_applications(academy_id, resolved_guardian_user_id)
    WHERE resolved_guardian_user_id IS NOT NULL;
