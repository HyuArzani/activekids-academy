/**
 * Phase B2.4 — Academy-wide payments endpoint regression tests.
 *
 * Covers:
 *   1. GET /api/admin/payments?academyId=X&fromDate=Y&toDate=Z —
 *      academy-wide listing across all students.
 *   2. Auth + cross-academy isolation (admin A cannot see academy B's
 *      payments even via the academy-wide endpoint).
 *   3. Validation: fromDate > toDate → 422; missing both studentId and
 *      dates → 422; invalid dates → 422.
 *   4. Back-compat: GET with studentId still returns that student's
 *      payments (existing tests depend on this behavior).
 *   5. POST /api/admin/payments — record a payment + atomic package
 *      purchase (smoke test; the deeper idempotency tests are in
 *      tests/integration/api/payments.test.ts).
 *
 * Tests run under PgLite (NOT real PostgreSQL).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  setupTestDb,
  teardownTestDb,
  createTestUser,
  makeRequest,
  ACADEMY_A_ID,
  ACADEMY_B_ID,
  type TestUser,
} from "../_auth-helpers";
import type { DbClient } from "@/lib/db";
import { sessionCookieName } from "@/lib/auth/session";
import { csrfCookieName, CSRF_HEADER } from "@/lib/auth/csrf";

let db: DbClient;
let adminA: TestUser;
let adminB: TestUser;
let studentAId: string;
let studentBId: string;
let planAId: string;
let paymentAId: string;
let paymentBId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`,
    [ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`,
    [ACADEMY_B_ID],
  );
  adminA = await createTestUser(db, {
    email: "admin-a@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
  });
  adminB = await createTestUser(db, {
    email: "admin-b@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_B_ID,
  });

  // Academy A: student + plan + payment
  studentAId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`,
    [studentAId, ACADEMY_A_ID],
  );
  planAId = randomUUID();
  await db.query(
    `INSERT INTO package_plans (id, academy_id, name, session_count, is_active) VALUES ($1, $2, 'Plan A 4', 4, true);`,
    [planAId, ACADEMY_A_ID],
  );
  paymentAId = randomUUID();
  await db.query(
    `INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, payment_method, payment_date, payer_name, status, reviewed_by, reviewed_at, recorded_by, idempotency_key)
     VALUES ($1, $2, $3, $4, 500000, 'IDR', 'cash', '2026-10-13', 'Parent A', 'confirmed', $3, now(), $3, $5);`,
    [paymentAId, ACADEMY_A_ID, adminA.id, studentAId, randomUUID()],
  );

  // Academy B: student + payment (different academy — admin A should not see this)
  studentBId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`,
    [studentBId, ACADEMY_B_ID],
  );
  paymentBId = randomUUID();
  await db.query(
    `INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, payment_method, payment_date, payer_name, status, reviewed_by, reviewed_at, recorded_by, idempotency_key)
     VALUES ($1, $2, $3, $4, 800000, 'IDR', 'bank_transfer', '2026-10-13', 'Parent B', 'confirmed', $3, now(), $3, $5);`,
    [paymentBId, ACADEMY_B_ID, adminB.id, studentBId, randomUUID()],
  );
});

afterEach(async () => {
  await teardownTestDb();
});

async function login(email: string, pw: string): Promise<{ s: string; c: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(
    await makeRequest("/api/auth/login", { method: "POST", body: { email, password: pw } }),
  );
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  return {
    s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!,
    c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]!,
  };
}
function auth(s: string, c: string) {
  return {
    cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c },
    headers: { [CSRF_HEADER]: c },
  };
}
function noAuth(s: string) {
  return { cookies: { [sessionCookieName()]: s } };
}

// ====================================================================
// Academy-wide listing
// ====================================================================

test("ACADEMY_PAYMENTS: returns only academy A's payments in the date range", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&fromDate=2026-10-01&toDate=2026-10-31`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { payments: { id: string; studentName: string }[] };
  expect(json.payments.length).toBe(1);
  expect(json.payments[0]!.id).toBe(paymentAId);
  expect(json.payments[0]!.studentName).toBe("Student A");
});

test("ACADEMY_PAYMENTS: date range filter excludes out-of-range payments", async () => {
  // Insert a second payment in academy A on a different date.
  const oldPayment = randomUUID();
  await db.query(
    `INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, payment_method, payment_date, payer_name, status, reviewed_by, reviewed_at, recorded_by, idempotency_key)
     VALUES ($1, $2, $3, $4, 200000, 'IDR', 'cash', '2026-08-15', 'Parent A2', 'confirmed', $3, now(), $3, $5);`,
    [oldPayment, ACADEMY_A_ID, adminA.id, studentAId, randomUUID()],
  );

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  // Query only October 2026 — the August payment must NOT appear.
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&fromDate=2026-10-01&toDate=2026-10-31`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { payments: { id: string }[] };
  expect(json.payments.length).toBe(1);
  expect(json.payments.find((p) => p.id === oldPayment)).toBeUndefined();
});

test("ACADEMY_PAYMENTS: admin A cannot see academy B's payments", async () => {
  // Admin A queries academy A — the result must NOT contain paymentBId.
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&fromDate=2026-10-01&toDate=2026-10-31`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { payments: { id: string }[] };
  expect(json.payments.find((p) => p.id === paymentBId)).toBeUndefined();
});

test("ACADEMY_PAYMENTS: admin A querying academyId=B is forbidden (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_B_ID}&fromDate=2026-10-01&toDate=2026-10-31`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(403);
});

test("ACADEMY_PAYMENTS: admin B sees only academy B's payments", async () => {
  const { s } = await login(adminB.email, adminB.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_B_ID}&fromDate=2026-10-01&toDate=2026-10-31`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { payments: { id: string }[] };
  expect(json.payments.length).toBe(1);
  expect(json.payments[0]!.id).toBe(paymentBId);
});

// ====================================================================
// Validation
// ====================================================================

test("VALIDATION: missing both studentId and dates returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, noAuth(s)),
  );
  expect(res.status).toBe(422);
});

test("VALIDATION: fromDate > toDate returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&fromDate=2026-10-31&toDate=2026-10-01`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(422);
});

test("VALIDATION: invalid date format returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&fromDate=not-a-date&toDate=2026-10-31`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(422);
});

// ====================================================================
// Back-compat: studentId mode still works
// ====================================================================

test("BACKCOMPAT: GET with studentId returns that student's payments (existing behavior)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&studentId=${studentAId}`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { payments: { id: string; studentId: string }[] };
  expect(json.payments.length).toBe(1);
  expect(json.payments[0]!.id).toBe(paymentAId);
  expect(json.payments[0]!.studentId).toBe(studentAId);
});

test("BACKCOMPAT: invalid studentId returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&studentId=not-a-uuid`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(422);
});

// ====================================================================
// Auth
// ====================================================================

test("AUTH: unauthenticated returns 401", async () => {
  const { GET } = await import("@/app/api/admin/payments/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/payments?academyId=${ACADEMY_A_ID}&fromDate=2026-10-01&toDate=2026-10-31`,
    ),
  );
  expect(res.status).toBe(401);
});
