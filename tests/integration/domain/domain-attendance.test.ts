/**
 * Domain test: Attendance + capacity.
 *
 * Tests invariant #10: no duplicate bookings, no over-capacity assignments.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDomainFixture, teardownDomainDb, ACADEMY_ID, type DomainSetup } from "./_helpers";
import { createEnrollment } from "@/lib/domain/enrollments";
import { generateOccurrences } from "@/lib/domain/scheduling";
import { purchasePackage } from "@/lib/domain/packages";
import { assignOccurrence } from "@/lib/domain/entitlements";
import { recordAttendance } from "@/lib/domain/attendance";
import { AppError } from "@/lib/errors";

let setup: DomainSetup;

beforeEach(async () => {
  setup = await setupDomainFixture();
  // Enroll the student from 2026-01-01 so the enrollment covers the
  // generated occurrences (2026-01-04 onward). Required because
  // `recordAttendance` now verifies enrollment eligibility on the
  // occurrence date (Stage 4 integrity rule).
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date("2026-01-01"),
  }, setup.db);
  await generateOccurrences(setup.admin, ACADEMY_ID, {
    classId: setup.classId,
    fromDate: new Date("2026-01-04"),
    weeksAhead: 4,
  }, setup.db);
});

afterEach(async () => {
  await teardownDomainDb();
});

test("duplicate attendance for the same student + occurrence is rejected (DB UNIQUE)", async () => {
  const occResult = await setup.db.query<{ id: string }>(
    `SELECT id FROM training_occurrences WHERE academy_id = $1 AND status = 'planned' LIMIT 1;`,
    [ACADEMY_ID],
  );
  const occId = (occResult.rows[0] as { id: string }).id;

  // First record succeeds.
  await recordAttendance(setup.admin, ACADEMY_ID, {
    occurrenceId: occId,
    studentId: setup.studentId,
    status: "present",
  }, setup.db);

  // Second record fails.
  try {
    await recordAttendance(setup.admin, ACADEMY_ID, {
      occurrenceId: occId,
      studentId: setup.studentId,
      status: "absent",
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
  }
});

test("present attendance marks the entitlement as completed", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const occResult = await setup.db.query<{ id: string }>(
    `SELECT id FROM training_occurrences WHERE academy_id = $1 AND status = 'planned' LIMIT 1;`,
    [ACADEMY_ID],
  );
  const occId = (occResult.rows[0] as { id: string }).id;

  await assignOccurrence(setup.admin, ACADEMY_ID, {
    entitlementId: pkg.entitlementIds[0]!,
    occurrenceId: occId,
  }, setup.db);

  await recordAttendance(setup.admin, ACADEMY_ID, {
    occurrenceId: occId,
    studentId: setup.studentId,
    status: "present",
    entitlementId: pkg.entitlementIds[0]!,
  }, setup.db);

  const ent = await setup.db.query<{ status: string }>(
    `SELECT status FROM session_entitlements WHERE id = $1;`,
    [pkg.entitlementIds[0]!],
  );
  expect((ent.rows[0] as { status: string }).status).toBe("completed");
});

test("over-capacity assignment is rejected by the capacity trigger", async () => {
  // Create a class with capacity=1.
  const smallClassId = randomUUID();
  await setup.db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Small Class', 1, true);`,
    [smallClassId, ACADEMY_ID],
  );
  // Create a schedule version + slot.
  const versionId = randomUUID();
  await setup.db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, status)
     VALUES ($1, $2, CURRENT_DATE, 'active');`,
    [versionId, smallClassId],
  );
  const slotId = randomUUID();
  await setup.db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '18:00', '19:00');`,
    [slotId, versionId],
  );
  // Create one occurrence.
  const occId = randomUUID();
  await setup.db.query(
    `INSERT INTO training_occurrences
       (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
        occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, '2026-01-06', '2026-01-06 18:00:00', '2026-01-06 19:00:00', 'planned', 1);`,
    [occId, ACADEMY_ID, smallClassId, slotId, versionId],
  );

  // Create two students + packages + entitlements.
  const student1Id = randomUUID();
  const student2Id = randomUUID();
  await setup.db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student 1');`,
    [student1Id, ACADEMY_ID],
  );
  await setup.db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student 2');`,
    [student2Id, ACADEMY_ID],
  );

  // Enroll both students in the small class.
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: student1Id,
    classId: smallClassId,
    effectiveFrom: new Date(),
  }, setup.db);
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: student2Id,
    classId: smallClassId,
    effectiveFrom: new Date(),
  }, setup.db);

  // Purchase packages for both.
  const pkg1 = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: student1Id,
    packagePlanId: setup.plan4Id,
  }, setup.db);
  const pkg2 = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: student2Id,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  // Assign student 1's first entitlement to the occurrence — succeeds (capacity=1).
  await assignOccurrence(setup.admin, ACADEMY_ID, {
    entitlementId: pkg1.entitlementIds[0]!,
    occurrenceId: occId,
  }, setup.db);

  // Assign student 2's first entitlement to the SAME occurrence — should fail (over capacity).
  try {
    await assignOccurrence(setup.admin, ACADEMY_ID, {
      entitlementId: pkg2.entitlementIds[0]!,
      occurrenceId: occId,
    }, setup.db);
    expect.fail("should have thrown (over capacity)");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
    expect((err as AppError).message).toContain("capacity");
  }
});
