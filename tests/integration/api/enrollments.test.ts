/**
 * API integration tests: Enrollment and class roster endpoints.
 *
 * Tests the actual route handlers against in-memory PgLite.
 * NOT real PostgreSQL.
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
let classAId: string;
let classBId: string;
let studentId: string;
let studentBId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);

  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });

  classAId = randomUUID();
  classBId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Class A', 10, true);`, [classAId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Class B', 10, true);`, [classBId, ACADEMY_A_ID]);

  studentId = randomUUID();
  studentBId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`, [studentBId, ACADEMY_B_ID]);
});

afterEach(async () => { await teardownTestDb(); });

async function login(email: string, password: string): Promise<{ s: string; c: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", { method: "POST", body: { email, password } });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  return { s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!, c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]! };
}

function auth(s: string, c: string) {
  return { cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c }, headers: { [CSRF_HEADER]: c } };
}

// === POST: Create enrollment ==============================================

test("POST enrollment creates (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/enrollments/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/enrollments?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { classId: classAId, effectiveFrom: "2026-01-01" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(201);
  const audit = await db.query(`SELECT action FROM audit_events WHERE action = 'enrollment.create'`);
  expect(audit.rows.length).toBe(1);
});

test("POST enrollment rejects duplicate active (409)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classAId]);
  const { POST } = await import("@/app/api/admin/students/[id]/enrollments/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/enrollments?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { classId: classBId, effectiveFrom: "2026-02-01" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(409);
});

test("POST enrollment rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/enrollments/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/enrollments?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { classId: classAId, effectiveFrom: "2026-01-01" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(403);
});

test("POST enrollment rejects cross-academy student (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/enrollments/route");
  const req = await makeRequest(`/api/admin/students/${studentBId}/enrollments?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { classId: classAId, effectiveFrom: "2026-01-01" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentBId }) });
  expect(res.status).toBe(404);
});

// === GET: List enrollments ================================================

test("GET enrollments lists history (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to) VALUES ($1, $2, $3, '2025-06-01', '2025-12-31');`, [randomUUID(), studentId, classAId]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classBId]);
  const { GET } = await import("@/app/api/admin/students/[id]/enrollments/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/enrollments?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } });
  const res = await GET(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { enrollments: { class_name: string }[] };
  expect(json.enrollments.length).toBe(2);
  expect(json.enrollments[0]!.class_name).toBe("Class B"); // most recent first
});

// === POST: Transfer ======================================================

test("POST transfer closes old + creates new (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classAId]);
  const { POST } = await import("@/app/api/admin/students/[id]/transfer/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/transfer?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { newClassId: classBId, effectiveFrom: "2026-02-01", reason: "Move" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  // Verify old enrollment is closed
  const old = await db.query<{ effective_to: Date | null }>(`SELECT effective_to FROM student_enrollments WHERE student_id = $1 AND class_id = $2;`, [studentId, classAId]);
  expect((old.rows[0] as { effective_to: Date | null }).effective_to).not.toBeNull();
  // Verify new enrollment is active
  const newE = await db.query(`SELECT id FROM student_enrollments WHERE student_id = $1 AND class_id = $2 AND effective_to IS NULL;`, [studentId, classBId]);
  expect(newE.rows.length).toBe(1);
});

// === POST: End enrollment ================================================

test("POST end enrollment closes active (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classAId]);
  const { POST } = await import("@/app/api/admin/students/[id]/enrollments/end/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/enrollments/end?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { effectiveTo: "2026-06-30", reason: "Left" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const r = await db.query<{ effective_to: Date | null }>(`SELECT effective_to FROM student_enrollments WHERE student_id = $1;`, [studentId]);
  expect((r.rows[0] as { effective_to: Date | null }).effective_to).not.toBeNull();
});

test("POST end enrollment rejects if no active (409)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/enrollments/end/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/enrollments/end?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { effectiveTo: "2026-06-30" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(409);
});

// === GET: Class roster ===================================================

test("GET roster returns students enrolled on date", async () => {
  const { s } = await login(adminA.email, adminA.password);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classAId]);
  const { GET } = await import("@/app/api/admin/classes/[id]/roster/route");
  const req = await makeRequest(`/api/admin/classes/${classAId}/roster?academyId=${ACADEMY_A_ID}&date=2026-03-15`, { cookies: { [sessionCookieName()]: s } });
  const res = await GET(req, { params: Promise.resolve({ id: classAId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { roster: { full_name: string }[] };
  expect(json.roster.length).toBe(1);
  expect(json.roster[0]!.full_name).toBe("Student A");
});

test("GET roster excludes students before enrollment start", async () => {
  const { s } = await login(adminA.email, adminA.password);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-03-01');`, [randomUUID(), studentId, classAId]);
  const { GET } = await import("@/app/api/admin/classes/[id]/roster/route");
  const req = await makeRequest(`/api/admin/classes/${classAId}/roster?academyId=${ACADEMY_A_ID}&date=2026-02-15`, { cookies: { [sessionCookieName()]: s } });
  const res = await GET(req, { params: Promise.resolve({ id: classAId }) });
  const json = (await res.json()) as { roster: unknown[] };
  expect(json.roster.length).toBe(0);
});

test("GET roster shows correct class after transfer", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to) VALUES ($1, $2, $3, '2026-01-01', '2026-01-31');`, [randomUUID(), studentId, classAId]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-02-01');`, [randomUUID(), studentId, classBId]);
  const { GET } = await import("@/app/api/admin/classes/[id]/roster/route");

  // Before transfer: in classA
  const req1 = await makeRequest(`/api/admin/classes/${classAId}/roster?academyId=${ACADEMY_A_ID}&date=2026-01-15`, { cookies: { [sessionCookieName()]: s } });
  const res1 = await GET(req1, { params: Promise.resolve({ id: classAId }) });
  expect(((await res1.json()) as { roster: unknown[] }).roster.length).toBe(1);

  // After transfer: not in classA
  const req2 = await makeRequest(`/api/admin/classes/${classAId}/roster?academyId=${ACADEMY_A_ID}&date=2026-02-15`, { cookies: { [sessionCookieName()]: s } });
  const res2 = await GET(req2, { params: Promise.resolve({ id: classAId }) });
  expect(((await res2.json()) as { roster: unknown[] }).roster.length).toBe(0);

  // After transfer: in classB
  const req3 = await makeRequest(`/api/admin/classes/${classBId}/roster?academyId=${ACADEMY_A_ID}&date=2026-02-15`, { cookies: { [sessionCookieName()]: s } });
  const res3 = await GET(req3, { params: Promise.resolve({ id: classBId }) });
  expect(((await res3.json()) as { roster: unknown[] }).roster.length).toBe(1);
});

// === Audit rollback ======================================================

test("audit rollback: failed enrollment creation leaves no audit", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const { createEnrollment } = await import("@/lib/domain/enrollments");
  const { AppError } = await import("@/lib/errors");
  const sessionReq = await makeRequest("/api/auth/session", { cookies: { [sessionCookieName()]: s } });
  const principal = (await extractPrincipal(sessionReq, db))!.principal;

  // Try to enroll in a class from another academy
  const otherClassId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Other', 10);`, [otherClassId, ACADEMY_B_ID]);

  try {
    await createEnrollment(principal, ACADEMY_A_ID, { studentId, classId: otherClassId, effectiveFrom: new Date("2026-01-01") }, db);
    expect.fail("should have thrown");
  } catch (err) { expect(err).toBeInstanceOf(AppError); }

  const audit = await db.query(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'enrollment.create'`);
  expect((audit.rows[0] as { c: number }).c).toBe(0);
});

// === Package preservation after transfer =================================

test("transfer preserves existing package class_id_at_purchase", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Create enrollment in classA
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classAId]);
  // Create a package plan + student package
  const planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Plan', 4);`, [planId, ACADEMY_A_ID]);
  const pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkgId, studentId, planId, classAId]);

  // Transfer to classB
  const { POST } = await import("@/app/api/admin/students/[id]/transfer/route");
  const req = await makeRequest(`/api/admin/students/${studentId}/transfer?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { newClassId: classBId, effectiveFrom: "2026-02-01" }, ...auth(s, c),
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);

  // Verify package's class_id_at_purchase is unchanged
  const pkgResult = await db.query<{ class_id_at_purchase: string }>(`SELECT class_id_at_purchase FROM student_packages WHERE id = $1;`, [pkgId]);
  expect((pkgResult.rows[0] as { class_id_at_purchase: string }).class_id_at_purchase).toBe(classAId);
});
