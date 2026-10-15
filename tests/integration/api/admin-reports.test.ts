/**
 * Phase B2.8 — Reports endpoints regression tests.
 *
 * Covers:
 *   1. GET /api/admin/reports/students — student roster report.
 *   2. GET /api/admin/reports/attendance?studentId=Y — per-student attendance.
 *   3. GET /api/admin/reports/finance?fromDate=Y&toDate=Z — monthly finance.
 *   4. Cross-academy isolation.
 *   5. Auth (401 without session, 403 cross-academy).
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
let classAId: string;
let planAId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  adminB = await createTestUser(db, { email: "admin-b@example.com", password: "password123", role: "admin", academyId: ACADEMY_B_ID });

  // Academy A: class + plan + student
  classAId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Class A', 12, true);`, [classAId, ACADEMY_A_ID]);
  planAId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count, is_active) VALUES ($1, $2, 'Plan A', 4, true);`, [planAId, ACADEMY_A_ID]);
  studentAId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentAId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentAId, classAId]);

  // Academy B: student
  studentBId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`, [studentBId, ACADEMY_B_ID]);
});

afterEach(async () => {
  await teardownTestDb();
});

async function login(email: string, pw: string): Promise<{ s: string; c: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(await makeRequest("/api/auth/login", { method: "POST", body: { email, password: pw } }));
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  return {
    s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!,
    c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]!,
  };
}
function noAuth(s: string) {
  return { cookies: { [sessionCookieName()]: s } };
}

// ====================================================================
// Student Roster Report
// ====================================================================

test("STUDENT_ROSTER: returns students in the academy with summary counts", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/students/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/students?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { students: { fullName: string }[]; totalStudents: number; activeStudents: number };
  expect(json.totalStudents).toBe(1);
  expect(json.activeStudents).toBe(1);
  expect(json.students[0]!.fullName).toBe("Student A");
});

test("STUDENT_ROSTER: admin B cannot see academy A's students", async () => {
  const { s } = await login(adminB.email, adminB.password);
  const { GET } = await import("@/app/api/admin/reports/students/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/students?academyId=${ACADEMY_B_ID}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { students: { fullName: string }[] };
  expect(json.students.length).toBe(1);
  expect(json.students[0]!.fullName).toBe("Student B");
  // Academy A's student must NOT appear.
  expect(json.students.find((st) => st.fullName === "Student A")).toBeUndefined();
});

test("STUDENT_ROSTER: admin A querying academyId=B is forbidden (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/students/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/students?academyId=${ACADEMY_B_ID}`, noAuth(s)));
  expect(res.status).toBe(403);
});

test("STUDENT_ROSTER: unauthenticated returns 401", async () => {
  const { GET } = await import("@/app/api/admin/reports/students/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/students?academyId=${ACADEMY_A_ID}`));
  expect(res.status).toBe(401);
});

// ====================================================================
// Per-Student Attendance Report
// ====================================================================

test("ATTENDANCE_REPORT: returns attendance history + summary for a student", async () => {
  // Create an occurrence + attendance record.
  const versionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, classAId]);
  const slotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotId, versionId]);
  const occId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2026-10-13', '2026-10-13 08:00:00+00', '2026-10-13 09:00:00+00', 'planned', 12);`, [occId, ACADEMY_A_ID, classAId, slotId, versionId]);
  await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by) VALUES ($1, $2, $3, 'present', $4);`, [randomUUID(), occId, studentAId, adminA.id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/attendance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/attendance?academyId=${ACADEMY_A_ID}&studentId=${studentAId}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { studentName: string; records: { status: string }[]; summary: { total: number; present: number; attendanceRate: number } };
  expect(json.studentName).toBe("Student A");
  expect(json.records.length).toBe(1);
  expect(json.records[0]!.status).toBe("present");
  expect(json.summary.total).toBe(1);
  expect(json.summary.present).toBe(1);
  expect(json.summary.attendanceRate).toBe(100);
});

test("ATTENDANCE_REPORT: cross-academy student returns 404", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/attendance/route.ts");
  // Admin A queries academy B's student via academyId=A.
  const res = await GET(await makeRequest(`/api/admin/reports/attendance?academyId=${ACADEMY_A_ID}&studentId=${studentBId}`, noAuth(s)));
  expect(res.status).toBe(404);
});

test("ATTENDANCE_REPORT: missing studentId returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/attendance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/attendance?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(422);
});

test("ATTENDANCE_REPORT: invalid studentId returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/attendance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/attendance?academyId=${ACADEMY_A_ID}&studentId=not-a-uuid`, noAuth(s)));
  expect(res.status).toBe(422);
});

// ====================================================================
// Monthly Financial Report
// ====================================================================

test("FINANCE_REPORT: returns payments + expenses + summary for the date range", async () => {
  // Create a payment + expense in academy A.
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, payment_method, payment_date, payer_name, status, reviewed_by, reviewed_at, recorded_by, idempotency_key) VALUES ($1, $2, $3, $4, 500000, 'IDR', 'cash', '2026-10-13', 'Parent A', 'confirmed', $3, now(), $3, $5);`, [randomUUID(), ACADEMY_A_ID, adminA.id, studentAId, randomUUID()]);
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'Equipment', 100000, 'IDR', '2026-10-13', $3);`, [randomUUID(), ACADEMY_A_ID, adminA.id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/finance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/finance?academyId=${ACADEMY_A_ID}&fromDate=2026-10-01&toDate=2026-10-31`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    payments: { studentName: string }[];
    expenses: { category: string }[];
    summary: { totalIncome: string; totalExpenses: string; net: string; paymentCount: number; expenseCount: number };
  };
  expect(json.payments.length).toBe(1);
  expect(json.expenses.length).toBe(1);
  expect(json.summary.paymentCount).toBe(1);
  expect(json.summary.expenseCount).toBe(1);
  expect(Number(json.summary.totalIncome)).toBe(500000);
  expect(Number(json.summary.totalExpenses)).toBe(100000);
  expect(Number(json.summary.net)).toBe(400000);
});

test("FINANCE_REPORT: date range filter excludes out-of-range items", async () => {
  // Payment in October, expense in August.
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, payment_method, payment_date, payer_name, status, reviewed_by, reviewed_at, recorded_by, idempotency_key) VALUES ($1, $2, $3, $4, 500000, 'IDR', 'cash', '2026-10-13', 'Parent A', 'confirmed', $3, now(), $3, $5);`, [randomUUID(), ACADEMY_A_ID, adminA.id, studentAId, randomUUID()]);
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'Rent', 200000, 'IDR', '2026-08-15', $3);`, [randomUUID(), ACADEMY_A_ID, adminA.id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/finance/route.ts");
  // Query only October — the August expense must NOT appear.
  const res = await GET(await makeRequest(`/api/admin/reports/finance?academyId=${ACADEMY_A_ID}&fromDate=2026-10-01&toDate=2026-10-31`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { expenses: { category: string }[] };
  expect(json.expenses.length).toBe(0); // The August expense is out of range.
});

test("FINANCE_REPORT: fromDate > toDate returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/finance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/finance?academyId=${ACADEMY_A_ID}&fromDate=2026-10-31&toDate=2026-10-01`, noAuth(s)));
  expect(res.status).toBe(422);
});

test("FINANCE_REPORT: missing dates returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/finance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/finance?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(422);
});

test("FINANCE_REPORT: admin A querying academyId=B is forbidden (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/reports/finance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/finance?academyId=${ACADEMY_B_ID}&fromDate=2026-10-01&toDate=2026-10-31`, noAuth(s)));
  expect(res.status).toBe(403);
});

test("FINANCE_REPORT: unauthenticated returns 401", async () => {
  const { GET } = await import("@/app/api/admin/reports/finance/route.ts");
  const res = await GET(await makeRequest(`/api/admin/reports/finance?academyId=${ACADEMY_A_ID}&fromDate=2026-10-01&toDate=2026-10-31`));
  expect(res.status).toBe(401);
});
