/**
 * Domain: Guardian-to-student link operations.
 *
 * Enforces:
 *   - Admin role required for all operations.
 *   - Academy scoping: guardian and student must be in the same academy.
 *   - Guardian must have a Parent role membership in the same academy.
 *   - UNIQUE(guardian_user_id, student_id) prevents duplicate links.
 *   - At most one primary guardian per student (partial unique index).
 *   - Audit events in the same transaction as mutations.
 *
 * Server-only. Never import from client code.
 */

import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  loadStudentInAcademy,
  newId,
} from "./helpers";

// === Types ================================================================

export interface GuardianLinkRow {
  id: string;
  guardian_user_id: string;
  student_id: string;
  is_primary: boolean;
  relationship: string | null;
  /** Guardian's email (joined from users). NULL only if the user row
   * is somehow missing — FK + ON DELETE RESTRICT makes this rare. */
  guardian_email: string | null;
  /** Guardian's display name (joined from users). NULL if the user has
   * no full_name set (e.g., a provisioned account never updated it). */
  guardian_full_name: string | null;
}

/** A parent-role user eligible to be linked as a guardian for a student.
 * Returned by `searchEligibleGuardians` for the AddGuardian UI. */
export interface EligibleGuardianRow {
  id: string;
  email: string;
  fullName: string | null;
  /** True if this user is already linked to THIS student. The UI uses
   * this to disable already-linked rows (the POST still enforces the
   * UNIQUE constraint as the real duplicate-prevention layer). */
  isAlreadyLinked: boolean;
}

export interface CreateGuardianLinkInput {
  guardianUserId: string;
  isPrimary?: boolean;
  relationship?: string;
}

export interface CreateGuardianLinkResult {
  id: string;
  guardianUserId: string;
  studentId: string;
  isPrimary: boolean;
  relationship: string | null;
}

// === Internal: validate guardian membership ==============================

/**
 * Verify that the given user is a Parent in the specified academy.
 * Returns the user's email for audit. Throws FORBIDDEN if not.
 */
async function requireGuardianInAcademy(
  tx: TxClient,
  guardianUserId: string,
  academyId: string,
): Promise<{ email: string }> {
  const result = await tx.query<{ email: string }>(
    `SELECT u.email
       FROM users u
       JOIN academy_memberships m ON m.user_id = u.id
      WHERE u.id = $1 AND m.academy_id = $2
        AND m.role = 'parent' AND m.status = 'active'
        AND u.status = 'active'
      LIMIT 1;`,
    [guardianUserId, academyId],
  );
  if (!result.rows[0]) {
    throw Err.forbidden("Guardian user does not have an active parent membership in this academy.");
  }
  return result.rows[0] as { email: string };
}

// === Create ===============================================================

export async function createGuardianLink(
  principal: Principal,
  academyId: string,
  studentId: string,
  input: CreateGuardianLinkInput,
  db: DbClient = getDb(),
): Promise<CreateGuardianLinkResult> {
  requireAcademyContext(principal, academyId);

  return db.withTxSerializable(async (tx) => {
    // Verify student exists in this academy.
    const student = await loadStudentInAcademy(tx, studentId, academyId);
    await tx.query(`SELECT id FROM students WHERE id = $1 FOR UPDATE;`, [student.id]);

    // Verify guardian is a parent in this academy.
    await requireGuardianInAcademy(tx, input.guardianUserId, academyId);

    const id = newId();
    const isPrimary = input.isPrimary ?? false;
    const relationship = input.relationship ?? null;

    try {
      await tx.query(
        `INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship)
         VALUES ($1, $2, $3, $4, $5);`,
        [id, input.guardianUserId, student.id, isPrimary, relationship],
      );
    } catch {
      throw Err.conflict("This guardian is already linked to this student.");
    }

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "guardian_link.create",
      targetType: "guardian_student_links",
      targetId: id,
      after: { guardianUserId: input.guardianUserId, studentId: student.id, isPrimary, relationship },
    });

    return {
      id,
      guardianUserId: input.guardianUserId,
      studentId: student.id,
      isPrimary,
      relationship,
    };
  });
}

// === List =================================================================

export async function listGuardianLinks(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<GuardianLinkRow[]> {
  requireAcademyContext(principal, academyId);

  // Verify student is in this academy (cross-academy → NOT_FOUND).
  await loadStudentInAcademy(db, studentId, academyId);

  // JOIN users to return display fields (email + full_name) so the UI
  // can show meaningful identity instead of a UUID prefix. LEFT JOIN
  // for defense-in-depth (guardian_student_links.guardian_user_id has
  // ON DELETE RESTRICT, so the user row should always exist).
  const result = await db.query<GuardianLinkRow>(
    `SELECT gl.id, gl.guardian_user_id, gl.student_id, gl.is_primary, gl.relationship,
            u.email AS guardian_email, u.full_name AS guardian_full_name
       FROM guardian_student_links gl
       LEFT JOIN users u ON u.id = gl.guardian_user_id
      WHERE gl.student_id = $1
      ORDER BY gl.is_primary DESC, gl.created_at;`,
    [studentId],
  );
  return result.rows as GuardianLinkRow[];
}

// === Search eligible guardians ============================================

/** Minimum search query length. Prevents loading all parents on an
 * empty/debounce edge. The UI also enforces this; the domain enforces
 * it again as a safety net. */
export const ELIGIBLE_GUARDIAN_MIN_QUERY = 2;
/** Maximum results returned by `searchEligibleGuardians`. Bounds the
 * response size and the UI list height. */
export const ELIGIBLE_GUARDIAN_MAX_RESULTS = 20;

/** Escape ILIKE wildcards in the user's search query so `%` and `_`
 * in their input are treated as literals (not wildcard injection).
 * Uses the default backslash escape character. */
function escapeIlikePattern(query: string): string {
  return query.replace(/[%_\\]/g, (m) => `\\${m}`);
}

/**
 * Search for users eligible to be linked as a guardian for a student.
 *
 * Eligibility (all required):
 *   - The user has an ACTIVE `parent` role membership in the specified
 *     academy (the same check `createGuardianLink` enforces on POST).
 *   - The user's account status is `active`.
 *   - The user's email OR full_name matches the query (case-insensitive,
 *     partial — ILIKE '%query%').
 *
 * Returns at most `ELIGIBLE_GUARDIAN_MAX_RESULTS` rows, ordered by
 * full_name (NULLS LAST) then email for stable display.
 *
 * `isAlreadyLinked` is computed via a LEFT JOIN to
 * `guardian_student_links` filtered to THIS student, so the UI can
 * disable already-linked rows. This is a UX hint ONLY — the real
 * duplicate prevention is the UNIQUE(guardian_user_id, student_id)
 * constraint enforced on POST.
 *
 * Does NOT return: password hashes, session tokens, credentials, or
 * any data from other academies. The query is academy-scoped by the
 * `academy_memberships.academy_id = $1` filter.
 *
 * Authorization: admin role in the specified academy (enforced by the
 * caller via `requireAcademyContext`). The student must exist in the
 * academy (cross-academy student UUID → NOT_FOUND).
 *
 * Server-only. Never import from client code.
 */
export async function searchEligibleGuardians(
  principal: Principal,
  academyId: string,
  studentId: string,
  query: string,
  db: DbClient = getDb(),
): Promise<EligibleGuardianRow[]> {
  requireAcademyContext(principal, academyId);

  // Verify student is in this academy (cross-academy → NOT_FOUND).
  await loadStudentInAcademy(db, studentId, academyId);

  const trimmed = query.trim();
  if (trimmed.length < ELIGIBLE_GUARDIAN_MIN_QUERY) {
    // Too short — return empty rather than loading all parents.
    return [];
  }

  const pattern = `%${escapeIlikePattern(trimmed)}%`;
  const result = await db.query(
    `SELECT u.id, u.email, u.full_name,
            (gl.id IS NOT NULL) AS is_already_linked
       FROM users u
       JOIN academy_memberships m ON m.user_id = u.id
       LEFT JOIN guardian_student_links gl
         ON gl.guardian_user_id = u.id AND gl.student_id = $2
      WHERE m.academy_id = $1
        AND m.role = 'parent'
        AND m.status = 'active'
        AND u.status = 'active'
        AND (u.email ILIKE $3 OR COALESCE(u.full_name, '') ILIKE $3)
      ORDER BY u.full_name NULLS LAST, u.email
      LIMIT $4;`,
    [academyId, studentId, pattern, ELIGIBLE_GUARDIAN_MAX_RESULTS],
  );

  return (result.rows as {
    id: string;
    email: string;
    full_name: string | null;
    is_already_linked: boolean;
  }[]).map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    isAlreadyLinked: r.is_already_linked,
  }));
}

// === Remove ===============================================================

export async function removeGuardianLink(
  principal: Principal,
  academyId: string,
  studentId: string,
  linkId: string,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  return db.withTxSerializable(async (tx) => {
    // Verify student is in this academy.
    const student = await loadStudentInAcademy(tx, studentId, academyId);

    // Load and lock the link (must belong to this student).
    const linkResult = await tx.query<GuardianLinkRow>(
      `SELECT id, guardian_user_id, student_id, is_primary, relationship
         FROM guardian_student_links
        WHERE id = $1 AND student_id = $2
        LIMIT 1;`,
      [linkId, student.id],
    );
    const link = (linkResult.rows[0] as GuardianLinkRow | undefined);
    if (!link) {
      throw Err.notFound("Guardian link not found for this student.");
    }
    await tx.query(`SELECT id FROM guardian_student_links WHERE id = $1 FOR UPDATE;`, [link.id]);

    const beforeState = {
      guardianUserId: link.guardian_user_id,
      isPrimary: link.is_primary,
      relationship: link.relationship,
    };

    await tx.query(`DELETE FROM guardian_student_links WHERE id = $1;`, [link.id]);

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "guardian_link.remove",
      targetType: "guardian_student_links",
      targetId: link.id,
      before: beforeState,
    });
  });
}
