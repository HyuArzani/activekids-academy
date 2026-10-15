/**
 * Academy-scoped domain loaders.
 *
 * These helpers enforce academy isolation at the query level: every load
 * filters by `academy_id` so that a valid UUID from a DIFFERENT academy
 * returns NOT_FOUND (not the other academy's data). This is the
 * application-level academy isolation that the DB schema cannot enforce
 * alone (the DB doesn't know which academy the request is for — that
 * comes from the authenticated principal's membership).
 *
 * Every domain service function calls these helpers (or equivalent inline
 * queries with academy_id filtering) before mutating any record.
 *
 * Server-only. Never import from client code.
 */

import { randomUUID } from "node:crypto";
import type { DbClient, TxClient } from "@/lib/db";
import { Err } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";
import { requireAcademyMembership } from "@/lib/auth/principal";

// --- Row types ------------------------------------------------------------

export interface StudentRow {
  id: string;
  academy_id: string;
  full_name: string;
  date_of_birth: Date | null;
  gender: string | null;
  notes: string | null;
  archived_at: Date | null;
}

export interface ClassRow {
  id: string;
  academy_id: string;
  name: string;
  capacity: number;
  is_active: boolean;
}

export interface EnrollmentRow {
  id: string;
  student_id: string;
  class_id: string;
  effective_from: Date;
  effective_to: Date | null;
}

export interface ScheduleVersionRow {
  id: string;
  class_id: string;
  effective_from: Date;
  effective_to: Date | null;
  status: string;
}

export interface ScheduleSlotRow {
  id: string;
  schedule_version_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  capacity_override: number | null;
}

export interface TrainingOccurrenceRow {
  id: string;
  academy_id: string;
  class_id: string;
  schedule_slot_id: string;
  schedule_version_id: string;
  occurrence_date: Date;
  start_at: Date;
  end_at: Date;
  status: string;
  capacity: number;
  cancelled_at: Date | null;
  cancelled_reason: string | null;
}

export interface PackagePlanRow {
  id: string;
  academy_id: string;
  name: string;
  session_count: number;
  is_active: boolean;
}

export interface StudentPackageRow {
  id: string;
  student_id: string;
  package_plan_id: string;
  class_id_at_purchase: string;
  skip_allowance: number;
  status: string;
  purchased_at: Date;
}

export interface EntitlementRow {
  id: string;
  student_package_id: string;
  sequence: number;
  original_occurrence_id: string | null;
  assigned_occurrence_id: string | null;
  status: string;
  skip_used: boolean;
}

// --- Academy-scoped loaders ----------------------------------------------

/**
 * Require that the principal has a membership in the given academy.
 * Throws FORBIDDEN if not. All domain service functions call this first.
 */
export function requireAcademyContext(principal: Principal, academyId: string): void {
  requireAcademyMembership(principal, academyId);
}

/** Load a student scoped to the academy. Cross-academy UUID → NOT_FOUND. */
export async function loadStudentInAcademy(
  db: DbClient | TxClient,
  studentId: string,
  academyId: string,
): Promise<StudentRow> {
  const result = await db.query<StudentRow>(
    `SELECT id, academy_id, full_name, date_of_birth, gender, notes, archived_at
       FROM students
      WHERE id = $1 AND academy_id = $2
      LIMIT 1;`,
    [studentId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Student not found in this academy");
  return result.rows[0] as StudentRow;
}

/** Load a class scoped to the academy. */
export async function loadClassInAcademy(
  db: DbClient | TxClient,
  classId: string,
  academyId: string,
): Promise<ClassRow> {
  const result = await db.query<ClassRow>(
    `SELECT id, academy_id, name, capacity, is_active
       FROM classes
      WHERE id = $1 AND academy_id = $2
      LIMIT 1;`,
    [classId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Class not found in this academy");
  return result.rows[0] as ClassRow;
}

/** Load a package plan scoped to the academy. */
export async function loadPackagePlanInAcademy(
  db: DbClient | TxClient,
  planId: string,
  academyId: string,
): Promise<PackagePlanRow> {
  const result = await db.query<PackagePlanRow>(
    `SELECT id, academy_id, name, session_count, is_active
       FROM package_plans
      WHERE id = $1 AND academy_id = $2
      LIMIT 1;`,
    [planId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Package plan not found in this academy");
  return result.rows[0] as PackagePlanRow;
}

/** Load a training occurrence scoped to the academy. */
export async function loadOccurrenceInAcademy(
  db: DbClient | TxClient,
  occurrenceId: string,
  academyId: string,
): Promise<TrainingOccurrenceRow> {
  const result = await db.query<TrainingOccurrenceRow>(
    `SELECT id, academy_id, class_id, schedule_slot_id, schedule_version_id,
            occurrence_date, start_at, end_at, status, capacity,
            cancelled_at, cancelled_reason
       FROM training_occurrences
      WHERE id = $1 AND academy_id = $2
      LIMIT 1;`,
    [occurrenceId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Training occurrence not found in this academy");
  return result.rows[0] as TrainingOccurrenceRow;
}

/**
 * Load an entitlement scoped to the academy (via package → student →
 * academy). This JOIN ensures cross-academy entitlement access fails even
 * with a valid UUID.
 */
export async function loadEntitlementInAcademy(
  db: DbClient | TxClient,
  entitlementId: string,
  academyId: string,
): Promise<EntitlementRow> {
  const result = await db.query<EntitlementRow>(
    `SELECT e.id, e.student_package_id, e.sequence, e.original_occurrence_id,
            e.assigned_occurrence_id, e.status, e.skip_used
       FROM session_entitlements e
       JOIN student_packages sp ON sp.id = e.student_package_id
       JOIN students s ON s.id = sp.student_id
      WHERE e.id = $1 AND s.academy_id = $2
      LIMIT 1;`,
    [entitlementId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Entitlement not found in this academy");
  return result.rows[0] as EntitlementRow;
}

/**
 * Load a student package scoped to the academy (via student → academy).
 */
export async function loadStudentPackageInAcademy(
  db: DbClient | TxClient,
  packageId: string,
  academyId: string,
): Promise<StudentPackageRow> {
  const result = await db.query<StudentPackageRow>(
    `SELECT sp.id, sp.student_id, sp.package_plan_id, sp.class_id_at_purchase,
            sp.skip_allowance, sp.status, sp.purchased_at
       FROM student_packages sp
       JOIN students s ON s.id = sp.student_id
      WHERE sp.id = $1 AND s.academy_id = $2
      LIMIT 1;`,
    [packageId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Student package not found in this academy");
  return result.rows[0] as StudentPackageRow;
}

/** Load the currently-active enrollment for a student (effective_to IS NULL). */
export async function loadActiveEnrollment(
  db: DbClient | TxClient,
  studentId: string,
): Promise<EnrollmentRow | null> {
  const result = await db.query<EnrollmentRow>(
    `SELECT id, student_id, class_id, effective_from, effective_to
       FROM student_enrollments
      WHERE student_id = $1 AND effective_to IS NULL
      LIMIT 1;`,
    [studentId],
  );
  return (result.rows[0] as EnrollmentRow | undefined) ?? null;
}

/** Load the active schedule version for a class (effective_to IS NULL, status='active'). */
export async function loadActiveScheduleVersion(
  db: DbClient | TxClient,
  classId: string,
): Promise<ScheduleVersionRow | null> {
  const result = await db.query<ScheduleVersionRow>(
    `SELECT id, class_id, effective_from, effective_to, status
       FROM schedule_versions
      WHERE class_id = $1 AND effective_to IS NULL AND status = 'active'
      LIMIT 1;`,
    [classId],
  );
  return (result.rows[0] as ScheduleVersionRow | undefined) ?? null;
}

/** Generate a new UUID (application-side, no pgcrypto dependency). */
export function newId(): string {
  return randomUUID();
}
