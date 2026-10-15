/**
 * Domain test: Package purchase + entitlement creation.
 *
 * Tests invariant #1: purchasing a package creates exactly N entitlements.
 * Tests Decision 3: entitlements are created WITHOUT occurrence assignment;
 * unassigned entitlements remain visible and recoverable.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { setupDomainFixture, teardownDomainDb, ACADEMY_ID, type DomainSetup } from "./_helpers";
import { purchasePackage, listEntitlementsForPackage } from "@/lib/domain/packages";
import { createEnrollment } from "@/lib/domain/enrollments";

let setup: DomainSetup;

beforeEach(async () => {
  setup = await setupDomainFixture();
});

afterEach(async () => {
  await teardownDomainDb();
});

test("purchasing a 4-session plan creates exactly 4 entitlements", async () => {
  // Enroll the student first.
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date(),
  }, setup.db);

  const result = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  expect(result.entitlementIds).toHaveLength(4);
  expect(result.assignedCount).toBe(0);
  expect(result.unassignedCount).toBe(4);

  // Verify the entitlements exist in the DB.
  const entitlements = await listEntitlementsForPackage(setup.admin, ACADEMY_ID, result.packageId, setup.db);
  expect(entitlements).toHaveLength(4);
  expect(entitlements.map(e => e.sequence)).toEqual([1, 2, 3, 4]);

  // All entitlements are unassigned (no occurrence reference).
  for (const e of entitlements) {
    expect(e.original_occurrence_id).toBeNull();
    expect(e.assigned_occurrence_id).toBeNull();
    expect(e.status).toBe("active");
    expect(e.skip_used).toBe(false);
  }
});

test("purchasing an 8-session plan creates exactly 8 entitlements", async () => {
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date(),
  }, setup.db);

  const result = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan8Id,
  }, setup.db);

  expect(result.entitlementIds).toHaveLength(8);
});

test("entitlements are created even with no occurrences generated (unassigned but visible)", async () => {
  // Don't generate any occurrences — the package should still create N entitlements.
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date(),
  }, setup.db);

  const result = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  // All 4 entitlements created, all unassigned.
  expect(result.entitlementIds).toHaveLength(4);
  expect(result.unassignedCount).toBe(4);

  const entitlements = await listEntitlementsForPackage(setup.admin, ACADEMY_ID, result.packageId, setup.db);
  expect(entitlements).toHaveLength(4);
  for (const e of entitlements) {
    expect(e.original_occurrence_id).toBeNull();
  }
});

test("package purchase fails without an active enrollment (rolls back)", async () => {
  // No enrollment created.
  try {
    await purchasePackage(setup.admin, ACADEMY_ID, {
      studentId: setup.studentId,
      packagePlanId: setup.plan4Id,
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as { code?: string }).code).toBe("CONFLICT");
  }

  // Verify no package or entitlements were created.
  const pkgs = await setup.db.query(`SELECT COUNT(*)::int AS c FROM student_packages;`);
  expect((pkgs.rows[0] as { c: number }).c).toBe(0);
});

test("package purchase with class_id_at_purchase = enrollment's class", async () => {
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date(),
  }, setup.db);

  const result = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const pkgResult = await setup.db.query<{ class_id_at_purchase: string }>(
    `SELECT class_id_at_purchase FROM student_packages WHERE id = $1;`,
    [result.packageId],
  );
  expect((pkgResult.rows[0] as { class_id_at_purchase: string }).class_id_at_purchase).toBe(setup.classId);
});
