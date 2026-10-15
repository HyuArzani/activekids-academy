/**
 * Domain: CMS — landing page content, gallery, YouTube videos.
 *
 * Stage 7B backend foundation. Public API reads ONLY published snapshots;
 * draft content is never publicly accessible. Admin APIs manage drafts
 * and explicit, audited publication.
 *
 * Publication/versioning strategy:
 *   - `landing_pages.draft_content` is the working draft (JSONB, shape-validated).
 *   - Publishing: INSERT a new `landing_page_publications` row (immutable
 *     snapshot) with an incrementing version_number, then UPDATE
 *     `landing_pages.published_publication_id` to the new snapshot. All
 *     in a SERIALIZABLE tx + audit. Draft is NOT modified by publishing.
 *   - Reverting: UPDATE `published_publication_id` to an earlier snapshot.
 *     The snapshots are immutable, so this is safe.
 *   - Public reads: JOIN `landing_pages` → `landing_page_publications`
 *     via `published_publication_id`. Returns the snapshot content, never
 *     the draft.
 *
 * YouTube URL validation:
 *   - Accepts `https://www.youtube.com/watch?v=VIDEO_ID` and
 *     `https://youtu.be/VIDEO_ID`.
 *   - Extracts the canonical 11-char video ID.
 *   - Rejects other hosts, missing video ID, or invalid ID length.
 *
 * Academy scoping: all queries filter by academy_id. Cross-academy → 404.
 *
 * Server-only. Never import from client code.
 */

import { createHash } from "node:crypto";
import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  newId,
} from "./helpers";

// === Content shape (Zod-validated JSONB) ================================

import { z } from "zod";

/**
 * The landing page content shape. Structured + validated (not an
 * unrestricted JSON blob). The frontend will render each section.
 * Optional fields default to absent — the public API returns whatever
 * is present; the frontend handles missing sections gracefully.
 */
export const landingContentSchema = z.object({
  hero: z.object({
    title: z.string().max(200).optional(),
    subtitle: z.string().max(500).optional(),
    ctaText: z.string().max(100).optional(),
  }).optional(),
  about: z.object({
    title: z.string().max(200).optional(),
    body: z.string().max(5000).optional(),
  }).optional(),
  programs: z.array(z.object({
    name: z.string().max(200),
    description: z.string().max(1000).optional(),
  })).max(20).optional(),
  schedules: z.array(z.object({
    day: z.string().max(50),
    time: z.string().max(50),
    className: z.string().max(200).optional(),
  })).max(30).optional(),
  coaches: z.array(z.object({
    name: z.string().max(200),
    role: z.string().max(200).optional(),
    bio: z.string().max(1000).optional(),
  })).max(20).optional(),
  location: z.object({
    address: z.string().max(500).optional(),
    mapUrl: z.string().max(2000).optional(),
  }).optional(),
  contact: z.object({
    phone: z.string().max(50).optional(),
    email: z.string().max(200).optional(),
    whatsapp: z.string().max(50).optional(),
  }).optional(),
  registrationCta: z.object({
    text: z.string().max(200).optional(),
  }).optional(),
  // References to gallery_items + youtube_videos (UUIDs). The Admin selects
  // which items to include. At publish time, the domain resolves these to
  // actual data (title, mediaKey/videoId, displayOrder) and stores the
  // resolved data in the snapshot — so the published page is immutable even
  // if the gallery/video records are later edited.
  galleryItemIds: z.array(z.string().min(1)).max(50).optional(),
  youtubeVideoIds: z.array(z.string().min(1)).max(50).optional(),
  // Snapshot-only fields (populated at publish time, NOT set by the Admin):
  // the resolved gallery + video data that was current at publish time.
  // The public API reads from these, not from the mutable current tables.
  publishedGallery: z.array(z.object({
    id: z.string(),
    title: z.string(),
    mediaKey: z.string().nullable().optional(),
    mediaType: z.string().optional(),
    displayOrder: z.number(),
    isFeatured: z.boolean().optional(),
  })).max(50).optional(),
  publishedVideos: z.array(z.object({
    id: z.string(),
    title: z.string(),
    videoId: z.string(),
    displayOrder: z.number(),
    isFeatured: z.boolean().optional(),
  })).max(50).optional(),
});

export type LandingContent = z.infer<typeof landingContentSchema>;

// === Row types ==========================================================

export interface LandingPageRow {
  id: string;
  academyId: string;
  draftContent: LandingContent;
  publishedPublicationId: string | null;
  draftUpdatedAt: string;
  draftUpdatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LandingPagePublicationRow {
  id: string;
  landingPageId: string;
  versionNumber: number;
  content: LandingContent;
  publishedBy: string;
  publishedAt: string;
  publishNote: string | null;
}

export interface GalleryItemRow {
  id: string;
  academyId: string;
  title: string;
  mediaKey: string | null;
  mediaType: string;
  displayOrder: number;
  isFeatured: boolean;
  isPublished: boolean;
  createdBy: string;
  createdAt: string;
}

export interface YoutubeVideoRow {
  id: string;
  academyId: string;
  title: string;
  videoId: string;
  url: string;
  displayOrder: number;
  isFeatured: boolean;
  isPublished: boolean;
  createdBy: string;
  createdAt: string;
}

// === Public landing page read ===========================================

export interface PublicLandingPage {
  academyId: string;
  academyName: string;
  content: LandingContent;
  publishedAt: string;
  versionNumber: number;
  gallery: { id: string; title: string; mediaKey?: string | null; mediaType?: string; displayOrder: number; isFeatured?: boolean }[];
  videos: { id: string; title: string; videoId: string; displayOrder: number; isFeatured?: boolean }[];
}

/**
 * Get the PUBLISHED landing page for an academy. Returns 404 if never
 * published or if the academy has no landing page. Draft content is
 * NEVER returned by this function.
 *
 * Public (unauthenticated) — academy scoping via the academy_id column.
 */
export async function getPublishedLandingPage(
  academyId: string,
  db: DbClient = getDb(),
): Promise<PublicLandingPage> {
  const result = await db.query<{
    academy_id: string;
    academy_name: string;
    content: unknown;
    published_at: string;
    version_number: number;
  }>(
    `SELECT lp.academy_id, a.name AS academy_name,
            pub.content, pub.published_at, pub.version_number
       FROM landing_pages lp
       JOIN academies a ON a.id = lp.academy_id
       JOIN landing_page_publications pub ON pub.id = lp.published_publication_id
      WHERE lp.academy_id = $1
      LIMIT 1;`,
    [academyId],
  );
  const row = result.rows[0] as
    | { academy_id: string; academy_name: string; content: unknown; published_at: string; version_number: number }
    | undefined;
  if (!row) throw Err.notFound("No published landing page for this academy.");

  const content = landingContentSchema.parse(row.content);

  // Read gallery + videos from the IMMUTABLE snapshot (publishedGallery /
  // publishedVideos fields), NOT from the mutable current tables. This
  // ensures that editing gallery/video records after publication does NOT
  // retroactively change the published page.
  const gallery = content.publishedGallery ?? [];
  const videos = content.publishedVideos ?? [];

  return {
    academyId: row.academy_id,
    academyName: row.academy_name,
    content,
    publishedAt: row.published_at,
    versionNumber: row.version_number,
    gallery,
    videos,
  };
}

async function getPublishedGallery(
  academyId: string,
  db: DbClient,
): Promise<{ id: string; title: string; mediaKey: string | null; displayOrder: number }[]> {
  const result = await db.query<{ id: string; title: string; media_key: string | null; display_order: number }>(
    `SELECT id, title, media_key, display_order
       FROM gallery_items
      WHERE academy_id = $1 AND is_published = true
      ORDER BY display_order, created_at;`,
    [academyId],
  );
  return (result.rows as { id: string; title: string; media_key: string | null; display_order: number }[]).map((r) => ({
    id: r.id,
    title: r.title,
    mediaKey: r.media_key,
    displayOrder: r.display_order,
  }));
}

async function getPublishedVideos(
  academyId: string,
  db: DbClient,
): Promise<{ id: string; title: string; videoId: string; displayOrder: number }[]> {
  const result = await db.query<{ id: string; title: string; video_id: string; display_order: number }>(
    `SELECT id, title, video_id, display_order
       FROM youtube_videos
      WHERE academy_id = $1 AND is_published = true
      ORDER BY display_order, created_at;`,
    [academyId],
  );
  return (result.rows as { id: string; title: string; video_id: string; display_order: number }[]).map((r) => ({
    id: r.id,
    title: r.title,
    videoId: r.video_id,
    displayOrder: r.display_order,
  }));
}

// === Admin: draft management ===========================================

/**
 * Get the landing page for an academy (Admin). Returns the DRAFT content
 * + publication status. Creates an empty draft if none exists.
 */
export async function getOrCreateLandingPage(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<LandingPageRow> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  // Try to load existing.
  const existing = await db.query<LandingPageRow>(
    `SELECT id, academy_id AS "academyId", draft_content AS "draftContent",
            published_publication_id AS "publishedPublicationId",
            to_char(draft_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "draftUpdatedAt",
            draft_updated_by AS "draftUpdatedBy"
       FROM landing_pages
      WHERE academy_id = $1
      LIMIT 1;`,
    [academyId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0] as LandingPageRow;
    row.draftContent = landingContentSchema.parse(row.draftContent as unknown);
    return row;
  }

  // Create empty draft (in a tx so audit + insert are atomic).
  const id = newId();
  await db.withTxSerializable(async (tx) => {
    await tx.query(
      `INSERT INTO landing_pages (id, academy_id, draft_content) VALUES ($1, $2, '{}'::jsonb);`,
      [id, academyId],
    );
    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "landing_page.create",
      targetType: "landing_pages",
      targetId: id,
      after: { academyId },
    });
  });
  return {
    id,
    academyId,
    draftContent: {},
    publishedPublicationId: null,
    draftUpdatedAt: new Date().toISOString(),
    draftUpdatedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update the draft content. Does NOT modify the published snapshot.
 * Validates the content shape with Zod before saving.
 */
export async function updateLandingPageDraft(
  principal: Principal,
  academyId: string,
  content: LandingContent,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  // Validate the content shape (defense-in-depth; the API also validates).
  landingContentSchema.parse(content);

  return db.withTxSerializable(async (tx) => {
    // Ensure a landing page exists (create if absent).
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM landing_pages WHERE academy_id = $1 LIMIT 1;`,
      [academyId],
    );
    let landingPageId: string;
    if (existing.rows[0]) {
      landingPageId = (existing.rows[0] as { id: string }).id;
    } else {
      landingPageId = newId();
      await tx.query(
        `INSERT INTO landing_pages (id, academy_id, draft_content) VALUES ($1, $2, '{}'::jsonb);`,
        [landingPageId, academyId],
      );
    }

    await tx.query(
      `UPDATE landing_pages
          SET draft_content = $2::jsonb,
              draft_updated_at = now(),
              draft_updated_by = $3,
              updated_at = now()
        WHERE id = $1;`,
      [landingPageId, JSON.stringify(content), principal.userId],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "landing_page.update_draft",
      targetType: "landing_pages",
      targetId: landingPageId,
      after: { contentKeys: Object.keys(content) },
    });
  });
}

/**
 * Publish the current draft content. Creates a new immutable snapshot
 * with an incrementing version_number, then points
 * published_publication_id to it. Draft is NOT modified.
 *
 * Atomic: if any step fails, the whole tx rolls back — the previously
 * published snapshot (if any) remains intact.
 */
export async function publishLandingPage(
  principal: Principal,
  academyId: string,
  publishNote: string | null,
  db: DbClient = getDb(),
): Promise<{ publicationId: string; versionNumber: number }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  return db.withTxSerializable(async (tx) => {
    // Lock the landing page row.
    const lpResult = await tx.query<{ id: string; draft_content: unknown; published_publication_id: string | null }>(
      `SELECT id, draft_content, published_publication_id
         FROM landing_pages
        WHERE academy_id = $1
        LIMIT 1;`,
      [academyId],
    );
    const lp = lpResult.rows[0] as { id: string; draft_content: unknown; published_publication_id: string | null } | undefined;
    if (!lp) throw Err.notFound("No landing page for this academy. Create a draft first.");

    await tx.query(`SELECT id FROM landing_pages WHERE id = $1 FOR UPDATE;`, [lp.id]);

    // Validate the draft content before publishing.
    const content = landingContentSchema.parse(lp.draft_content);

    // Resolve gallery + video IDs into immutable snapshot data. This ensures
    // the published page reflects the gallery/video state AT PUBLISH TIME.
    // Subsequent edits to gallery/video records do NOT retroactively change
    // this publication.
    const galleryIds = content.galleryItemIds ?? [];
    const videoIds = content.youtubeVideoIds ?? [];

    // Fetch all currently-published gallery items (if no IDs specified, include all published).
    const galleryResult = await tx.query<{ id: string; title: string; media_key: string | null; media_type: string; display_order: number; is_featured: boolean }>(
      `SELECT id, title, media_key, media_type, display_order, is_featured
         FROM gallery_items
        WHERE academy_id = $1 AND is_published = true
          ${galleryIds.length > 0 ? `AND id = ANY($2::uuid[])` : ''}
        ORDER BY display_order, created_at;`,
      galleryIds.length > 0 ? [academyId, galleryIds] : [academyId],
    );
    const publishedGallery = (galleryResult.rows as { id: string; title: string; media_key: string | null; media_type: string; display_order: number; is_featured: boolean }[]).map((r) => ({
      id: r.id, title: r.title, mediaKey: r.media_key, mediaType: r.media_type, displayOrder: r.display_order, isFeatured: r.is_featured,
    }));

    const videoResult = await tx.query<{ id: string; title: string; video_id: string; display_order: number; is_featured: boolean }>(
      `SELECT id, title, video_id, display_order, is_featured
         FROM youtube_videos
        WHERE academy_id = $1 AND is_published = true
          ${videoIds.length > 0 ? `AND id = ANY($2::uuid[])` : ''}
        ORDER BY display_order, created_at;`,
      videoIds.length > 0 ? [academyId, videoIds] : [academyId],
    );
    const publishedVideos = (videoResult.rows as { id: string; title: string; video_id: string; display_order: number; is_featured: boolean }[]).map((r) => ({
      id: r.id, title: r.title, videoId: r.video_id, displayOrder: r.display_order, isFeatured: r.is_featured,
    }));

    // Merge the resolved data into the snapshot content.
    const snapshotContent = { ...content, publishedGallery, publishedVideos };

    // Determine the next version_number.
    const versionResult = await tx.query<{ max_version: number | null }>(
      `SELECT MAX(version_number) AS max_version
         FROM landing_page_publications
        WHERE landing_page_id = $1;`,
      [lp.id],
    );
    const maxVersion = (versionResult.rows[0] as { max_version: number | null }).max_version ?? 0;
    const nextVersion = maxVersion + 1;

    // Insert the immutable snapshot (with resolved gallery/video data).
    const publicationId = newId();
    await tx.query(
      `INSERT INTO landing_page_publications
         (id, landing_page_id, version_number, content, published_by, publish_note)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6);`,
      [publicationId, lp.id, nextVersion, JSON.stringify(snapshotContent), principal.userId, publishNote],
    );

    // Point published_publication_id to the new snapshot.
    await tx.query(
      `UPDATE landing_pages
          SET published_publication_id = $2, updated_at = now()
        WHERE id = $1;`,
      [lp.id, publicationId],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "landing_page.publish",
      targetType: "landing_page_publications",
      targetId: publicationId,
      after: { versionNumber: nextVersion, publishNote },
    });

    return { publicationId, versionNumber: nextVersion };
  });
}

/**
 * Revert to a specific published snapshot. Updates
 * `landing_pages.published_publication_id` to point to an existing
 * publication (identified by version_number). The snapshots are
 * immutable, so reverting does NOT modify the snapshot being restored.
 * Audited in the same SERIALIZABLE tx.
 */
export async function revertLandingPage(
  principal: Principal,
  academyId: string,
  versionNumber: number,
  db: DbClient = getDb(),
): Promise<{ publicationId: string; versionNumber: number }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  return db.withTxSerializable(async (tx) => {
    // Lock the landing page.
    const lpResult = await tx.query<{ id: string; published_publication_id: string | null }>(
      `SELECT id, published_publication_id FROM landing_pages WHERE academy_id = $1 LIMIT 1;`,
      [academyId],
    );
    const lp = lpResult.rows[0] as { id: string; published_publication_id: string | null } | undefined;
    if (!lp) throw Err.notFound("No landing page for this academy.");
    await tx.query(`SELECT id FROM landing_pages WHERE id = $1 FOR UPDATE;`, [lp.id]);

    // Find the target publication by version_number.
    const pubResult = await tx.query<{ id: string; version_number: number }>(
      `SELECT id, version_number
         FROM landing_page_publications
        WHERE landing_page_id = $1 AND version_number = $2
        LIMIT 1;`,
      [lp.id, versionNumber],
    );
    const pub = pubResult.rows[0] as { id: string; version_number: number } | undefined;
    if (!pub) throw Err.notFound(`Publication version ${versionNumber} not found for this academy.`);

    // Update the pointer (does NOT modify the snapshot).
    await tx.query(
      `UPDATE landing_pages SET published_publication_id = $2, updated_at = now() WHERE id = $1;`,
      [lp.id, pub.id],
    );

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "landing_page.revert",
      targetType: "landing_pages", targetId: lp.id,
      before: { publishedPublicationId: lp.published_publication_id },
      after: { publishedPublicationId: pub.id, versionNumber: pub.version_number },
    });

    return { publicationId: pub.id, versionNumber: pub.version_number };
  });
}

/**
 * List all publications for an academy (Admin — audit history).
 */
export async function listLandingPagePublications(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<LandingPagePublicationRow[]> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  const result = await db.query<LandingPagePublicationRow>(
    `SELECT pub.id, pub.landing_page_id AS "landingPageId",
            pub.version_number AS "versionNumber", pub.content,
            pub.published_by AS "publishedBy",
            to_char(pub.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "publishedAt",
            pub.publish_note AS "publishNote"
       FROM landing_page_publications pub
       JOIN landing_pages lp ON lp.id = pub.landing_page_id
      WHERE lp.academy_id = $1
      ORDER BY pub.version_number DESC;`,
    [academyId],
  );
  return result.rows as LandingPagePublicationRow[];
}

// === Gallery items ======================================================

export interface UpsertGalleryItemInput {
  title: string;
  mediaKey?: string | null;
  mediaType?: "image" | "video";
  displayOrder?: number;
  isFeatured?: boolean;
  isPublished?: boolean;
}

export async function createGalleryItem(
  principal: Principal,
  academyId: string,
  input: UpsertGalleryItemInput,
  db: DbClient = getDb(),
): Promise<{ id: string }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!input.title || input.title.trim() === "") {
    throw Err.validation("Gallery item title is required.");
  }

  return db.withTxSerializable(async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO gallery_items
         (id, academy_id, title, media_key, media_type, display_order, is_featured, is_published, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [
        id, academyId, input.title,
        input.mediaKey ?? null,
        input.mediaType ?? "image",
        input.displayOrder ?? 0,
        input.isFeatured ?? false,
        input.isPublished ?? false,
        principal.userId,
      ],
    );
    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "gallery_item.create",
      targetType: "gallery_items", targetId: id,
      after: { title: input.title },
    });
    return { id };
  });
}

export async function listGalleryItems(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<GalleryItemRow[]> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);
  const result = await db.query<GalleryItemRow>(
    `SELECT id, academy_id AS "academyId", title, media_key AS "mediaKey",
            media_type AS "mediaType", display_order AS "displayOrder",
            is_featured AS "isFeatured", is_published AS "isPublished",
            created_by AS "createdBy",
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
       FROM gallery_items
      WHERE academy_id = $1
      ORDER BY display_order, created_at;`,
    [academyId],
  );
  return result.rows as GalleryItemRow[];
}

/**
 * Update a gallery item's metadata (title, mediaKey, displayOrder,
 * isFeatured, isPublished). Academy-scoped (cross-academy → 404).
 * Uses soft deactivation (is_published=false) rather than hard delete,
 * preserving publication history. Audited in the same SERIALIZABLE tx.
 */
export interface UpdateGalleryItemInput {
  title?: string;
  mediaKey?: string | null;
  mediaType?: "image" | "video";
  displayOrder?: number;
  isFeatured?: boolean;
  isPublished?: boolean;
}

export async function updateGalleryItem(
  principal: Principal,
  academyId: string,
  itemId: string,
  input: UpdateGalleryItemInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (input.title !== undefined && (input.title.trim() === "")) {
    throw Err.validation("Gallery item title cannot be empty.");
  }

  return db.withTxSerializable(async (tx) => {
    // Load + lock (academy-scoped).
    const result = await tx.query<{ id: string; title: string; media_key: string | null; display_order: number; is_featured: boolean; is_published: boolean }>(
      `SELECT id, title, media_key, display_order, is_featured, is_published
         FROM gallery_items
        WHERE id = $1 AND academy_id = $2
        LIMIT 1;`,
      [itemId, academyId],
    );
    const row = result.rows[0] as { id: string; title: string; media_key: string | null; display_order: number; is_featured: boolean; is_published: boolean } | undefined;
    if (!row) throw Err.notFound("Gallery item not found in this academy.");
    await tx.query(`SELECT id FROM gallery_items WHERE id = $1 FOR UPDATE;`, [row.id]);

    const before = { title: row.title, mediaKey: row.media_key, displayOrder: row.display_order, isFeatured: row.is_featured, isPublished: row.is_published };

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [row.id];
    if (input.title !== undefined) { params.push(input.title); sets.push(`title = $${params.length}`); }
    if (input.mediaKey !== undefined) { params.push(input.mediaKey); sets.push(`media_key = $${params.length}`); }
    if (input.mediaType !== undefined) { params.push(input.mediaType); sets.push(`media_type = $${params.length}`); }
    if (input.displayOrder !== undefined) { params.push(input.displayOrder); sets.push(`display_order = $${params.length}`); }
    if (input.isFeatured !== undefined) { params.push(input.isFeatured); sets.push(`is_featured = $${params.length}`); }
    if (input.isPublished !== undefined) { params.push(input.isPublished); sets.push(`is_published = $${params.length}`); }

    await tx.query(`UPDATE gallery_items SET ${sets.join(", ")} WHERE id = $1;`, params);

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "gallery_item.update",
      targetType: "gallery_items", targetId: row.id,
      before, after: input,
    });
  });
}

// === YouTube videos ====================================================

export interface CreateYoutubeVideoInput {
  title: string;
  url: string;
  displayOrder?: number;
  isFeatured?: boolean;
  isPublished?: boolean;
}

/**
 * Extract the canonical 11-char YouTube video ID from a URL.
 * Accepts:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 * Returns null if the URL is invalid or the video ID is not 11 chars.
 */
export function extractYoutubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    // youtu.be short link.
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      return id.length === 11 ? id : null;
    }
    // youtube.com/watch?v=ID
    if (u.hostname === "youtube.com" || u.hostname === "www.youtube.com") {
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        return v && v.length === 11 ? v : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function createYoutubeVideo(
  principal: Principal,
  academyId: string,
  input: CreateYoutubeVideoInput,
  db: DbClient = getDb(),
): Promise<{ id: string; videoId: string }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!input.title || input.title.trim() === "") {
    throw Err.validation("Video title is required.");
  }
  const videoId = extractYoutubeVideoId(input.url);
  if (!videoId) {
    throw Err.validation("Invalid YouTube URL. Use https://www.youtube.com/watch?v=ID or https://youtu.be/ID.");
  }

  return db.withTxSerializable(async (tx) => {
    const id = newId();
    try {
      await tx.query(
        `INSERT INTO youtube_videos
           (id, academy_id, title, video_id, url, display_order, is_featured, is_published, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          id, academyId, input.title, videoId, input.url,
          input.displayOrder ?? 0,
          input.isFeatured ?? false,
          input.isPublished ?? false,
          principal.userId,
        ],
      );
    } catch {
      // UNIQUE(academy_id, video_id) — duplicate video.
      throw Err.conflict("This YouTube video already exists for this academy.");
    }
    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "youtube_video.create",
      targetType: "youtube_videos", targetId: id,
      after: { title: input.title, videoId },
    });
    return { id, videoId };
  });
}

export async function listYoutubeVideos(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<YoutubeVideoRow[]> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);
  const result = await db.query<YoutubeVideoRow>(
    `SELECT id, academy_id AS "academyId", title, video_id AS "videoId", url,
            display_order AS "displayOrder", is_featured AS "isFeatured",
            is_published AS "isPublished", created_by AS "createdBy",
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
       FROM youtube_videos
      WHERE academy_id = $1
      ORDER BY display_order, created_at;`,
    [academyId],
  );
  return result.rows as YoutubeVideoRow[];
}

/**
 * Update a YouTube highlight video's metadata (title, url, displayOrder,
 * isFeatured, isPublished). Academy-scoped (cross-academy → 404).
 * If url is changed, re-extracts the canonical video_id. Audited.
 */
export interface UpdateYoutubeVideoInput {
  title?: string;
  url?: string;
  displayOrder?: number;
  isFeatured?: boolean;
  isPublished?: boolean;
}

export async function updateYoutubeVideo(
  principal: Principal,
  academyId: string,
  videoId: string,
  input: UpdateYoutubeVideoInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (input.title !== undefined && input.title.trim() === "") {
    throw Err.validation("Video title cannot be empty.");
  }

  // If URL is changing, extract the new canonical video_id.
  let newCanonicalId: string | null = null;
  if (input.url !== undefined) {
    newCanonicalId = extractYoutubeVideoId(input.url);
    if (!newCanonicalId) {
      throw Err.validation("Invalid YouTube URL. Use https://www.youtube.com/watch?v=ID or https://youtu.be/ID.");
    }
  }

  return db.withTxSerializable(async (tx) => {
    const result = await tx.query<{ id: string; title: string; video_id: string; url: string; display_order: number; is_featured: boolean; is_published: boolean }>(
      `SELECT id, title, video_id, url, display_order, is_featured, is_published
         FROM youtube_videos
        WHERE id = $1 AND academy_id = $2
        LIMIT 1;`,
      [videoId, academyId],
    );
    const row = result.rows[0] as { id: string; title: string; video_id: string; url: string; display_order: number; is_featured: boolean; is_published: boolean } | undefined;
    if (!row) throw Err.notFound("YouTube video not found in this academy.");
    await tx.query(`SELECT id FROM youtube_videos WHERE id = $1 FOR UPDATE;`, [row.id]);

    const before = { title: row.title, url: row.url, displayOrder: row.display_order, isFeatured: row.is_featured, isPublished: row.is_published };

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [row.id];
    if (input.title !== undefined) { params.push(input.title); sets.push(`title = $${params.length}`); }
    if (input.url !== undefined && newCanonicalId) {
      params.push(input.url); sets.push(`url = $${params.length}`);
      params.push(newCanonicalId); sets.push(`video_id = $${params.length}`);
    }
    if (input.displayOrder !== undefined) { params.push(input.displayOrder); sets.push(`display_order = $${params.length}`); }
    if (input.isFeatured !== undefined) { params.push(input.isFeatured); sets.push(`is_featured = $${params.length}`); }
    if (input.isPublished !== undefined) { params.push(input.isPublished); sets.push(`is_published = $${params.length}`); }

    await tx.query(`UPDATE youtube_videos SET ${sets.join(", ")} WHERE id = $1;`, params);

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "youtube_video.update",
      targetType: "youtube_videos", targetId: row.id,
      before, after: input,
    });
  });
}

// Stable stringify for body hashing (reused pattern from payments).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function computeContentHash(content: unknown): string {
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}
