/**
 * API integration tests: Expenses (Stage 5).
 * Tests route handlers against in-memory PgLite. NOT real PostgreSQL.
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
let coachA: TestUser;
let studentId: string;
let studentBId: string;
let classId: string;
let plan4Id: string;
let paymentIdA: string;
let paymentIdB: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);

  studentId = randomUUID();
  studentBId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`, [studentBId, ACADEMY_B_ID]);

  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classId]);

  plan4Id = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [plan4Id, ACADEMY_A_ID]);

  // Create a confirmed payment in academy A (manual, with package).
  const pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkgId, studentId, plan4Id, classId]);
  for (let i = 0; i < 4; i++) {
    await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, $3, 'active');`, [randomUUID(), pkgId, i + 1]);
  }
  paymentIdA = randomUUID();
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash) VALUES ($1, $2, $3, $4, 400000, 'IDR', 'confirmed', $3, now(), 'Budi', 'cash', '2027-06-01', $3, $5, $6);`, [paymentIdA, ACADEMY_A_ID, adminA.id, studentId, `key-${randomUUID()}`, "hash-a"]);
  await db.query(`INSERT INTO payment_allocations (id, payment_id, student_package_id, amount) VALUES ($1, $2, $3, 400000);`, [randomUUID(), paymentIdA, pkgId]);

  // A payment in academy B (for cross-academy test).
  paymentIdB = randomUUID();
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash) VALUES ($1, $2, $3, $4, 100000, 'IDR', 'confirmed', $3, now(), 'Other', 'cash', '2027-06-01', $3, $5, $6);`, [paymentIdB, ACADEMY_B_ID, adminA.id, studentBId, `key-${randomUUID()}`, "hash-b"]);
});

afterEach(async () => { await teardownTestDb(); });

async function login(email: string, pw: string): Promise<{ s: string; c: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(await makeRequest("/api/auth/login", { method: "POST", body: { email, password: pw } }));
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  return { s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!, c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]! };
}
function auth(s: string, c: string) { return { cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c }, headers: { [CSRF_HEADER]: c } }; }

// === POST record expense =================================================

test("POST expense records (201) + audit", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 500000, category: "field_rent", incurredOn: "2027-06-01", note: "Weekly field rental" }, ...auth(s, c) }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { expenseId: string };
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'expense.record' AND target_id = $1;`, [json.expenseId]);
  expect((audit.rows[0] as { c: number }).c).toBe(1);
});

test("POST expense with category 'refund' + related payment (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 400000, category: "refund", incurredOn: "2027-06-05", note: "Refund to Budi", relatedPaymentId: paymentIdA }, ...auth(s, c) }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { expenseId: string };
  // Verify related_payment_id set.
  const exp = await db.query<{ related_payment_id: string | null; category: string }>(`SELECT related_payment_id, category FROM academy_expenses WHERE id = $1;`, [json.expenseId]);
  const erow = exp.rows[0] as { related_payment_id: string | null; category: string };
  expect(erow.related_payment_id).toBe(paymentIdA);
  expect(erow.category).toBe("refund");
});

test("POST refund expense does NOT mutate payment, package, entitlements, or attendance", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  // Snapshot before.
  const payBefore = await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1;`, [paymentIdA]);
  const entBefore = await db.query<{ c: number; completed: number }>(`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE e.status='completed')::int AS completed FROM session_entitlements e JOIN student_packages sp ON sp.id = e.student_package_id WHERE sp.student_id = $1;`, [studentId]);
  const attBefore = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM attendance_records;`);

  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 400000, category: "refund", incurredOn: "2027-06-05", relatedPaymentId: paymentIdA }, ...auth(s, c) }));
  expect(res.status).toBe(201);

  // Snapshot after — no change.
  const payAfter = await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1;`, [paymentIdA]);
  expect((payAfter.rows[0] as { status: string }).status).toBe((payBefore.rows[0] as { status: string }).status);
  const entAfter = await db.query<{ c: number; completed: number }>(`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE e.status='completed')::int AS completed FROM session_entitlements e JOIN student_packages sp ON sp.id = e.student_package_id WHERE sp.student_id = $1;`, [studentId]);
  const ea = entAfter.rows[0] as { c: number; completed: number };
  const eb = entBefore.rows[0] as { c: number; completed: number };
  expect(ea.c).toBe(eb.c);
  expect(ea.completed).toBe(eb.completed);
  const attAfter = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM attendance_records;`);
  expect((attAfter.rows[0] as { c: number }).c).toBe((attBefore.rows[0] as { c: number }).c);
});

test("POST expense rejects cross-academy relatedPaymentId (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 100000, category: "refund", incurredOn: "2027-06-05", relatedPaymentId: paymentIdB }, ...auth(s, c) }));
  expect(res.status).toBe(404);
});

test("POST expense rejects negative amount (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: -100, category: "field_rent", incurredOn: "2027-06-01" }, ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST expense rejects empty category (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 100, category: "", incurredOn: "2027-06-01" }, ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST expense rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 100, category: "field_rent", incurredOn: "2027-06-01" }, ...auth(s, c) }));
  expect(res.status).toBe(403);
});

test("POST expense rejects without CSRF (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 100, category: "field_rent", incurredOn: "2027-06-01" }, cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});

// === GET list + detail ==================================================

test("GET expense list by date range (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 500000, category: "field_rent", incurredOn: "2027-06-01" }, ...auth(s, c) }));
  await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 200000, category: "operations", incurredOn: "2027-06-15" }, ...auth(s, c) }));

  const { GET } = await import("@/app/api/admin/expenses/route");
  const res = await GET(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}&fromDate=2027-06-01&toDate=2027-06-30`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { expenses: { category: string }[] };
  expect(json.expenses.length).toBe(2);
});

test("GET expense detail (200) + cross-academy (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const rec = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 500000, category: "field_rent", incurredOn: "2027-06-01" }, ...auth(s, c) }));
  const recJson = (await rec.json()) as { expenseId: string };

  const { GET } = await import("@/app/api/admin/expenses/[id]/route");
  const res = await GET(await makeRequest(`/api/admin/expenses/${recJson.expenseId}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: recJson.expenseId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { expense: { category: string; amount: string } };
  expect(json.expense.category).toBe("field_rent");

  // Cross-academy (random UUID from other academy won't exist).
  const res2 = await GET(await makeRequest(`/api/admin/expenses/${randomUUID()}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: randomUUID() }) });
  expect(res2.status).toBe(404);
});

// === PATCH note only ====================================================

test("PATCH expense note (200) + audit; amount immutable (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const rec = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 500000, category: "field_rent", incurredOn: "2027-06-01", note: "Original" }, ...auth(s, c) }));
  const recJson = (await rec.json()) as { expenseId: string };

  const { PATCH } = await import("@/app/api/admin/expenses/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/expenses/${recJson.expenseId}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { note: "Updated note" }, ...auth(s, c) }), { params: Promise.resolve({ id: recJson.expenseId }) });
  expect(res.status).toBe(200);
  const exp = await db.query<{ note: string | null }>(`SELECT note FROM academy_expenses WHERE id = $1;`, [recJson.expenseId]);
  expect((exp.rows[0] as { note: string | null }).note).toBe("Updated note");
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'expense.update' AND target_id = $1;`, [recJson.expenseId]);
  expect((audit.rows[0] as { c: number }).c).toBe(1);

  // Amount/category/incurredOn immutable — Zod schema rejects them.
  const res2 = await PATCH(await makeRequest(`/api/admin/expenses/${recJson.expenseId}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { note: "x", amount: 999 }, ...auth(s, c) }), { params: Promise.resolve({ id: recJson.expenseId }) });
  expect(res2.status).toBe(422);
});

test("PATCH expense rejects without CSRF (403)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  const rec = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 500000, category: "field_rent", incurredOn: "2027-06-01" }, ...auth(s, c) }));
  const recJson = (await rec.json()) as { expenseId: string };

  const { PATCH } = await import("@/app/api/admin/expenses/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/expenses/${recJson.expenseId}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { note: "x" }, cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: recJson.expenseId }) });
  expect(res.status).toBe(403);
});

// === Rollback ============================================================

test("Rollback: failed expense insert leaves no audit", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/expenses/route");
  // Use a cross-academy relatedPaymentId to force failure inside the tx.
  const res = await POST(await makeRequest(`/api/admin/expenses?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { amount: 100000, category: "refund", incurredOn: "2027-06-05", relatedPaymentId: paymentIdB }, ...auth(s, c) }));
  expect(res.status).toBe(404);
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'expense.record';`);
  expect((audit.rows[0] as { c: number }).c).toBe(0);
  const exp = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM academy_expenses WHERE academy_id = $1;`, [ACADEMY_A_ID]);
  expect((exp.rows[0] as { c: number }).c).toBe(0);
});
