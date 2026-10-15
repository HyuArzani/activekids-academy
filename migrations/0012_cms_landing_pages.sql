-- 0012_cms_landing_pages.sql
-- Stage 7B: CMS backend — landing page content model, gallery, YouTube videos.
--
-- Design:
--   - landing_pages: one per academy (UNIQUE on academy_id). Holds the
--     working draft_content (JSONB, shape-validated in the domain). The
--     published_publication_id FK points to the latest published snapshot
--     (NULL = never published).
--   - landing_page_publications: IMMUTABLE snapshots of published content.
--     Each publish creates a new row with an incrementing version_number.
--     Reverting = pointing published_publication_id to an earlier snapshot.
--     Draft edits never modify published snapshots.
--   - gallery_items: academy-scoped media references (media_key for future
--     private object storage; NOT a public URL). No upload in this stage.
--   - youtube_videos: validated YouTube references (canonical 11-char video_id).
--
-- Publication lifecycle:
--   Draft → Published (explicit, audited, academy-scoped).
--   The public API reads ONLY the snapshot referenced by
--   published_publication_id. Draft content is never publicly accessible.
--
-- No circular FK issues: landing_pages is created first WITHOUT the
-- published_publication_id column; the FK is added via ALTER after
-- landing_page_publications exists.

-- === landing_pages (without the self-referential FK initially) =========

CREATE TABLE landing_pages (
    id                uuid         PRIMARY KEY,
    academy_id        uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    -- Working draft content (JSONB, shape-validated in the domain layer).
    -- Default empty object; the Admin updates this before publishing.
    draft_content     jsonb        NOT NULL DEFAULT '{}'::jsonb,
    draft_updated_at  timestamptz  NOT NULL DEFAULT now(),
    draft_updated_by  uuid         REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (academy_id)  -- one landing page per academy (MVP)
);

CREATE INDEX landing_pages_academy_idx ON landing_pages(academy_id);

-- === landing_page_publications (immutable snapshots) ==================

CREATE TABLE landing_page_publications (
    id                uuid         PRIMARY KEY,
    landing_page_id   uuid         NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
    version_number    integer      NOT NULL,
    content           jsonb        NOT NULL,
    published_by      uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    published_at      timestamptz  NOT NULL DEFAULT now(),
    publish_note      text,
    UNIQUE (landing_page_id, version_number)
);

CREATE INDEX landing_publications_lp_idx
    ON landing_page_publications(landing_page_id, version_number DESC);

-- Now add the FK from landing_pages to the latest published snapshot.
ALTER TABLE landing_pages
    ADD COLUMN published_publication_id uuid
    REFERENCES landing_page_publications(id) ON DELETE SET NULL;

-- === gallery_items =====================================================

CREATE TABLE gallery_items (
    id              uuid         PRIMARY KEY,
    academy_id      uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    title           text         NOT NULL,
    -- Media key for future private object storage (e.g.
    -- 'academies/{academyId}/gallery/{itemId}.jpg'). NULL until upload is
    -- implemented. This is NOT a public URL — the future presign stage
    -- will populate it. No arbitrary pasted URLs accepted.
    media_key       text,
    media_type      text         NOT NULL DEFAULT 'image'
                    CHECK (media_type IN ('image', 'video')),
    display_order   integer      NOT NULL DEFAULT 0,
    is_featured     boolean      NOT NULL DEFAULT false,
    is_published    boolean      NOT NULL DEFAULT false,
    created_by      uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CHECK (title <> ''),
    CHECK (display_order >= 0)
);

CREATE INDEX gallery_academy_published_idx
    ON gallery_items(academy_id, display_order)
    WHERE is_published = true;

-- === youtube_videos ====================================================

CREATE TABLE youtube_videos (
    id              uuid         PRIMARY KEY,
    academy_id      uuid         NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    title           text         NOT NULL,
    -- Canonical 11-char YouTube video ID (extracted from the URL).
    video_id        text         NOT NULL,
    -- The original URL (for reference; video_id is used for embedding).
    url             text         NOT NULL,
    display_order   integer      NOT NULL DEFAULT 0,
    is_featured     boolean      NOT NULL DEFAULT false,
    is_published    boolean      NOT NULL DEFAULT false,
    created_by      uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CHECK (title <> ''),
    CHECK (length(video_id) = 11),
    CHECK (display_order >= 0),
    -- URL must be a valid YouTube host (domain validates + extracts video_id).
    CHECK (url ~ '^https://(www\.)?youtube\.com/watch\?v=|^https://youtu\.be/')
);

CREATE UNIQUE INDEX youtube_academy_video_idx
    ON youtube_videos(academy_id, video_id);
CREATE INDEX youtube_academy_published_idx
    ON youtube_videos(academy_id, display_order)
    WHERE is_published = true;
