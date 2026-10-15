/**
 * Domain: Student enrollments.
 *
 * Enforces:
 *   - Effective-dated enrollments (no overwrite of history).
 *   - At most one currently-active enrollment per student (DB-enforced
 *     via partial UNIQUE index, but also checked here for a clearer
 *     error message before the DB rejects it).
 *   - Class transfer: closes the old enrollment (sets effective_to) and
 *     creates a new one. Existing packages and their class_id_at_purchase
 *     are UNCHANGED (DB trigger prevents modification). New packages use
 *     the new enrollment's class.
 *   - Academy scoping: the student and class must both belong to the
 *     principal's academy.
 *
 * All operations run in a SERIALIZABLE transaction.
 */

import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  loadStudentInAcademy,
  loadClassInAcademy,
  loadActiveEnrollment,
  newId,
  type EnrollmentRow,
} from "./helpers";

export interface CreateEnrollmentInput {
  studentId: string;
  classId: string;
  effectiveFrom: Date;
}

export interface TransferClassInput {
  studentId: string;
  newClassId: string;
  effectiveFrom: Date;
  reason?: string;
}

/**
 * Create a new enrollment for a student in a class. If the student already
 * has an active enrollment, this fails (use `transferClass` instead).
 */
export async function createEnrollment(
  principal: Principal,
  academyId: string,
  input: CreateEnrollmentInput,
  db: DbClient = getDb(),
): Promise<EnrollmentRow> {
  requireAcademyContext(principal, academyId);

  // Validate academy scoping.
  await loadStudentInAcademy(db, input.studentId, academyId);
  await loadClassInAcademy(db, input.classId, academyId);

  return db.withTxSerializable(async (tx) => {
    // Check for existing active enrollment.
    const existing = await loadActiveEnrollment(tx, input.studentId);
    if (existing) {
      throw Err.conflict("Student already has an active enrollment. Use transferClass to change classes.");
    }

    // Check for overlapping effective-date ranges (domain-level, since we
    // don't use EXCLUDE USING gist to avoid the btree_gist extension).
    const overlap = await tx.query(
      `SELECT id FROM student_enrollments
        WHERE student_id = $1
          AND effective_to IS NOT NULL
          AND effective_from <= $2
          AND effective_to >= $2
        LIMIT 1;`,
      [input.studentId, input.effectiveFrom],
    );
    if (overlap.rows.length > 0) {
      throw Err.conflict("Enrollment effective date overlaps with an existing historical enrollment.");
    }

    const id = newId();
    await tx.query(
      `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, NULL);`,
      [id, input.studentId, input.classId, input.effectiveFrom],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "enrollment.create",
      targetType: "student_enrollments",
      targetId: id,
      after: { studentId: input.studentId, classId: input.classId, effectiveFrom: input.effectiveFrom.toISOString() },
    });

    return {
      id,
      student_id: input.studentId,
      class_id: input.classId,
      effective_from: input.effectiveFrom,
      effective_to: null,
    };
  });
}

/**
 * Transfer a student to a new class. Closes the existing enrollment
 * (sets effective_to to the day before the new enrollment's effective_from)
 * and creates a new enrollment. Existing packages and their
 * class_id_at_purchase are UNCHANGED (the DB trigger prevents modification).
 */
export async function transferClass(
  principal: Principal,
  academyId: string,
  input: TransferClassInput,
  db: DbClient = getDb(),
): Promise<{ closedEnrollment: EnrollmentRow | null; newEnrollment: EnrollmentRow }> {
  requireAcademyContext(principal, academyId);

  await loadStudentInAcademy(db, input.studentId, academyId);
  await loadClassInAcademy(db, input.newClassId, academyId);

  return db.withTxSerializable(async (tx) => {
    const current = await loadActiveEnrollment(tx, input.studentId);

    if (current) {
      // Close the current enrollment. effective_to = day before new effective_from.
      const closedTo = new Date(input.effectiveFrom);
      closedTo.setDate(closedTo.getDate() - 1);

      if (closedTo < current.effective_from) {
        throw Err.validation("New enrollment effective date is before the current enrollment's start date.");
      }

      await tx.query(
        `UPDATE student_enrollments
            SET effective_to = $2, updated_at = now()
          WHERE id = $1;`,
        [current.id, closedTo],
      );

      await writeAudit({
        tx,
        academyId,
        actorUserId: principal.userId,
        action: "enrollment.close",
        targetType: "student_enrollments",
        targetId: current.id,
        before: { effectiveTo: null },
        after: { effectiveTo: closedTo.toISOString() },
        reason: input.reason,
      });
    }

    // Create new enrollment.
    const newEnrollmentId = newId();
    await tx.query(
      `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, NULL);`,
      [newEnrollmentId, input.studentId, input.newClassId, input.effectiveFrom],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "enrollment.transfer",
      targetType: "student_enrollments",
      targetId: newEnrollmentId,
      after: {
        studentId: input.studentId,
        newClassId: input.newClassId,
        effectiveFrom: input.effectiveFrom.toISOString(),
        previousClassId: current?.class_id ?? null,
      },
      reason: input.reason,
    });

    return {
      closedEnrollment: current,
      newEnrollment: {
        id: newEnrollmentId,
        student_id: input.studentId,
        class_id: input.newClassId,
        effective_from: input.effectiveFrom,
        effective_to: null,
      },
    };
  });
}

// === List enrollments (current + historical) ===============================

export interface EnrollmentWithClass extends EnrollmentRow {
  class_name: string;
}

export async function listEnrollments(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<EnrollmentWithClass[]> {
  requireAcademyContext(principal, academyId);
  // Verify student is in this academy (cross-academy → NOT_FOUND).
  await loadStudentInAcademy(db, studentId, academyId);

  const result = await db.query<EnrollmentWithClass>(
    `SELECT se.id, se.student_id, se.class_id, se.effective_from, se.effective_to,
            c.name AS class_name
       FROM student_enrollments se
       JOIN classes c ON c.id = se.class_id
      WHERE se.student_id = $1
        AND EXISTS (SELECT 1 FROM students s WHERE s.id = se.student_id AND s.academy_id = $2)
      ORDER BY se.effective_from DESC;`,
    [studentId, academyId],
  );
  return result.rows as EnrollmentWithClass[];
}

// === End enrollment ======================================================

export interface EndEnrollmentInput {
  effectiveTo: Date;
  reason?: string;
}

export async function endEnrollment(
  principal: Principal,
  academyId: string,
  studentId: string,
  input: EndEnrollmentInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  return db.withTxSerializable(async (tx) => {
    const student = await loadStudentInAcademy(tx, studentId, academyId);
    await tx.query(`SELECT id FROM students WHERE id = $1 FOR UPDATE;`, [student.id]);

    const current = await loadActiveEnrollment(tx, studentId);
    if (!current) {
      throw Err.conflict("Student has no active enrollment to end.");
    }

    if (input.effectiveTo < current.effective_from) {
      throw Err.validation("End date cannot be before the enrollment's start date.");
    }

    await tx.query(
      `UPDATE student_enrollments
          SET effective_to = $2, updated_at = now()
        WHERE id = $1;`,
      [current.id, input.effectiveTo],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "enrollment.end",
      targetType: "student_enrollments",
      targetId: current.id,
      before: { effectiveTo: null, classId: current.class_id },
      after: { effectiveTo: input.effectiveTo.toISOString() },
      reason: input.reason,
    });
  });
}

// === Class roster for a specific date ====================================

export interface RosterEntry {
  student_id: string;
  full_name: string;
  enrollment_id: string;
  effective_from: Date;
  effective_to: Date | null;
}

export async function getClassRoster(
  principal: Principal,
  academyId: string,
  classId: string,
  date: Date,
  db: DbClient = getDb(),
): Promise<RosterEntry[]> {
  requireAcademyContext(principal, academyId);
  // Verify class is in this academy.
  await loadClassInAcademy(db, classId, academyId);

  // Inclusive start, exclusive end: effective_from <= date AND (effective_to IS NULL OR effective_to > date)
  const result = await db.query<RosterEntry>(
    `SELECT s.id AS student_id, s.full_name, se.id AS enrollment_id,
            se.effective_from, se.effective_to
       FROM student_enrollments se
       JOIN students s ON s.id = se.student_id
      WHERE se.class_id = $1
        AND s.academy_id = $2
        AND se.effective_from <= $3
        AND (se.effective_to IS NULL OR se.effective_to > $3)
      ORDER BY s.full_name;`,
    [classId, academyId, date],
  );
  return result.rows as RosterEntry[];
}
