/**
 * Domain: Student-specific training videos.
 *
 * Separate from public landing-page YouTube highlights (cms.ts). These
 * videos are associated with individual students and are NEVER exposed
 * through the public landing-page API.
 *
 * Authorization:
 *   - Admin: academy-scoped (any student in the admin's academy).
 *   - Coach: must have an active coach_student_assignment for the student.
 *   - Parent: must be linked via guardian_student_links to the student.
 *   - Cross-academy, cross-student, or unlinked access → 403/404.
 *
 * YouTube is manual-entry only. The URL is validated + canonical video_id
 * extracted. No YouTube Data API, OAuth, or downloads.
 *
 * Note: unlisted YouTube videos are NOT private. Access controls prevent
 * authorized users from seeing the video reference, but cannot prevent
 * sharing of the YouTube URL itself.
 *
 * Server-only. Never import from client code.
 */

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

// === Row types ==========================================================

export interface StudentVideoRow {
  id: string;
  studentId: string;
  uploadedBy: string;
  title: string;
  youtubeUrl: string;
  videoId: string;
  trainingDate: string | null;
  category: string | null;
  notes: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

// === YouTube URL extraction (reuses the pattern from cms.ts) ===========

export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      return id.length === 11 ? id : null;
    }
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

// === Authorization helpers ==============================================

/**
 * Verify the principal is authorized to access the student's videos.
 *   - Admin: must be an admin in the student's academy.
 *   - Coach: must have an active coach_student_assignment for the student
 *     in the student's academy.
 *   - Parent: must be linked via guardian_student_links.
 * Throws FORBIDDEN/NOT_FOUND if unauthorized.
 */
async function authorizeStudentAccess(
  tx: TxClient,
  principal: Principal,
  academyId: string,
  studentId: string,
  roles: ("admin" | "coach" | "parent")[],
): Promise<void> {
  // Load the student (academy-scoped).
  const studentResult = await tx.query<{ id: string }>(
    `SELECT id FROM students WHERE id = $1 AND academy_id = $2 LIMIT 1;`,
    [studentId, academyId],
  );
  if (!studentResult.rows[0]) {
    throw Err.notFound("Student not found in this academy.");
  }

  for (const role of roles) {
    if (role === "admin") {
      const membership = principal.memberships.find(
        (m) => m.academyId === academyId && m.role === "admin" && m.status === "active",
      );
      if (membership) return;
    }
    if (role === "coach") {
      const assignment = await tx.query<{ id: string }>(
        `SELECT csa.id
           FROM coach_student_assignments csa
          WHERE csa.coach_user_id = $1
            AND csa.student_id = $2
            AND csa.is_active = true
          LIMIT 1;`,
        [principal.userId, studentId],
      );
      if (assignment.rows[0]) return;
    }
    if (role === "parent") {
      const link = await tx.query<{ id: string }>(
        `SELECT gsl.id
           FROM guardian_student_links gsl
          WHERE gsl.guardian_user_id = $1
            AND gsl.student_id = $2
          LIMIT 1;`,
        [principal.userId, studentId],
      );
      if (link.rows[0]) return;
    }
  }

  throw Err.forbidden("You are not authorized to access this student's videos.");
}

// === Create =============================================================

export interface CreateStudentVideoInput {
  studentId: string;
  youtubeUrl: string;
  title: string;
  trainingDate?: string;
  category?: string;
  notes?: string;
  isPublished?: boolean;
}

export async function createStudentVideo(
  principal: Principal,
  academyId: string,
  input: CreateStudentVideoInput,
  db: DbClient = getDb(),
): Promise<{ id: string; videoId: string }> {
  requireAcademyContext(principal, academyId);

  if (!input.title || input.title.trim() === "") {
    throw Err.validation("Title is required.");
  }
  const videoId = extractVideoId(input.youtubeUrl);
  if (!videoId) {
    throw Err.validation("Invalid YouTube URL. Use https://www.youtube.com/watch?v=ID or https://youtu.be/ID.");
  }

  return db.withTxSerializable(async (tx) => {
    // Admin or coach can create; parent cannot.
    await authorizeStudentAccess(tx, principal, academyId, input.studentId, ["admin", "coach"]);

    const id = newId();
    await tx.query(
      `INSERT INTO student_training_videos
         (id, student_id, uploaded_by, title, youtube_url, training_date,
          category, notes, is_published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [
        id, input.studentId, principal.userId,
        input.title, input.youtubeUrl,
        input.trainingDate ?? null,
        input.category ?? null,
        input.notes ?? null,
        input.isPublished ?? false,
      ],
    );

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "student_video.create",
      targetType: "student_training_videos", targetId: id,
      after: { studentId: input.studentId, title: input.title, videoId },
    });

    return { id, videoId };
  });
}

// === List (by student) ==================================================

export async function listStudentVideos(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<StudentVideoRow[]> {
  requireAcademyContext(principal, academyId);

  return db.withTxSerializable(async (tx) => {
    // Admin, coach, or parent (linked) can list.
    await authorizeStudentAccess(tx, principal, academyId, studentId, ["admin", "coach", "parent"]);

    const result = await tx.query<StudentVideoRow>(
      `SELECT stv.id, stv.student_id AS "studentId",
              stv.uploaded_by AS "uploadedBy", stv.title,
              stv.youtube_url AS "youtubeUrl",
              to_char(stv.training_date, 'YYYY-MM-DD') AS "trainingDate",
              stv.category, stv.notes, stv.is_published AS "isPublished",
              to_char(stv.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
              to_char(stv.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "updatedAt"
         FROM student_training_videos stv
        WHERE stv.student_id = $1
        ORDER BY stv.created_at DESC;`,
      [studentId],
    );
    return result.rows as StudentVideoRow[];
  });
}

// === Update =============================================================

export interface UpdateStudentVideoInput {
  title?: string;
  youtubeUrl?: string;
  trainingDate?: string | null;
  category?: string | null;
  notes?: string | null;
  isPublished?: boolean;
}

export async function updateStudentVideo(
  principal: Principal,
  academyId: string,
  videoId: string,
  input: UpdateStudentVideoInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  if (input.title !== undefined && input.title.trim() === "") {
    throw Err.validation("Title cannot be empty.");
  }

  let newVideoId: string | null = null;
  if (input.youtubeUrl !== undefined) {
    newVideoId = extractVideoId(input.youtubeUrl);
    if (!newVideoId) {
      throw Err.validation("Invalid YouTube URL.");
    }
  }

  return db.withTxSerializable(async (tx) => {
    // Load the video (academy-scoped via student → academy).
    const result = await tx.query<{ id: string; student_id: string; title: string; youtube_url: string }>(
      `SELECT stv.id, stv.student_id, stv.title, stv.youtube_url
         FROM student_training_videos stv
         JOIN students s ON s.id = stv.student_id
        WHERE stv.id = $1 AND s.academy_id = $2
        LIMIT 1;`,
      [videoId, academyId],
    );
    const row = result.rows[0] as { id: string; student_id: string; title: string; youtube_url: string } | undefined;
    if (!row) throw Err.notFound("Training video not found in this academy.");

    // Admin or coach can update (parent cannot).
    await authorizeStudentAccess(tx, principal, academyId, row.student_id, ["admin", "coach"]);

    await tx.query(`SELECT id FROM student_training_videos WHERE id = $1 FOR UPDATE;`, [row.id]);

    const before = { title: row.title, youtubeUrl: row.youtube_url };

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [row.id];
    if (input.title !== undefined) { params.push(input.title); sets.push(`title = $${params.length}`); }
    if (input.youtubeUrl !== undefined && newVideoId) {
      params.push(input.youtubeUrl); sets.push(`youtube_url = $${params.length}`);
    }
    if (input.trainingDate !== undefined) { params.push(input.trainingDate); sets.push(`training_date = $${params.length}`); }
    if (input.category !== undefined) { params.push(input.category); sets.push(`category = $${params.length}`); }
    if (input.notes !== undefined) { params.push(input.notes); sets.push(`notes = $${params.length}`); }
    if (input.isPublished !== undefined) { params.push(input.isPublished); sets.push(`is_published = $${params.length}`); }

    await tx.query(`UPDATE student_training_videos SET ${sets.join(", ")} WHERE id = $1;`, params);

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "student_video.update",
      targetType: "student_training_videos", targetId: row.id,
      before, after: input,
    });
  });
}

// === Get single =========================================================

export async function getStudentVideo(
  principal: Principal,
  academyId: string,
  videoId: string,
  db: DbClient = getDb(),
): Promise<StudentVideoRow> {
  requireAcademyContext(principal, academyId);

  return db.withTxSerializable(async (tx) => {
    const result = await tx.query<StudentVideoRow>(
      `SELECT stv.id, stv.student_id AS "studentId",
              stv.uploaded_by AS "uploadedBy", stv.title,
              stv.youtube_url AS "youtubeUrl",
              to_char(stv.training_date, 'YYYY-MM-DD') AS "trainingDate",
              stv.category, stv.notes, stv.is_published AS "isPublished",
              to_char(stv.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
              to_char(stv.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "updatedAt"
         FROM student_training_videos stv
         JOIN students s ON s.id = stv.student_id
        WHERE stv.id = $1 AND s.academy_id = $2
        LIMIT 1;`,
      [videoId, academyId],
    );
    const row = result.rows[0] as StudentVideoRow | undefined;
    if (!row) throw Err.notFound("Training video not found in this academy.");

    // Admin, coach, or parent (linked) can view.
    await authorizeStudentAccess(tx, principal, academyId, row.studentId, ["admin", "coach", "parent"]);
    return row;
  });
}
