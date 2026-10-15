/**
 * Domain: Student operations.
 *
 * Enforces:
 *   - Academy scoping (every query filters by academy_id; cross-academy
 *     UUID access → NOT_FOUND).
 *   - Admin role required for all mutations.
 *   - Audit events written in the same transaction as mutations.
 *   - Archive is soft (sets archived_at; does not delete history).
 *
 * Server-only. Never import from client code.
 */

import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  loadStudentInAcademy,
  newId,
  type StudentRow,
} from "./helpers";

/**
 * Format a SQL DATE value as `YYYY-MM-DD` without timezone-dependent
 * conversion. Handles both Date objects (from PgLite, at UTC midnight)
 * and string values (from the pg adapter, which returns DATE as strings
 * via pool-scoped TypeOverrides).
 *
 * PostgreSQL DATE columns represent calendar dates (no timezone). Both
 * PgLite and pg return Date objects at UTC midnight by default, so
 * `toISOString().split("T")[0]` works. This helper adds a string fallback
 * for safety.
 */
export function formatDateOfBirth(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length >= 10 ? v.substring(0, 10) : v;
  if (v instanceof Date) return v.toISOString().split("T")[0]!;
  return String(v);
}

// === Create ===============================================================

export interface CreateStudentInput {
  fullName: string;
  dateOfBirth?: string; // ISO date string (YYYY-MM-DD)
  gender?: "male" | "female" | "unspecified";
  notes?: string;
}

export interface CreateStudentResult {
  id: string;
  academyId: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  notes: string | null;
}

export async function createStudent(
  principal: Principal,
  academyId: string,
  input: CreateStudentInput,
  db: DbClient = getDb(),
): Promise<CreateStudentResult> {
  requireAcademyContext(principal, academyId);

  if (!input.fullName || input.fullName.trim() === "") {
    throw Err.validation("Student full name is required.");
  }

  return db.withTxSerializable(async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO students (id, academy_id, full_name, date_of_birth, gender, notes)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [id, academyId, input.fullName.trim(), input.dateOfBirth ?? null, input.gender ?? null, input.notes ?? null],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "student.create",
      targetType: "students",
      targetId: id,
      after: { fullName: input.fullName, dateOfBirth: input.dateOfBirth ?? null, gender: input.gender ?? null },
    });

    return {
      id,
      academyId,
      fullName: input.fullName.trim(),
      dateOfBirth: formatDateOfBirth(input.dateOfBirth),
      gender: input.gender ?? null,
      notes: input.notes ?? null,
    };
  });
}

// === Get single ===========================================================

export async function getStudent(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<StudentRow> {
  requireAcademyContext(principal, academyId);
  // loadStudentInAcademy filters by academy_id → cross-academy UUID = NOT_FOUND.
  return loadStudentInAcademy(db, studentId, academyId);
}

// === List =================================================================

export interface ListStudentsFilters {
  classId?: string;
  includeArchived?: boolean;
}

export interface ListStudentsResult {
  students: StudentRow[];
}

export async function listStudents(
  principal: Principal,
  academyId: string,
  filters: ListStudentsFilters = {},
  db: DbClient = getDb(),
): Promise<ListStudentsResult> {
  requireAcademyContext(principal, academyId);

  const conditions = ["s.academy_id = $1"];
  const params: unknown[] = [academyId];
  let paramIdx = 2;

  if (!filters.includeArchived) {
    conditions.push("s.archived_at IS NULL");
  }

  if (filters.classId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM student_enrollments se
      WHERE se.student_id = s.id AND se.class_id = $${paramIdx}
        AND se.effective_to IS NULL
    )`);
    params.push(filters.classId);
    paramIdx++;
  }

  const result = await db.query<StudentRow>(
    `SELECT s.id, s.academy_id, s.full_name, s.date_of_birth,
            s.gender, s.notes, s.archived_at
       FROM students s
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.full_name;`,
    params,
  );

  return { students: result.rows as StudentRow[] };
}

// === Update ===============================================================

export interface UpdateStudentInput {
  fullName?: string;
  dateOfBirth?: string | null;
  gender?: "male" | "female" | "unspecified" | null;
  notes?: string | null;
  archivedAt?: boolean; // true = archive, false = unarchive
}

export interface UpdateStudentResult {
  id: string;
  academyId: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  notes: string | null;
  archivedAt: string | null;
}

export async function updateStudent(
  principal: Principal,
  academyId: string,
  studentId: string,
  input: UpdateStudentInput,
  db: DbClient = getDb(),
): Promise<UpdateStudentResult> {
  requireAcademyContext(principal, academyId);

  if (input.fullName !== undefined && input.fullName.trim() === "") {
    throw Err.validation("Student full name cannot be empty.");
  }

  return db.withTxSerializable(async (tx) => {
    // Load + lock the student (academy-scoped).
    const student = await loadStudentInAcademy(tx, studentId, academyId);
    await tx.query(`SELECT id FROM students WHERE id = $1 FOR UPDATE;`, [student.id]);

    const beforeState = {
      fullName: student.full_name,
      dateOfBirth: student.date_of_birth,
      gender: student.gender,
      notes: student.notes,
      archivedAt: student.archived_at,
    };

    // F1 fix: preserve archive state. Reject archive/unarchive operations
    // that would be no-ops (already in the requested state). This prevents
    // overwriting the original archived_at timestamp.
    if (input.archivedAt === true && student.archived_at !== null) {
      throw Err.conflict("Student is already archived.");
    }
    if (input.archivedAt === false && student.archived_at === null) {
      throw Err.conflict("Student is not archived.");
    }

    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (input.fullName !== undefined) {
      updates.push(`full_name = $${paramIdx++}`);
      params.push(input.fullName.trim());
    }
    if (input.dateOfBirth !== undefined) {
      updates.push(`date_of_birth = $${paramIdx++}`);
      params.push(input.dateOfBirth);
    }
    if (input.gender !== undefined) {
      updates.push(`gender = $${paramIdx++}`);
      params.push(input.gender);
    }
    if (input.notes !== undefined) {
      updates.push(`notes = $${paramIdx++}`);
      params.push(input.notes);
    }
    if (input.archivedAt !== undefined) {
      updates.push(`archived_at = $${paramIdx++}`);
      params.push(input.archivedAt ? new Date() : null);
    }

    if (updates.length === 0) {
      throw Err.validation("No fields to update.");
    }

    updates.push("updated_at = now()");
    params.push(student.id);

    await tx.query(
      `UPDATE students SET ${updates.join(", ")} WHERE id = $${paramIdx};`,
      params,
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "student.update",
      targetType: "students",
      targetId: student.id,
      before: beforeState,
      after: input,
    });

    // Reload the updated student.
    const updated = await loadStudentInAcademy(tx, student.id, academyId);
    return {
      id: updated.id,
      academyId: updated.academy_id,
      fullName: updated.full_name,
      dateOfBirth: formatDateOfBirth(updated.date_of_birth),
      gender: updated.gender,
      notes: updated.notes,
      archivedAt: updated.archived_at ? updated.archived_at.toISOString() : null,
    };
  });
}
