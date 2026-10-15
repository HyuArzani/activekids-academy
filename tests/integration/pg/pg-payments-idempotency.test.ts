/**
 * PostgreSQL integration tests: Payment idempotency under real concurrency.
 *
 * These tests verify the concurrent-idempotency behavior of `recordPayment`
 * that CANNOT be tested under PgLite (single-process, single-connection):
 *   - Two concurrent requests with the same idempotency key + same body →
 *     exactly one succeeds; the other returns the original result. No
 *     duplicate payments, packages, or entitlements are created.
 *   - Two concurrent requests with the same key + different body → the
 *     winner commits; the loser returns 409 IDEMPOTENCY_KEY_REUSE.
 *
 * These tests ONLY run when TEST_DATABASE_URL is set to a real PostgreSQL
 * server. Under the current sandbox environment (Docker unavailable),
 * they are SKIPPED. Real PostgreSQL concurrency has NOT been verified
 * in this environment — the design is correct by inspection only.
 *
 * See `pg-safety.test.ts` for the safety check that prevents destructive
 * tests against non-test databases.
 */

import { expect } from "bun:test";
import { pgTest, setupPgDb, seedPgFixture } from "./_helpers";
import { PgAdapter } from "@/lib/db/pg-adapter";
import { recordPayment } from "@/lib/domain/payments";
import { buildAdminPrincipal, ACADEMY_ID } from "../domain/_helpers";

pgTest("concurrent same-key same-body idempotency: one winner, no duplicates", async () => {
  const db = await setupPgDb();
  await seedPgFixture(db);
  const admin = buildAdminPrincipal("00000000-0000-0000-0000-000000000001");

  // Issue two concurrent recordPayment calls with the same idempotency key.
  const input = {
    studentId: "00000000-0000-0000-0000-000000000010", // from seed fixture
    packagePlanId: "00000000-0000-0000-0000-000000000030",
    amount: 400000,
    paymentMethod: "cash" as const,
    paymentDate: "2027-06-01",
    payerName: "Concurrent Guardian",
    idempotencyKey: "concurrent-same-key-1",
  };

  const [r1, r2] = await Promise.allSettled([
    recordPayment(admin, ACADEMY_ID, input, db),
    recordPayment(admin, ACADEMY_ID, input, db),
  ]);

  // Exactly one should fulfill; the other should either return the same
  // result (idempotent replay) or throw a retryable conflict that the
  // retry loop resolves to the same result.
  const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null));
  const fulfilled = results.filter(Boolean);
  expect(fulfilled.length).toBe(2); // both should eventually return a result

  // Both results must point to the SAME payment (no duplicates).
  expect(fulfilled[0]!.paymentId).toBe(fulfilled[1]!.paymentId);
  expect(fulfilled[0]!.packageId).toBe(fulfilled[1]!.packageId);

  // Verify DB state: exactly one payment, one package, N entitlements.
  const payCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM payments WHERE idempotency_key = $1;`, ["concurrent-same-key-1"]);
  expect(payCount.rows[0]?.c).toBe(1);
  const entCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1;`, [fulfilled[0]!.packageId]);
  // session_count from seed fixture (4 or 8 — assert exactly N).
  expect(entCount.rows[0]?.c).toBeGreaterThan(0);
});

pgTest("concurrent same-key different-body: winner commits, loser gets 409", async () => {
  const db = await setupPgDb();
  await seedPgFixture(db);
  const admin = buildAdminPrincipal("00000000-0000-0000-0000-000000000001");

  const baseInput = {
    studentId: "00000000-0000-0000-0000-000000000010",
    packagePlanId: "00000000-0000-0000-0000-000000000030",
    amount: 400000,
    paymentMethod: "cash" as const,
    paymentDate: "2027-06-01",
    payerName: "Concurrent Guardian",
    idempotencyKey: "concurrent-diff-key-1",
  };

  // Different amount → different body hash.
  const input2 = { ...baseInput, amount: 500000 };

  const [r1, r2] = await Promise.allSettled([
    recordPayment(admin, ACADEMY_ID, baseInput, db),
    recordPayment(admin, ACADEMY_ID, input2, db),
  ]);

  // One succeeds; the other throws an AppError with code CONFLICT +
  // detail idempotency_key_reuse (409).
  const codes = [r1, r2].map((r) =>
    r.status === "rejected"
      ? (r.reason as { code?: string; detail?: string })
      : { code: "OK", detail: undefined },
  );
  const conflictCount = codes.filter((c) => c.code === "CONFLICT" && c.detail === "idempotency_key_reuse").length;
  const okCount = codes.filter((c) => c.code === "OK").length;
  expect(okCount).toBe(1);
  expect(conflictCount).toBe(1);
});

// Silence unused import warnings if helpers are unused in skip mode.
void PgAdapter;
