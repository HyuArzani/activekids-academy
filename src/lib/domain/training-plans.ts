/**
 * Coach training plans (migration 0018).
 *
 * A coach writes/updates a plan for a specific training occurrence.
 * Plans are optionally visible to parents of students enrolled in the
 * occurrence's class (visible_to_parents, default false).
 *
 * Authorization:
 *   - Coach writes: must have coach role in the academy AND be assigned
 *     to the occurrence's class (direct coach_student_assignments check,
 *     same policy as coach attendance).
 *   - Parent reads: must be a guardian of the student; only plans with
 *     visible_to_parents=true for occurrences the student was enrolled
 *     in on the occurrence date are returned.
 *
 * Server-only. Never import from client code.
 */

import { randomUUID } from "node:crypto";
import { Err } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import { getDb, type DbClient } from "@/lib/db";
import { requireAcademyContext } from "./helpers";

export interface TrainingPlan {
  id: string;
  occurrence_id: string;
  author_user_id: string;
  title: string;
  content: string;
  visible_to_parents: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Public shape returned over the API (camelCase for the client). */
export interface TrainingPlanDto {
  id: string;
  occurrenceId: string;
  occurrenceDate: string;
  className: string;
  title: string;
  content: string;
  visibleToParents: boolean;
  updatedAt: string;
}

/**
 * Verify the coach is assigned to the given occurrence's class. Mirrors
 * the coach-attendance policy: an active coach_student_assignments row
 * for the coach covering the student/class scope.
 */
async function verifyCoachOccurrenceAccess(
  db: DbClient,
  principal: Principal,
  academyId: string,
  occurrenceId: string,
): Promise<{ classId: string }> {
  const occurrence = await db.query<{ class_id: string }>(
    `SELECT class_id FROM training_occurrences
      WHERE id = $1 AND academy_id = $2;`,
    [occurrenceId, academyId],
  );
  if (occurrence.rows.length === 0) throw Err.notFound("Occurrence not found.");
  const classId = occurrence.rows[0]!.class_id;

  // Assigned coaches: explicit student assignment in this class, or a
  // class-scoped assignment row. Admins bypass via their admin role
  // (checked by the caller before invoking this for coach-only flows).
  const assigned = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
       FROM coach_student_assignments csa
      WHERE csa.coach_user_id = $1
        AND csa.is_active = true
        AND (csa.class_id IS NULL OR csa.class_id = $2);`,
    [principal.userId, classId],
  );
  if ((assigned.rows[0] as { c: number }).c === 0) {
    throw Err.forbidden("Coach is not assigned to this occurrence.");
  }
  return { classId };
}

function toDto(
  row: TrainingPlan & { occurrence_date?: string | Date; class_name?: string },
): TrainingPlanDto {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    occurrenceDate:
      row.occurrence_date !== undefined
        ? typeof row.occurrence_date === "string"
          ? row.occurrence_date
          : new Date(row.occurrence_date).toISOString().slice(0, 10)
        : "",
    className: row.class_name ?? "",
    title: row.title,
    content: row.content,
    visibleToParents: row.visible_to_parents,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Get the plan for an occurrence (coach or admin view — full access). */
export async function getCoachPlan(
  principal: Principal,
  academyId: string,
  occurrenceId: string,
  db: DbClient = getDb(),
): Promise<TrainingPlanDto | null> {
  requireAcademyContext(principal, academyId);
  const isAdmin = principal.memberships.some(
    (m) => m.academyId === academyId && m.role === "admin",
  );
  if (!isAdmin) {
    requireRole(principal, "coach", academyId);
    await verifyCoachOccurrenceAccess(db, principal, academyId, occurrenceId);
  }
  const result = await db.query<TrainingPlan & { occurrence_date: Date; class_name: string }>(
    `SELECT tp.*, tocc.occurrence_date, c.name AS class_name
       FROM training_plans tp
       JOIN training_occurrences tocc ON tocc.id = tp.occurrence_id
       JOIN classes c ON c.id = tocc.class_id
      WHERE tp.occurrence_id = $1 AND tp.academy_id = $2;`,
    [occurrenceId, academyId],
  );
  return result.rows.length > 0 ? toDto(result.rows[0]!) : null;
}

/** Create or update (upsert) the plan for an occurrence as a coach. */
export async function upsertCoachPlan(
  principal: Principal,
  academyId: string,
  occurrenceId: string,
  input: { title: string; content: string; visibleToParents?: boolean },
  db: DbClient = getDb(),
): Promise<TrainingPlanDto> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "coach", academyId);
  await verifyCoachOccurrenceAccess(db, principal, academyId, occurrenceId);
  const id = randomUUID();
  const result = await db.query<TrainingPlan & { occurrence_date: Date; class_name: string }>(
    `INSERT INTO training_plans
        (id, academy_id, occurrence_id, author_user_id, title, content, visible_to_parents)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (occurrence_id) DO UPDATE SET
        author_user_id = EXCLUDED.author_user_id,
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        visible_to_parents = EXCLUDED.visible_to_parents,
        updated_at = now()
     RETURNING id, occurrence_id, author_user_id, title, content,
               visible_to_parents, created_at, updated_at;`,
    [
      id,
      academyId,
      occurrenceId,
      principal.userId,
      input.title,
      input.content,
      input.visibleToParents ?? false,
    ],
  );
  // Re-join for the DTO fields (occurrence_date, class_name).
  const full = await db.query<TrainingPlan & { occurrence_date: Date; class_name: string }>(
    `SELECT tp.*, tocc.occurrence_date, c.name AS class_name
       FROM training_plans tp
       JOIN training_occurrences tocc ON tocc.id = tp.occurrence_id
       JOIN classes c ON c.id = tocc.class_id
      WHERE tp.id = $1;`,
    [result.rows[0]!.id],
  );
  return toDto(full.rows[0]!);
}

/**
 * Parent reads: list parent-visible plans for occurrences the child was
 * enrolled in. Only plans explicitly shared (visible_to_parents=true)
 * are returned; the plan body is included but author identity is not.
 */
export async function listParentPlans(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<TrainingPlanDto[]> {
  requireAcademyContext(principal, academyId);
  // Guardian verification (same policy as parent-portal).
  const guardian = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
       FROM guardian_student_links gsl
       JOIN students s ON s.id = gsl.student_id
      WHERE gsl.guardian_user_id = $1 AND gsl.student_id = $2 AND s.academy_id = $3;`,
    [principal.userId, studentId, academyId],
  );
  if ((guardian.rows[0] as { c: number }).c === 0) {
    throw Err.notFound("Student not found.");
  }
  const result = await db.query<TrainingPlan & { occurrence_date: Date; class_name: string }>(
    `SELECT DISTINCT tp.*, tocc.occurrence_date, c.name AS class_name
       FROM training_plans tp
       JOIN training_occurrences tocc ON tocc.id = tp.occurrence_id
       JOIN classes c ON c.id = tocc.class_id
       JOIN student_enrollments se ON se.class_id = tocc.class_id
         AND se.effective_from <= tocc.occurrence_date
         AND (se.effective_to IS NULL OR se.effective_to > tocc.occurrence_date)
      WHERE tp.academy_id = $1
        AND tp.visible_to_parents = true
        AND se.student_id = $2
      ORDER BY tocc.occurrence_date DESC
      LIMIT 100;`,
    [academyId, studentId],
  );
  return result.rows.map(toDto);
}
