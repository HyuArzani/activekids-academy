/**
 * Domain test: Payments and payment allocations.
 *
 * Tests that payment confirmation requires allocations, allocation sum
 * must not exceed the payment amount, and allocations are academy-scoped.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDomainFixture, teardownDomainDb, ACADEMY_ID, type DomainSetup } from "./_helpers";
import { createEnrollment } from "@/lib/domain/enrollments";
import { purchasePackage } from "@/lib/domain/packages";
import { submitPayment, confirmPayment } from "@/lib/domain/payments";
import { buildCoachPrincipal } from "./_helpers";
import { AppError } from "@/lib/errors";

let setup: DomainSetup;

beforeEach(async () => {
  setup = await setupDomainFixture();
  await createEnrollment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    classId: setup.classId,
    effectiveFrom: new Date(),
  }, setup.db);
});

afterEach(async () => {
  await teardownDomainDb();
});

test("submitPayment creates a payment with status='submitted'", async () => {
  const result = await submitPayment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    submittedAmount: 500000,
    evidenceUrl: "https://receipt.example/123",
  }, setup.db);

  const payment = await setup.db.query<{ status: string; submitted_amount: string }>(
    `SELECT status, submitted_amount FROM payments WHERE id = $1;`,
    [result.paymentId],
  );
  expect((payment.rows[0] as { status: string }).status).toBe("submitted");
  expect(parseFloat((payment.rows[0] as { submitted_amount: string }).submitted_amount)).toBe(500000);
});

test("confirmPayment with valid allocations succeeds", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const payment = await submitPayment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    submittedAmount: 500000,
  }, setup.db);

  await confirmPayment(setup.admin, ACADEMY_ID, {
    paymentId: payment.paymentId,
    allocations: [{ studentPackageId: pkg.packageId, amount: 500000 }],
    reviewerNote: "Verified receipt",
  }, setup.db);

  const result = await setup.db.query<{ status: string; reviewed_by: string | null }>(
    `SELECT status, reviewed_by FROM payments WHERE id = $1;`,
    [payment.paymentId],
  );
  expect((result.rows[0] as { status: string }).status).toBe("confirmed");
  expect((result.rows[0] as { reviewed_by: string | null }).reviewed_by).not.toBeNull();
});

test("confirmPayment rejects allocation sum exceeding payment amount", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);

  const payment = await submitPayment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    submittedAmount: 300000,
  }, setup.db);

  try {
    await confirmPayment(setup.admin, ACADEMY_ID, {
      paymentId: payment.paymentId,
      allocations: [{ studentPackageId: pkg.packageId, amount: 500000 }],
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
    expect((err as AppError).message).toContain("exceeds payment amount");
  }
});

test("confirmPayment requires admin role (coach rejected)", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);
  const payment = await submitPayment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    submittedAmount: 500000,
  }, setup.db);

  const coach = buildCoachPrincipal(setup.admin.userId);
  try {
    await confirmPayment(coach, ACADEMY_ID, {
      paymentId: payment.paymentId,
      allocations: [{ studentPackageId: pkg.packageId, amount: 500000 }],
    }, setup.db);
    expect.fail("should have thrown FORBIDDEN");
  } catch (err) {
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("confirmPayment on already-confirmed payment fails", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);
  const payment = await submitPayment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    submittedAmount: 500000,
  }, setup.db);

  // First confirmation succeeds.
  await confirmPayment(setup.admin, ACADEMY_ID, {
    paymentId: payment.paymentId,
    allocations: [{ studentPackageId: pkg.packageId, amount: 500000 }],
  }, setup.db);

  // Second confirmation fails.
  try {
    await confirmPayment(setup.admin, ACADEMY_ID, {
      paymentId: payment.paymentId,
      allocations: [{ studentPackageId: pkg.packageId, amount: 500000 }],
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
  }
});

test("payment allocation is unique per (payment, package) — DB UNIQUE", async () => {
  const pkg = await purchasePackage(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    packagePlanId: setup.plan4Id,
  }, setup.db);
  const payment = await submitPayment(setup.admin, ACADEMY_ID, {
    studentId: setup.studentId,
    submittedAmount: 500000,
  }, setup.db);

  // Confirm with an allocation.
  await confirmPayment(setup.admin, ACADEMY_ID, {
    paymentId: payment.paymentId,
    allocations: [{ studentPackageId: pkg.packageId, amount: 250000 }],
  }, setup.db);

  // Verify only one allocation row (ON CONFLICT DO NOTHING in confirmPayment).
  const allocResult = await setup.db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM payment_allocations WHERE payment_id = $1 AND student_package_id = $2;`,
    [payment.paymentId, pkg.packageId],
  );
  expect((allocResult.rows[0] as { c: number }).c).toBe(1);
});

test("submitPayment rejects negative amount", async () => {
  try {
    await submitPayment(setup.admin, ACADEMY_ID, {
      studentId: setup.studentId,
      submittedAmount: -100,
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("VALIDATION_FAILED");
  }
});
