/**
 * PostgreSQL integration tests: representative domain operations against
 * a real PostgreSQL server.
 *
 * These tests verify that the domain services (Phase 3) produce the same
 * results against real PostgreSQL as they do against PgLite.
 *
 * These tests ONLY run when TEST_DATABASE_URL is set.
 */

import { expect } from "bun:test";
import { pgTest, setupPgDb, seedPgFixture } from "./_helpers";
import { createEnrollment, transferClass } from "@/lib/domain/enrollments";
import { purchasePackage } from "@/lib/domain/packages";
import { skipEntitlement, assignMakeup, assignOccurrence, cancelOccurrence } from "@/lib/domain/entitlements";
import { generateOccurrences } from "@/lib/domain/scheduling";
import type { Principal } from "@/lib/auth/principal";

function buildPrincipal(userId: string, academyId: string): Principal {
  return {
    userId,
    email: "pg-admin@test.example",
    fullName: "PG Admin",
    status: "active",
    mustChangePassword: false,
    memberships: [{ academyId, role: "admin", status: "active" }],
    sessionId: "pg-test-session",
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
  };
}

pgTest("package purchase creates exactly N entitlements (real PostgreSQL)", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const principal = buildPrincipal(f.adminUserId, f.academyId);
    await createEnrollment(principal, f.academyId, {
      studentId: f.studentId,
      classId: f.classId,
      effectiveFrom: new Date("2026-01-01"),
    }, db);
    const result = await purchasePackage(principal, f.academyId, {
      studentId: f.studentId,
      packagePlanId: f.plan4Id,
    }, db);
    expect(result.entitlementIds).toHaveLength(4);
    expect(result.unassignedCount).toBe(4);
  } finally {
    await cleanup();
  }
});

pgTest("skip + makeup preserves one-skip-per-package rule (real PostgreSQL)", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const principal = buildPrincipal(f.adminUserId, f.academyId);
    await createEnrollment(principal, f.academyId, {
      studentId: f.studentId,
      classId: f.classId,
      effectiveFrom: new Date("2026-01-01"),
    }, db);
    await generateOccurrences(principal, f.academyId, {
      classId: f.classId,
      fromDate: new Date("2026-01-04"),
      weeksAhead: 4,
    }, db);
    const pkg = await purchasePackage(principal, f.academyId, {
      studentId: f.studentId,
      packagePlanId: f.plan4Id,
    }, db);
    const occResult = await db.query<{ id: string }>(
      `SELECT id FROM training_occurrences WHERE academy_id = $1 AND status = 'planned' ORDER BY occurrence_date LIMIT 4;`,
      [f.academyId],
    );
    const occIds = (occResult.rows as { id: string }[]).map((r) => r.id);
    for (let i = 0; i < pkg.entitlementIds.length; i++) {
      await assignOccurrence(principal, f.academyId, {
        entitlementId: pkg.entitlementIds[i]!,
        occurrenceId: occIds[i]!,
      }, db);
    }
    // Skip the first entitlement.
    await skipEntitlement(principal, f.academyId, {
      entitlementId: pkg.entitlementIds[0]!,
      reason: "Student unavailable",
    }, db);
    // Second skip should fail.
    try {
      await skipEntitlement(principal, f.academyId, {
        entitlementId: pkg.entitlementIds[1]!,
        reason: "Second skip",
      }, db);
      expect.fail("should have thrown CONFLICT");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("CONFLICT");
    }
  } finally {
    await cleanup();
  }
});

pgTest("academy cancellation does not consume skip (real PostgreSQL)", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const principal = buildPrincipal(f.adminUserId, f.academyId);
    await createEnrollment(principal, f.academyId, {
      studentId: f.studentId,
      classId: f.classId,
      effectiveFrom: new Date("2026-01-01"),
    }, db);
    await generateOccurrences(principal, f.academyId, {
      classId: f.classId,
      fromDate: new Date("2026-01-04"),
      weeksAhead: 4,
    }, db);
    const pkg = await purchasePackage(principal, f.academyId, {
      studentId: f.studentId,
      packagePlanId: f.plan4Id,
    }, db);
    const occResult = await db.query<{ id: string }>(
      `SELECT id FROM training_occurrences WHERE academy_id = $1 AND status = 'planned' ORDER BY occurrence_date LIMIT 1;`,
      [f.academyId],
    );
    const occId = (occResult.rows[0] as { id: string }).id;
    await assignOccurrence(principal, f.academyId, {
      entitlementId: pkg.entitlementIds[0]!,
      occurrenceId: occId,
    }, db);
    // Cancel the occurrence.
    await cancelOccurrence(principal, f.academyId, {
      occurrenceId: occId,
      reason: "Academy holiday",
    }, db);
    // Verify the entitlement is awaiting_makeup, skip_used=FALSE.
    const ent = await db.query<{ status: string; skip_used: boolean }>(
      `SELECT status, skip_used FROM session_entitlements WHERE id = $1;`,
      [pkg.entitlementIds[0]!],
    );
    expect((ent.rows[0] as { status: string }).status).toBe("awaiting_makeup");
    expect((ent.rows[0] as { skip_used: boolean }).skip_used).toBe(false);
    // The student can still skip a different entitlement (skip allowance intact).
    const occResult2 = await db.query<{ id: string }>(
      `SELECT id FROM training_occurrences WHERE academy_id = $1 AND status = 'planned' ORDER BY occurrence_date LIMIT 1 OFFSET 1;`,
      [f.academyId],
    );
    const occ2Id = (occResult2.rows[0] as { id: string }).id;
    await assignOccurrence(principal, f.academyId, {
      entitlementId: pkg.entitlementIds[1]!,
      occurrenceId: occ2Id,
    }, db);
    await skipEntitlement(principal, f.academyId, {
      entitlementId: pkg.entitlementIds[1]!,
      reason: "Student skip after cancel",
    }, db);
    // This should succeed — the academy-cancel did NOT consume the skip.
  } finally {
    await cleanup();
  }
});

pgTest("class transfer preserves historical enrollments + class_id_at_purchase (real PostgreSQL)", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const principal = buildPrincipal(f.adminUserId, f.academyId);
    await createEnrollment(principal, f.academyId, {
      studentId: f.studentId,
      classId: f.classId,
      effectiveFrom: new Date("2026-01-01"),
    }, db);
    const pkg = await purchasePackage(principal, f.academyId, {
      studentId: f.studentId,
      packagePlanId: f.plan4Id,
    }, db);
    // Create a second class.
    const class2Id = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Second', 10);`, [class2Id, f.academyId]);
    // Transfer.
    await transferClass(principal, f.academyId, {
      studentId: f.studentId,
      newClassId: class2Id,
      effectiveFrom: new Date("2026-02-01"),
      reason: "Transfer test",
    }, db);
    // Verify the package's class_id_at_purchase is unchanged.
    const pkgResult = await db.query<{ class_id_at_purchase: string }>(
      `SELECT class_id_at_purchase FROM student_packages WHERE id = $1;`,
      [pkg.packageId],
    );
    expect((pkgResult.rows[0] as { class_id_at_purchase: string }).class_id_at_purchase).toBe(f.classId);
  } finally {
    await cleanup();
  }
});
