/**
 * Domain: Package purchase + entitlement creation.
 *
 * Enforces invariant #1: purchasing a package creates EXACTLY the
 * purchased number of session entitlements.
 *
 * Per Decision 3: entitlement creation is DISTINGUISHED from occurrence
 * assignment. A package purchase creates exactly N entitlements even if
 * there are not enough generated occurrences to assign them immediately.
 * Unassigned entitlements have original_occurrence_id = NULL and
 * assigned_occurrence_id = NULL; they remain visible and recoverable.
 * Occurrence assignment happens later through an explicit, idempotent
 * operation (`assignOccurrences` in entitlements.ts).
 *
 * If package creation fails at any step, the ENTIRE transaction rolls back
 * (no partial purchase).
 *
 * Academy scoping: the student, package plan, and student's current
 * enrollment's class must all belong to the principal's academy.
 */

import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  loadStudentInAcademy,
  loadPackagePlanInAcademy,
  loadStudentPackageInAcademy,
  loadActiveEnrollment,
  newId,
  type EntitlementRow,
  type PackagePlanRow,
  type StudentPackageRow,
} from "./helpers";

export interface PurchasePackageInput {
  studentId: string;
  packagePlanId: string;
}

export interface PurchasePackageResult {
  packageId: string;
  entitlementIds: string[];
  /** Number of entitlements that were immediately assigned to occurrences. */
  assignedCount: number;
  /** Number of entitlements with no occurrence (awaiting assignment). */
  unassignedCount: number;
}

/**
 * Purchase a package for a student. Creates:
 *   1. A `student_packages` row with `class_id_at_purchase` = the
 *      student's current active enrollment's class.
 *   2. Exactly N `session_entitlements` rows (N = plan.session_count).
 *      Each entitlement has:
 *      - sequence = 1..N
 *      - original_occurrence_id = NULL (not yet assigned)
 *      - assigned_occurrence_id = NULL (not yet assigned)
 *      - status = 'active'
 *      - skip_used = false
 *   3. An `entitlement_events` row for each entitlement (event_type='created').
 *   4. An `audit_events` row.
 *
 * All in a SERIALIZABLE transaction. If any step fails, all roll back.
 *
 * Occurrence assignment is NOT done here — it's a separate explicit
 * operation. This ensures exactly N entitlements are created regardless
 * of available occurrences.
 *
 * Thin wrapper around `purchasePackageInTx` (the transaction-aware
 * core). Preserves the original behavior; existing tests pass unchanged.
 */
export async function purchasePackage(
  principal: Principal,
  academyId: string,
  input: PurchasePackageInput,
  db: DbClient = getDb(),
): Promise<PurchasePackageResult> {
  requireAcademyContext(principal, academyId);
  return db.withTxSerializable(async (tx) => {
    return purchasePackageInTx(tx, principal, academyId, input);
  });
}

/**
 * Transaction-aware core of package purchase. Operates within a caller-
 * provided SERIALIZABLE transaction. Used by `purchasePackage` (standalone)
 * and by `recordPayment` (atomic payment + package + allocation + audit).
 *
 * Loads the student + plan inside the tx (academy-scoped), locks the
 * student (FOR UPDATE), loads the active enrollment, creates the
 * student_package + exactly N entitlements + N 'created' events, asserts
 * the entitlement count before COMMIT, and writes an audit event.
 *
 * Throws the same AppErrors as `purchasePackage` (NOT_FOUND for
 * cross-academy, CONFLICT for inactive plan / no enrollment / count
 * mismatch).
 */
export async function purchasePackageInTx(
  tx: TxClient,
  principal: Principal,
  academyId: string,
  input: PurchasePackageInput,
): Promise<PurchasePackageResult> {
  // Load + validate academy scoping (inside tx for consistency).
  const student = await loadStudentInAcademy(tx, input.studentId, academyId);
  const plan = await loadPackagePlanInAcademy(tx, input.packagePlanId, academyId);

  if (!plan.is_active) {
    throw Err.conflict("Package plan is not active.");
  }

  // Lock the student row to prevent concurrent package purchases.
  await tx.query(`SELECT id FROM students WHERE id = $1 FOR UPDATE;`, [student.id]);

  // Load the student's current active enrollment.
  const enrollment = await loadActiveEnrollment(tx, student.id);
  if (!enrollment) {
    throw Err.conflict("Student has no active enrollment. Cannot purchase a package without an enrollment.");
  }

  // Create the student_package row.
  const packageId = newId();
  await tx.query(
    `INSERT INTO student_packages
       (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance, status, purchased_at)
     VALUES ($1, $2, $3, $4, 1, 'active', now());`,
    [packageId, student.id, plan.id, enrollment.class_id],
  );

  // Create exactly N entitlements. None are assigned to occurrences yet
  // (original_occurrence_id = NULL, assigned_occurrence_id = NULL).
  const entitlementIds: string[] = [];
  for (let i = 0; i < plan.session_count; i++) {
    const entitlementId = newId();
    const sequence = i + 1;

    await tx.query(
      `INSERT INTO session_entitlements
         (id, student_package_id, sequence, original_occurrence_id,
          assigned_occurrence_id, status, skip_used)
       VALUES ($1, $2, $3, NULL, NULL, 'active', false);`,
      [entitlementId, packageId, sequence],
    );

    // Record the creation event.
    await tx.query(
      `INSERT INTO entitlement_events
         (id, entitlement_id, event_type, occurred_at, actor_user_id, reason)
       VALUES ($1, $2, 'created', now(), $3, NULL);`,
      [newId(), entitlementId, principal.userId],
    );

    entitlementIds.push(entitlementId);
  }

  // Assert the count before COMMIT (defense-in-depth; the domain logic
  // should have created exactly N).
  const countResult = await tx.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1;`,
    [packageId],
  );
  const actualCount = (countResult.rows[0] as { c: number }).c;
  if (actualCount !== plan.session_count) {
    throw Err.invariant(
      `Entitlement count mismatch: expected ${plan.session_count}, got ${actualCount}. Rolling back.`,
    );
  }

  await writeAudit({
    tx,
    academyId,
    actorUserId: principal.userId,
    action: "package.purchase",
    targetType: "student_packages",
    targetId: packageId,
    after: {
      studentId: student.id,
      packagePlanId: plan.id,
      sessionCount: plan.session_count,
      classIdAtPurchase: enrollment.class_id,
      entitlementIds,
    },
  });

  return {
    packageId,
    entitlementIds,
    assignedCount: 0,
    unassignedCount: plan.session_count,
  };
}

/**
 * Load all entitlements for a package (academy-scoped).
 */
export async function listEntitlementsForPackage(
  principal: Principal,
  academyId: string,
  packageId: string,
  db: DbClient = getDb(),
): Promise<EntitlementRow[]> {
  requireAcademyContext(principal, academyId);
  // Verify the package exists in this academy (cross-academy → NOT_FOUND).
  await loadStudentPackageInAcademy(db, packageId, academyId);
  const result = await db.query<EntitlementRow>(
    `SELECT e.id, e.student_package_id, e.sequence, e.original_occurrence_id,
            e.assigned_occurrence_id, e.status, e.skip_used
       FROM session_entitlements e
       JOIN student_packages sp ON sp.id = e.student_package_id
       JOIN students s ON s.id = sp.student_id
      WHERE sp.id = $1 AND s.academy_id = $2
      ORDER BY e.sequence;`,
    [packageId, academyId],
  );
  return result.rows as EntitlementRow[];
}

// === Package Plan CRUD ===================================================

export interface CreatePackagePlanInput {
  name: string;
  sessionCount: number;
}

export async function createPackagePlan(
  principal: Principal,
  academyId: string,
  input: CreatePackagePlanInput,
  db: DbClient = getDb(),
): Promise<PackagePlanRow> {
  requireAcademyContext(principal, academyId);
  if (!input.name || input.name.trim() === "") throw Err.validation("Plan name is required.");
  if (!Number.isInteger(input.sessionCount) || input.sessionCount <= 0) throw Err.validation("sessionCount must be a positive integer.");

  return db.withTxSerializable(async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO package_plans (id, academy_id, name, session_count, is_active)
       VALUES ($1, $2, $3, $4, true);`,
      [id, academyId, input.name.trim(), input.sessionCount],
    );
    await writeAudit({ tx, academyId, actorUserId: principal.userId, action: "package_plan.create", targetType: "package_plans", targetId: id, after: { name: input.name, sessionCount: input.sessionCount } });
    const r = await tx.query<PackagePlanRow>(`SELECT id, academy_id, name, session_count, is_active FROM package_plans WHERE id = $1;`, [id]);
    return r.rows[0] as PackagePlanRow;
  });
}

export interface UpdatePackagePlanInput {
  name?: string;
  sessionCount?: number;
  isActive?: boolean;
}

export async function updatePackagePlan(
  principal: Principal,
  academyId: string,
  planId: string,
  input: UpdatePackagePlanInput,
  db: DbClient = getDb(),
): Promise<PackagePlanRow> {
  requireAcademyContext(principal, academyId);
  if (input.name !== undefined && input.name.trim() === "") throw Err.validation("Plan name cannot be empty.");
  if (input.sessionCount !== undefined && (!Number.isInteger(input.sessionCount) || input.sessionCount <= 0)) throw Err.validation("sessionCount must be a positive integer.");

  return db.withTxSerializable(async (tx) => {
    const plan = await loadPackagePlanInAcademy(tx, planId, academyId);
    await tx.query(`SELECT id FROM package_plans WHERE id = $1 FOR UPDATE;`, [plan.id]);
    const before = { name: plan.name, sessionCount: plan.session_count, isActive: plan.is_active };
    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) { updates.push(`name = $${idx++}`); params.push(input.name.trim()); }
    if (input.sessionCount !== undefined) { updates.push(`session_count = $${idx++}`); params.push(input.sessionCount); }
    if (input.isActive !== undefined) { updates.push(`is_active = $${idx++}`); params.push(input.isActive); }
    if (updates.length === 0) throw Err.validation("No fields to update.");
    updates.push("updated_at = now()");
    params.push(plan.id);
    await tx.query(`UPDATE package_plans SET ${updates.join(", ")} WHERE id = $${idx};`, params);
    await writeAudit({ tx, academyId, actorUserId: principal.userId, action: "package_plan.update", targetType: "package_plans", targetId: plan.id, before, after: input });
    const r = await tx.query<PackagePlanRow>(`SELECT id, academy_id, name, session_count, is_active FROM package_plans WHERE id = $1;`, [plan.id]);
    return r.rows[0] as PackagePlanRow;
  });
}

export async function listPackagePlans(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<PackagePlanRow[]> {
  requireAcademyContext(principal, academyId);
  const result = await db.query<PackagePlanRow>(
    `SELECT id, academy_id, name, session_count, is_active FROM package_plans WHERE academy_id = $1 ORDER BY session_count;`,
    [academyId],
  );
  return result.rows as PackagePlanRow[];
}

// === Student package history =============================================

export interface StudentPackageWithPlan extends StudentPackageRow {
  plan_name: string;
  session_count: number;
}

export async function listStudentPackages(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<StudentPackageWithPlan[]> {
  requireAcademyContext(principal, academyId);
  await loadStudentInAcademy(db, studentId, academyId);
  const result = await db.query<StudentPackageWithPlan>(
    `SELECT sp.id, sp.student_id, sp.package_plan_id, sp.class_id_at_purchase,
            sp.skip_allowance, sp.status, sp.purchased_at,
            pp.name AS plan_name, pp.session_count
       FROM student_packages sp
       JOIN package_plans pp ON pp.id = sp.package_plan_id
       JOIN students s ON s.id = sp.student_id
      WHERE sp.student_id = $1 AND s.academy_id = $2
      ORDER BY sp.purchased_at DESC;`,
    [studentId, academyId],
  );
  return result.rows as StudentPackageWithPlan[];
}

// === Package details with entitlements ====================================

export interface PackageDetails {
  package: StudentPackageRow;
  planName: string;
  sessionCount: number;
  entitlements: EntitlementRow[];
}

export async function getPackageDetails(
  principal: Principal,
  academyId: string,
  packageId: string,
  db: DbClient = getDb(),
): Promise<PackageDetails> {
  requireAcademyContext(principal, academyId);
  const pkg = await loadStudentPackageInAcademy(db, packageId, academyId);
  const planResult = await db.query<{ name: string; session_count: number }>(
    `SELECT name, session_count FROM package_plans WHERE id = $1;`, [pkg.package_plan_id],
  );
  const plan = planResult.rows[0] as { name: string; session_count: number };
  const entitlements = await listEntitlementsForPackage(principal, academyId, packageId, db);
  return {
    package: pkg,
    planName: plan.name,
    sessionCount: plan.session_count,
    entitlements,
  };
}
