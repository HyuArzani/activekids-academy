/**
 * Domain: Attendance recording.
 *
 * Enforces invariant #10: no duplicate bookings (DB UNIQUE on
 * (occurrence_id, student_id)) and no over-capacity assignments.
 *
 * When attendance is recorded against an entitlement:
 *   - 'present' → entitlement status = 'completed'
 *   - 'absent' → no entitlement status change (student didn't attend)
 *   - 'excused' → handled by `excusedAbsence` in entitlements.ts (does NOT
 *     consume skip). `recordAttendance` does NOT call `excusedAbsence`
 *     internally — the admin is expected to invoke it separately when
 *     recording an excused absence that should also release the
 *     occurrence assignment. (See "Known ambiguity" note below.)
 *   - 'late' → entitlement status = 'completed'
 *
 * Academy scoping: the occurrence, student, and entitlement (if any) must
 * all belong to the principal's academy.
 *
 * === Known ambiguity (preserved, not invented) ============================
 *
 * The existing `recordAttendance` couples 'present'/'late' attendance to
 * an entitlement transition (active → completed) but provides NO revert
 * path when status later changes to 'absent' or 'excused'. Corrections
 * (`updateAttendance`, `correctAttendance`) follow the SAME forward-only
 * rule: present/late → completed (if active); absent/excused → no change.
 * Reverting a completed entitlement to active on a status correction is
 * NOT implemented because no existing domain service defines that
 * transition, and inventing one is out of scope (Stage 4 boundary).
 *
 * Additionally, `recordAttendance` accepts an `entitlementId` without
 * verifying that the entitlement's `assigned_occurrence_id` matches the
 * occurrence being attended. This is a pre-existing design decision; we
 * preserve it rather than introduce a new coupling that could break
 * existing behavior.
 *
 * Both points are flagged for future stage review.
 */

import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  loadOccurrenceInAcademy,
  loadStudentInAcademy,
  loadEntitlementInAcademy,
  newId,
  type TrainingOccurrenceRow,
} from "./helpers";

// === Row types ===========================================================

export interface AttendanceRow {
  id: string;
  training_occurrence_id: string;
  student_id: string;
  entitlement_id: string | null;
  status: "present" | "absent" | "excused" | "late";
  recorded_by: string;
  recorded_at: Date;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AttendanceWithDetails extends AttendanceRow {
  occurrence_date: Date;
  occurrence_start_at: Date;
  class_id: string;
  class_name: string;
  student_full_name: string;
}

// === Helpers ==============================================================

/**
 * Verify the student was enrolled in the occurrence's class on the
 * occurrence's date. Uses the established effective-date convention:
 *   effective_from <= date AND (effective_to IS NULL OR effective_to > date)
 *
 * Throws VALIDATION_FAILED if the student was not eligible on that date.
 */
async function verifyEnrollmentOnDate(
  tx: TxClient,
  studentId: string,
  classId: string,
  occurrenceDate: Date,
): Promise<void> {
  const result = await tx.query<{ id: string }>(
    `SELECT se.id
       FROM student_enrollments se
       JOIN students s ON s.id = se.student_id
      WHERE se.student_id = $1
        AND se.class_id = $2
        AND se.effective_from <= $3
        AND (se.effective_to IS NULL OR se.effective_to > $3)
      LIMIT 1;`,
    [studentId, classId, occurrenceDate],
  );
  if (!result.rows[0]) {
    throw Err.validation(
      "Student was not enrolled in this class on the occurrence date.",
    );
  }
}

/**
 * Apply the existing attendance→entitlement rule: if status is 'present'
 * or 'late' AND the entitlement is currently 'active', mark it 'completed'
 * and record a 'completed' entitlement event. No revert path for
 * 'absent'/'excused' (see "Known ambiguity" above).
 */
async function applyEntitlementTransition(
  tx: TxClient,
  entitlementId: string | null,
  status: "present" | "absent" | "excused" | "late",
  actorUserId: string,
): Promise<void> {
  if (!entitlementId || (status !== "present" && status !== "late")) {
    return;
  }
  await tx.query(
    `UPDATE session_entitlements
        SET status = 'completed', updated_at = now()
      WHERE id = $1 AND status = 'active';`,
    [entitlementId],
  );
  await tx.query(
    `INSERT INTO entitlement_events
       (id, entitlement_id, event_type, occurred_at, actor_user_id, reason)
     VALUES ($1, $2, 'completed', now(), $3, $4);`,
    [newId(), entitlementId, actorUserId, `Attendance recorded as '${status}'`],
  );
}

// === Record attendance (existing, +enrollment check) =====================

export interface RecordAttendanceInput {
  occurrenceId: string;
  studentId: string;
  status: "present" | "absent" | "excused" | "late";
  entitlementId?: string;
  notes?: string;
}

export async function recordAttendance(
  principal: Principal,
  academyId: string,
  input: RecordAttendanceInput,
  db: DbClient = getDb(),
): Promise<{ attendanceId: string }> {
  requireAcademyContext(principal, academyId);

  // Validate academy scoping.
  const occ = await loadOccurrenceInAcademy(db, input.occurrenceId, academyId);
  await loadStudentInAcademy(db, input.studentId, academyId);
  if (input.entitlementId) {
    await loadEntitlementInAcademy(db, input.entitlementId, academyId);
  }

  return db.withTxSerializable(async (tx) => {
    // Lock the occurrence to prevent concurrent attendance writes.
    await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [input.occurrenceId]);

    // Verify enrollment eligibility on the occurrence date.
    await verifyEnrollmentOnDate(tx, input.studentId, occ.class_id, occ.occurrence_date);

    const id = newId();
    try {
      await tx.query(
        `INSERT INTO attendance_records
           (id, training_occurrence_id, student_id, entitlement_id, status, recorded_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [id, input.occurrenceId, input.studentId, input.entitlementId ?? null, input.status, principal.userId, input.notes ?? null],
      );
    } catch {
      // The DB UNIQUE on (occurrence_id, student_id) will reject duplicates.
      throw Err.conflict("Attendance already recorded for this student at this occurrence.");
    }

    // Apply the existing entitlement transition rule (present/late → completed).
    await applyEntitlementTransition(tx, input.entitlementId ?? null, input.status, principal.userId);

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "attendance.record",
      targetType: "attendance_records",
      targetId: id,
      after: {
        occurrenceId: input.occurrenceId,
        studentId: input.studentId,
        status: input.status,
        entitlementId: input.entitlementId ?? null,
      },
    });

    return { attendanceId: id };
  });
}

// === Update attendance (regular, no reason required) ======================

export interface UpdateAttendanceInput {
  status?: "present" | "absent" | "excused" | "late";
  notes?: string | null;
}

/**
 * Update an existing attendance record's status and/or notes. Does NOT
 * require a reason (use `correctAttendance` for historical corrections
 * that require an audit trail with a reason).
 *
 * If `status` changes to 'present'/'late' and a linked entitlement is
 * 'active', the entitlement is marked 'completed' (same forward-only
 * rule as `recordAttendance`). No revert for 'absent'/'excused'.
 *
 * Academy-scoped: the attendance record (via occurrence → academy) must
 * belong to the principal's academy.
 */
export async function updateAttendance(
  principal: Principal,
  academyId: string,
  attendanceId: string,
  input: UpdateAttendanceInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  if (input.status === undefined && input.notes === undefined) {
    throw Err.validation("Nothing to update (provide status and/or notes).");
  }

  return db.withTxSerializable(async (tx) => {
    // Lock + load the attendance record (academy-scoped via JOIN).
    const record = await loadAttendanceInAcademy(tx, attendanceId, academyId);
    await tx.query(`SELECT id FROM attendance_records WHERE id = $1 FOR UPDATE;`, [record.id]);

    const beforeState = {
      status: record.status,
      notes: record.notes,
    };

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [record.id];
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push(`notes = $${params.length}`);
    }

    await tx.query(
      `UPDATE attendance_records SET ${sets.join(", ")} WHERE id = $1;`,
      params,
    );

    // If status changed to present/late, apply the forward entitlement rule.
    if (input.status !== undefined && (input.status === "present" || input.status === "late")) {
      await applyEntitlementTransition(tx, record.entitlement_id, input.status, principal.userId);
    }

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "attendance.update",
      targetType: "attendance_records",
      targetId: record.id,
      before: beforeState,
      after: {
        status: input.status ?? beforeState.status,
        notes: input.notes === undefined ? beforeState.notes : input.notes,
      },
    });
  });
}

// === Correct historical attendance (admin, reason required) =============

export interface CorrectAttendanceInput {
  status: "present" | "absent" | "excused" | "late";
  reason: string;
  notes?: string | null;
}

/**
 * Admin-correct a historical attendance record. Requires admin role and
 * a non-empty reason. Records an audit event with the reason in the same
 * transaction.
 *
 * Same forward-only entitlement rule as `recordAttendance`:
 * present/late → completed (if active); absent/excused → no revert.
 *
 * Invariant #9: admin corrections require admin role + non-empty reason
 * + audit (analogous to `adminCorrect` in entitlements.ts).
 */
export async function correctAttendance(
  principal: Principal,
  academyId: string,
  attendanceId: string,
  input: CorrectAttendanceInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!input.reason || input.reason.trim() === "") {
    throw Err.validation("A non-empty reason is required for attendance corrections.");
  }

  return db.withTxSerializable(async (tx) => {
    const record = await loadAttendanceInAcademy(tx, attendanceId, academyId);
    await tx.query(`SELECT id FROM attendance_records WHERE id = $1 FOR UPDATE;`, [record.id]);

    const beforeState = {
      status: record.status,
      notes: record.notes,
    };

    const sets: string[] = ["status = $2", "updated_at = now()"];
    const params: unknown[] = [record.id, input.status];
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push(`notes = $${params.length}`);
    }

    await tx.query(
      `UPDATE attendance_records SET ${sets.join(", ")} WHERE id = $1;`,
      params,
    );

    // Apply the forward entitlement rule for present/late.
    if (input.status === "present" || input.status === "late") {
      await applyEntitlementTransition(tx, record.entitlement_id, input.status, principal.userId);
    }

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "attendance.correct",
      targetType: "attendance_records",
      targetId: record.id,
      before: beforeState,
      after: { status: input.status, notes: input.notes ?? beforeState.notes },
      reason: input.reason,
    });
  });
}

// === Occurrence roster ===================================================

export interface OccurrenceRosterEntry {
  student_id: string;
  full_name: string;
  enrollment_id: string;
  effective_from: Date;
  effective_to: Date | null;
  attendance_id: string | null;
  attendance_status: "present" | "absent" | "excused" | "late" | null;
}

/**
 * List the roster for a training occurrence: all students enrolled in
 * the occurrence's class on the occurrence's date. Includes any existing
 * attendance row for each student at this occurrence.
 *
 * Academy-scoped: the occurrence must belong to the principal's academy.
 */
export async function getOccurrenceRoster(
  principal: Principal,
  academyId: string,
  occurrenceId: string,
  db: DbClient = getDb(),
): Promise<{ occurrence: TrainingOccurrenceRow; roster: OccurrenceRosterEntry[] }> {
  requireAcademyContext(principal, academyId);
  const occ = await loadOccurrenceInAcademy(db, occurrenceId, academyId);

  const result = await db.query<OccurrenceRosterEntry>(
    `SELECT s.id AS student_id, s.full_name, se.id AS enrollment_id,
            se.effective_from, se.effective_to,
            ar.id AS attendance_id, ar.status AS attendance_status
       FROM student_enrollments se
       JOIN students s ON s.id = se.student_id
  LEFT JOIN attendance_records ar
         ON ar.training_occurrence_id = $1
        AND ar.student_id = s.id
      WHERE se.class_id = $2
        AND s.academy_id = $3
        AND se.effective_from <= $4
        AND (se.effective_to IS NULL OR se.effective_to > $4)
      ORDER BY s.full_name;`,
    [occ.id, occ.class_id, academyId, occ.occurrence_date],
  );
  return { occurrence: occ, roster: result.rows as OccurrenceRosterEntry[] };
}

// === Attendance history ==================================================

/**
 * List all attendance records for a student (academy-scoped). Returns
 * details joined with occurrence + class for context.
 */
export async function listAttendanceForStudent(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<AttendanceWithDetails[]> {
  requireAcademyContext(principal, academyId);
  // Verify student is in this academy (cross-academy → NOT_FOUND).
  await loadStudentInAcademy(db, studentId, academyId);

  const result = await db.query<AttendanceWithDetails>(
    `SELECT ar.id, ar.training_occurrence_id, ar.student_id, ar.entitlement_id,
            ar.status, ar.recorded_by, ar.recorded_at, ar.notes,
            ar.created_at, ar.updated_at,
            tocc.occurrence_date, tocc.start_at AS occurrence_start_at,
            tocc.class_id, c.name AS class_name,
            s.full_name AS student_full_name
       FROM attendance_records ar
       JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
       JOIN classes c ON c.id = tocc.class_id
       JOIN students s ON s.id = ar.student_id
      WHERE ar.student_id = $1
        AND s.academy_id = $2
      ORDER BY tocc.occurrence_date DESC, tocc.start_at DESC;`,
    [studentId, academyId],
  );
  return result.rows as AttendanceWithDetails[];
}

/**
 * List all attendance records in a date range (academy-scoped). The date
 * range is applied to the occurrence date (inclusive on both ends).
 */
export async function listAttendanceForDateRange(
  principal: Principal,
  academyId: string,
  fromDate: Date,
  toDate: Date,
  db: DbClient = getDb(),
): Promise<AttendanceWithDetails[]> {
  requireAcademyContext(principal, academyId);

  if (toDate < fromDate) {
    throw Err.validation("toDate must be on or after fromDate.");
  }

  const result = await db.query<AttendanceWithDetails>(
    `SELECT ar.id, ar.training_occurrence_id, ar.student_id, ar.entitlement_id,
            ar.status, ar.recorded_by, ar.recorded_at, ar.notes,
            ar.created_at, ar.updated_at,
            tocc.occurrence_date, tocc.start_at AS occurrence_start_at,
            tocc.class_id, c.name AS class_name,
            s.full_name AS student_full_name
       FROM attendance_records ar
       JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
       JOIN classes c ON c.id = tocc.class_id
       JOIN students s ON s.id = ar.student_id
      WHERE s.academy_id = $1
        AND tocc.occurrence_date >= $2
        AND tocc.occurrence_date <= $3
      ORDER BY tocc.occurrence_date DESC, tocc.start_at DESC, s.full_name;`,
    [academyId, fromDate, toDate],
  );
  return result.rows as AttendanceWithDetails[];
}

// === Single attendance record (academy-scoped) ==========================

/**
 * Load a single attendance record (academy-scoped via JOIN to occurrence
 * → academy). Cross-academy UUID → NOT_FOUND.
 */
export async function getAttendance(
  principal: Principal,
  academyId: string,
  attendanceId: string,
  db: DbClient = getDb(),
): Promise<AttendanceWithDetails> {
  requireAcademyContext(principal, academyId);
  return loadAttendanceWithDetailsInAcademy(db, attendanceId, academyId);
}

// === Internal loaders ====================================================

/**
 * Load an attendance row scoped to the academy (via occurrence → academy).
 * Cross-academy UUID → NOT_FOUND. Suitable for use inside a transaction
 * (accepts TxClient).
 */
export async function loadAttendanceInAcademy(
  db: DbClient | TxClient,
  attendanceId: string,
  academyId: string,
): Promise<AttendanceRow> {
  const result = await db.query<AttendanceRow>(
    `SELECT ar.id, ar.training_occurrence_id, ar.student_id, ar.entitlement_id,
            ar.status, ar.recorded_by, ar.recorded_at, ar.notes,
            ar.created_at, ar.updated_at
       FROM attendance_records ar
       JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
      WHERE ar.id = $1 AND tocc.academy_id = $2
      LIMIT 1;`,
    [attendanceId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Attendance record not found in this academy");
  return result.rows[0] as AttendanceRow;
}

/**
 * Load an attendance row with joined details (occurrence, class, student).
 * Academy-scoped via occurrence → academy.
 */
export async function loadAttendanceWithDetailsInAcademy(
  db: DbClient | TxClient,
  attendanceId: string,
  academyId: string,
): Promise<AttendanceWithDetails> {
  const result = await db.query<AttendanceWithDetails>(
    `SELECT ar.id, ar.training_occurrence_id, ar.student_id, ar.entitlement_id,
            ar.status, ar.recorded_by, ar.recorded_at, ar.notes,
            ar.created_at, ar.updated_at,
            tocc.occurrence_date, tocc.start_at AS occurrence_start_at,
            tocc.class_id, c.name AS class_name,
            s.full_name AS student_full_name
       FROM attendance_records ar
       JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
       JOIN classes c ON c.id = tocc.class_id
       JOIN students s ON s.id = ar.student_id
      WHERE ar.id = $1 AND tocc.academy_id = $2
      LIMIT 1;`,
    [attendanceId, academyId],
  );
  if (!result.rows[0]) throw Err.notFound("Attendance record not found in this academy");
  return result.rows[0] as AttendanceWithDetails;
}
