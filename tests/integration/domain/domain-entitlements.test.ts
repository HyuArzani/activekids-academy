/**
 * Domain test: Entitlement operations (skip, makeup, academy-cancel,
 * excused-absence, admin-correct, occurrence assignment).
 *
 * Tests invariants #2–#6, #9:
 *   #2  original_occurrence_id immutable once set (DB trigger + domain).
 *   #3  at most one skip per package; second skip fails.
 *   #4  skip releases occurrence, eligible for makeup.
 *   #5  makeup doesn't consume skip or duplicate.
 *   #6  academy-cancel doesn't consume skip.
 *   #9  admin-correct requires admin + reason + audit.
 *
 * Also tests Decision 1 (excused absence doesn't consume skip).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { setupDomainFixture, teardownDomainDb, ACADEMY_ID, buildCoachPrincipal, type DomainSetup } from "./_helpers";
import { purchasePackage, listEntitlementsForPackage } from "@/lib/domain/packages";
import { createEnrollment, transferClass } from "@/lib/domain/enrollments";
import { generateOccurrences } from "@/lib/domain/scheduling";
import {
  skipEntitlement,
  assignMakeup,
  cancelOccurrence,
  excusedAbsence,
  adminCorrect,
  assignOccurrence,
} from "@/lib/domain/entitlements";
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
  // Enroll the student.
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date(),
  }, setup.db);
  // Generate occurrences for 4 weeks.
  await generateOccurrences(setup.admin, ACADEMY_ID, {
    classId: setup.classId,
    fromDate: new Date(),
    weeksAhead: 4,
  }, setup.db);
});

afterEach(async () => {
  await teardownDomainDb();
});

// Helper: purchase a 4-session package and assign occurrences to all 4.
async function purchaseAndAssign(): Promise<{ packageId: string; entitlementIds: string[]; occurrenceIds: string[] }> {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  // Get upcoming occurrences.
  const occResult = await setup.db.query<{ id: string }>(
    `SELECT id FROM training_occurrences
      WHERE academy_id = $1 AND status = 'planned'
      ORDER BY occurrence_date
      LIMIT 4;`,
    [ACADEMY_ID],
  );
  const occurrenceIds = (occResult.rows as { id: string }[]).map(r => r.id);

  // Assign each entitlement to an occurrence.
  for (let i = 0; i < pkg.entitlementIds.length; i++) {
    const entId = pkg.entitlementIds[i]!;
    const occId = occurrenceIds[i];
    if (occId) {
      await assignOccurrence(setup.admin, ACADEMY_ID, {
        entitlementId: entId,
        occurrenceId: occId,
      }, setup.db);
    }
  }

  return { packageId: pkg.packageId, entitlementIds: pkg.entitlementIds, occurrenceIds };
}

// === Invariant #2: original_occurrence_id immutable once set =============

test("original_occurrence_id is set on first assignment and immutable after", async () => {
  const { entitlementIds, occurrenceIds } = await purchaseAndAssign();

  // Verify original_occurrence_id was set.
  const ent = await setup.db.query<{ original_occurrence_id: string; assigned_occurrence_id: string }>(
    `SELECT original_occurrence_id, assigned_occurrence_id FROM session_entitlements WHERE id = $1;`,
    [entitlementIds[0]!],
  );
  expect((ent.rows[0] as { original_occurrence_id: string }).original_occurrence_id).toBe(occurrenceIds[0]);
  expect((ent.rows[0] as { assigned_occurrence_id: string }).assigned_occurrence_id).toBe(occurrenceIds[0]);
});

test("adminCorrect cannot change original_occurrence_id (trigger blocks it)", async () => {
  const { entitlementIds, occurrenceIds } = await purchaseAndAssign();

  // Try to adminCorrect with a different occurrence (which would change original).
  // adminCorrect only changes assigned_occurrence_id, not original.
  // The trigger prevents changing original_occurrence_id directly.
  try {
    await setup.db.query(
      `UPDATE session_entitlements SET original_occurrence_id = $2 WHERE id = $1;`,
      [entitlementIds[0]!, occurrenceIds[1]!],
    );
    expect.fail("should have thrown (trigger blocks original_occurrence_id change)");
  } catch (err) {
    expect(dbErrorMessage(err)).toContain("immutable");
  }
});

// === Invariant #3: at most one skip per package; second skip fails =======

test("skip succeeds for the first entitlement (consumes skip allowance)", async () => {
  const { entitlementIds } = await purchaseAndAssign();

  // Skip the first entitlement.
  await skipEntitlement(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    reason: "Student unavailable",
  }, setup.db);

  // Verify status.
  const ent = await setup.db.query<{ status: string; skip_used: boolean; assigned_occurrence_id: string | null }>(
    `SELECT status, skip_used, assigned_occurrence_id FROM session_entitlements WHERE id = $1;`,
    [entitlementIds[0]!],
  );
  expect((ent.rows[0] as { status: string }).status).toBe("skipped");
  expect((ent.rows[0] as { skip_used: boolean }).skip_used).toBe(true);
  expect((ent.rows[0] as { assigned_occurrence_id: string | null }).assigned_occurrence_id).toBeNull();
});

test("second skip for the same package is rejected with CONFLICT", async () => {
  const { entitlementIds } = await purchaseAndAssign();

  // First skip succeeds.
  await skipEntitlement(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    reason: "First skip",
  }, setup.db);

  // Second skip (different entitlement, same package) should fail.
  try {
    await skipEntitlement(setup.admin, ACADEMY_ID, {
      entitlementId: entitlementIds[1]!,
      reason: "Second skip",
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
    expect((err as AppError).message).toContain("Skip allowance exceeded");
  }
});

// === Invariant #4: skip releases occurrence, eligible for makeup =======

test("skip releases the assigned occurrence (assigned_occurrence_id → NULL)", async () => {
  const { entitlementIds } = await purchaseAndAssign();

  await skipEntitlement(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    reason: "Test skip",
  }, setup.db);

  const ent = await setup.db.query<{ status: string; assigned_occurrence_id: string | null }>(
    `SELECT status, assigned_occurrence_id FROM session_entitlements WHERE id = $1;`,
    [entitlementIds[0]!],
  );
  expect((ent.rows[0] as { status: string }).status).toBe("skipped");
  expect((ent.rows[0] as { assigned_occurrence_id: string | null }).assigned_occurrence_id).toBeNull();
});

// === Invariant #5: makeup doesn't consume skip or duplicate ============

test("makeup assigns a new occurrence without consuming another skip", async () => {
  const { entitlementIds, occurrenceIds } = await purchaseAndAssign();

  // Skip the first entitlement.
  await skipEntitlement(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    reason: "Skip for makeup test",
  }, setup.db);

  // Get a different future occurrence for makeup.
  const newOccResult = await setup.db.query<{ id: string }>(
    `SELECT id FROM training_occurrences
      WHERE academy_id = $1 AND status = 'planned'
        AND id <> ALL($2::uuid[])
      ORDER BY occurrence_date
      LIMIT 1;`,
    [ACADEMY_ID, occurrenceIds],
  );
  const newOccId = (newOccResult.rows[0] as { id: string }).id;

  // Assign makeup.
  await assignMakeup(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    newOccurrenceId: newOccId,
    reason: "Makeup session",
  }, setup.db);

  // Verify the entitlement is active again, assigned to the new occurrence.
  const ent = await setup.db.query<{ status: string; assigned_occurrence_id: string; skip_used: boolean }>(
    `SELECT status, assigned_occurrence_id, skip_used FROM session_entitlements WHERE id = $1;`,
    [entitlementIds[0]!],
  );
  expect((ent.rows[0] as { status: string }).status).toBe("active");
  expect((ent.rows[0] as { assigned_occurrence_id: string }).assigned_occurrence_id).toBe(newOccId);
  // skip_used is still true (the skip was consumed), but the makeup didn't consume ANOTHER skip.
  expect((ent.rows[0] as { skip_used: boolean }).skip_used).toBe(true);

  // Verify the same number of entitlements (no duplication).
  const allEnts = await setup.db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = (SELECT student_package_id FROM session_entitlements WHERE id = $1);`,
    [entitlementIds[0]!],
  );
  expect((allEnts.rows[0] as { c: number }).c).toBe(4); // still 4, no duplication
});

// === Invariant #6: academy-cancel doesn't consume skip ==================

test("academy-cancel sets entitlements to awaiting_makeup without consuming skip", async () => {
  const { entitlementIds, occurrenceIds } = await purchaseAndAssign();

  // Cancel the occurrence that entitlement 0 is assigned to.
  await cancelOccurrence(setup.admin, ACADEMY_ID, {
    occurrenceId: occurrenceIds[0]!,
    reason: "Academy holiday",
  }, setup.db);

  // Verify the entitlement is awaiting_makeup, skip_used=FALSE.
  const ent = await setup.db.query<{ status: string; skip_used: boolean; assigned_occurrence_id: string | null }>(
    `SELECT status, skip_used, assigned_occurrence_id FROM session_entitlements WHERE id = $1;`,
    [entitlementIds[0]!],
  );
  expect((ent.rows[0] as { status: string }).status).toBe("awaiting_makeup");
  expect((ent.rows[0] as { skip_used: boolean }).skip_used).toBe(false); // NOT consumed
  expect((ent.rows[0] as { assigned_occurrence_id: string | null }).assigned_occurrence_id).toBeNull();

  // The student can still skip a DIFFERENT entitlement (skip allowance intact).
  await skipEntitlement(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[1]!,
    reason: "Student skip after academy cancel",
  }, setup.db);
  // This should succeed — the academy-cancel did NOT consume the skip.
});

// === Decision 1: excused absence doesn't consume skip ===================

test("excused absence sets awaiting_makeup without consuming skip", async () => {
  const { entitlementIds } = await purchaseAndAssign();

  await excusedAbsence(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    reason: "Medical absence",
  }, setup.db);

  const ent = await setup.db.query<{ status: string; skip_used: boolean }>(
    `SELECT status, skip_used FROM session_entitlements WHERE id = $1;`,
    [entitlementIds[0]!],
  );
  expect((ent.rows[0] as { status: string }).status).toBe("awaiting_makeup");
  expect((ent.rows[0] as { skip_used: boolean }).skip_used).toBe(false); // NOT consumed
});

test("excused absence event is recorded distinctly from skip_requested", async () => {
  const { entitlementIds } = await purchaseAndAssign();

  await excusedAbsence(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    reason: "Medical",
  }, setup.db);

  const events = await setup.db.query<{ event_type: string }>(
    `SELECT event_type FROM entitlement_events WHERE entitlement_id = $1 ORDER BY occurred_at;`,
    [entitlementIds[0]!],
  );
  const types = (events.rows as { event_type: string }[]).map(r => r.event_type);
  expect(types).toContain("excused_absence");
  expect(types).not.toContain("skip_requested");
});

// === Invariant #9: admin-correct requires admin + reason + audit ======

test("adminCorrect requires admin role (coach rejected)", async () => {
  const { entitlementIds, occurrenceIds } = await purchaseAndAssign();
  const coach = buildCoachPrincipal(setup.adminUserId);

  try {
    await adminCorrect(coach, ACADEMY_ID, {
      entitlementId: entitlementIds[0]!,
      newAssignedOccurrenceId: occurrenceIds[1]!,
      reason: "Coach trying to correct",
    }, setup.db);
    expect.fail("should have thrown FORBIDDEN");
  } catch (err) {
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("adminCorrect requires non-empty reason", async () => {
  const { entitlementIds, occurrenceIds } = await purchaseAndAssign();

  try {
    await adminCorrect(setup.admin, ACADEMY_ID, {
      entitlementId: entitlementIds[0]!,
      newAssignedOccurrenceId: occurrenceIds[1]!,
      reason: "",
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("VALIDATION_FAILED");
  }
});

test("adminCorrect writes an audit event in the same transaction", async () => {
  const { entitlementIds, occurrenceIds } = await purchaseAndAssign();

  await adminCorrect(setup.admin, ACADEMY_ID, {
    entitlementId: entitlementIds[0]!,
    newAssignedOccurrenceId: occurrenceIds[1]!,
    reason: "Correcting assignment to later session",
  }, setup.db);

  // Verify the audit event exists.
  const audit = await setup.db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'entitlement.admin_correct' AND target_id = $1;`,
    [entitlementIds[0]!],
  );
  expect((audit.rows[0] as { c: number }).c).toBe(1);

  // Verify the entitlement event exists with the reason.
  const events = await setup.db.query<{ event_type: string; reason: string }>(
    `SELECT event_type, reason FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'admin_corrected';`,
    [entitlementIds[0]!],
  );
  expect(events.rows.length).toBe(1);
  expect((events.rows[0] as { reason: string }).reason).toBe("Correcting assignment to later session");
});

// === Occurrence assignment idempotency ===================================

test("assignOccurrence is idempotent (same occurrence → no-op)", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const occResult = await setup.db.query<{ id: string }>(
    `SELECT id FROM training_occurrences WHERE academy_id = $1 AND status = 'planned' ORDER BY occurrence_date LIMIT 1;`,
    [ACADEMY_ID],
  );
  const occId = (occResult.rows[0] as { id: string }).id;

  // First assignment.
  await assignOccurrence(setup.admin, ACADEMY_ID, {
    entitlementId: pkg.entitlementIds[0]!,
    occurrenceId: occId,
  }, setup.db);

  // Second call with same occurrence → no-op (idempotent).
  await assignOccurrence(setup.admin, ACADEMY_ID, {
    entitlementId: pkg.entitlementIds[0]!,
    occurrenceId: occId,
  }, setup.db);

  // Verify only one 'occurrence_assigned' event (no duplication).
  const events = await setup.db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'occurrence_assigned';`,
    [pkg.entitlementIds[0]!],
  );
  expect((events.rows[0] as { c: number }).c).toBe(1);
});

test("assignOccurrence rejects already-assigned entitlement (use adminCorrect)", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const occResult = await setup.db.query<{ id: string }>(
    `SELECT id FROM training_occurrences WHERE academy_id = $1 AND status = 'planned' ORDER BY occurrence_date LIMIT 2;`,
    [ACADEMY_ID],
  );
  const occ1 = (occResult.rows[0] as { id: string }).id;
  const occ2 = (occResult.rows[1] as { id: string }).id;

  // First assignment.
  await assignOccurrence(setup.admin, ACADEMY_ID, {
    entitlementId: pkg.entitlementIds[0]!,
    occurrenceId: occ1,
  }, setup.db);

  // Second assignment to a DIFFERENT occurrence → should fail.
  try {
    await assignOccurrence(setup.admin, ACADEMY_ID, {
      entitlementId: pkg.entitlementIds[0]!,
      occurrenceId: occ2,
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
  }
});
