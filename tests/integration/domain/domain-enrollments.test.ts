/**
 * Domain test: Student enrollments + class transfers.
 *
 * Tests invariant #7: changing a student's class preserves historical
 * enrollments and existing paid entitlements. New packages use the new
 * enrollment's class.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDomainFixture, teardownDomainDb, ACADEMY_ID, type DomainSetup } from "./_helpers";
import { createEnrollment, transferClass } from "@/lib/domain/enrollments";
import { purchasePackage, listEntitlementsForPackage } from "@/lib/domain/packages";
import { AppError } from "@/lib/errors";

// Helper: extract the original DB error message from an AppError(UPSTREAM_ERROR).
function dbErrorMessage(err: unknown): string {
  if (err instanceof AppError && err.serverCause instanceof Error) {
    return err.serverCause.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

let setup: DomainSetup;

beforeEach(async () => {
  setup = await setupDomainFixture();
});

afterEach(async () => {
  await teardownDomainDb();
});

test("transferClass closes the old enrollment and creates a new one", async () => {
  // Initial enrollment.
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date("2026-01-01"),
  }, setup.db);

  // Create a second class.
  const class2Id = randomUUID();
  await setup.db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Second Class', 10, true);`,
    [class2Id, ACADEMY_ID],
  );

  // Transfer.
  const result = await transferClass(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    newClassId: class2Id,
    effectiveFrom: new Date("2026-02-01"),
    reason: "Student requested transfer",
  }, setup.db);

  expect(result.newEnrollment.class_id).toBe(class2Id);
  expect(result.closedEnrollment?.class_id).toBe(setup.classId);

  // Verify the old enrollment is closed.
  const oldEnrollment = await setup.db.query<{ effective_to: Date | null }>(
    `SELECT effective_to FROM student_enrollments WHERE id = $1;`,
    [result.closedEnrollment?.id],
  );
  expect((oldEnrollment.rows[0] as { effective_to: Date | null }).effective_to).not.toBeNull();
});

test("existing package class_id_at_purchase is unchanged after class transfer (DB trigger)", async () => {
  // Enroll + purchase package.
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date("2026-01-01"),
  }, setup.db);
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  // Create second class + transfer.
  const class2Id = randomUUID();
  await setup.db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Second Class', 10, true);`,
    [class2Id, ACADEMY_ID],
  );
  await transferClass(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    newClassId: class2Id,
    effectiveFrom: new Date("2026-02-01"),
    reason: "Transfer",
  }, setup.db);

  // Verify the package's class_id_at_purchase is unchanged.
  const pkgResult = await setup.db.query<{ class_id_at_purchase: string }>(
    `SELECT class_id_at_purchase FROM student_packages WHERE id = $1;`,
    [pkg.packageId],
  );
  expect((pkgResult.rows[0] as { class_id_at_purchase: string }).class_id_at_purchase).toBe(setup.classId);
});

test("new package after transfer uses the new class", async () => {
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date("2026-01-01"),
  }, setup.db);

  const class2Id = randomUUID();
  await setup.db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Second Class', 10, true);`,
    [class2Id, ACADEMY_ID],
  );
  await transferClass(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    newClassId: class2Id,
    effectiveFrom: new Date("2026-02-01"),
    reason: "Transfer",
  }, setup.db);

  // Purchase a new package — should use the NEW class.
  const newPkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const pkgResult = await setup.db.query<{ class_id_at_purchase: string }>(
    `SELECT class_id_at_purchase FROM student_packages WHERE id = $1;`,
    [newPkg.packageId],
  );
  expect((pkgResult.rows[0] as { class_id_at_purchase: string }).class_id_at_purchase).toBe(class2Id);
});

test("DB trigger blocks direct UPDATE of class_id_at_purchase", async () => {
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date("2026-01-01"),
  }, setup.db);
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const class2Id = randomUUID();
  await setup.db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Second Class', 10, true);`,
    [class2Id, ACADEMY_ID],
  );

  // Direct UPDATE should be blocked by the trigger.
  try {
    await setup.db.query(
      `UPDATE student_packages SET class_id_at_purchase = $2 WHERE id = $1;`,
      [pkg.packageId, class2Id],
    );
    expect.fail("should have thrown (trigger blocks class_id_at_purchase change)");
  } catch (err) {
    expect(dbErrorMessage(err)).toContain("immutable");
  }
});

test("createEnrollment fails if student already has an active enrollment", async () => {
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date("2026-01-01"),
  }, setup.db);

  try {
    await createEnrollment(setup.admin, ACADEMY_ID, {
      studentId: setup.studentId,
      classId: setup.classId,
      effectiveFrom: new Date("2026-02-01"),
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
  }
});

test("historical enrollments are preserved (effective-dated, not overwritten)", async () => {
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date("2026-01-01"),
  }, setup.db);

  const class2Id = randomUUID();
  await setup.db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Second Class', 10, true);`,
    [class2Id, ACADEMY_ID],
  );
  await transferClass(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    newClassId: class2Id,
    effectiveFrom: new Date("2026-02-01"),
    reason: "Transfer",
  }, setup.db);

  // Verify both enrollment rows exist (history preserved).
  const enrollments = await setup.db.query<{ class_id: string; effective_to: Date | null }>(
    `SELECT class_id, effective_to FROM student_enrollments WHERE student_id = $1 ORDER BY effective_from;`,
    [setup.studentId],
  );
  expect(enrollments.rows.length).toBe(2);
  const rows = enrollments.rows as { class_id: string; effective_to: Date | null }[];
  expect(rows[0]!.class_id).toBe(setup.classId);
  expect(rows[0]!.effective_to).not.toBeNull(); // closed
  expect(rows[1]!.class_id).toBe(class2Id);
  expect(rows[1]!.effective_to).toBeNull(); // active
});
