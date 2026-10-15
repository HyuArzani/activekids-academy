/**
 * API integration tests: Student endpoints.
 *
 * Tests the actual route handlers (POST/GET/PATCH /api/admin/students)
 * by importing the exported functions and calling them with real
 * NextRequest objects.
 *
 * Covers:
 *   - Success: create, list, get, update
 *   - Validation: empty name, invalid input
 *   - Authentication: no session → 401
 *   - Authorization: coach → 403, parent → 403
 *   - CSRF: POST without CSRF → 403
 *   - Cross-academy: student from other academy → 404
 *
 * All tests run against in-memory PgLite (Bun runtime). NOT real PostgreSQL.
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
let parentA: TestUser;
let adminB: TestUser;

beforeEach(async () => {
  db = await setupTestDb();

  // Create test academies.
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'Academy A', 'a', 'Asia/Jakarta', true);`,
    [ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'Academy B', 'b', 'Asia/Jakarta', true);`,
    [ACADEMY_B_ID],
  );

  adminA = await createTestUser(db, {
    email: "admin-a@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
  });
  coachA = await createTestUser(db, {
    email: "coach-a@example.com",
    password: "password123",
    role: "coach",
    academyId: ACADEMY_A_ID,
  });
  parentA = await createTestUser(db, {
    email: "parent-a@example.com",
    password: "password123",
    role: "parent",
    academyId: ACADEMY_A_ID,
  });
  adminB = await createTestUser(db, {
    email: "admin-b@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_B_ID,
  });
});

afterEach(async () => {
  await teardownTestDb();
});

// Helper: log in and get cookies.
async function loginAndGetCookies(email: string, password: string): Promise<{ sessionToken: string; csrfToken: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const sessionMatch = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie);
  const csrfMatch = new RegExp(`${csrfCookieName()}=([^;]+)`).exec(setCookie);
  expect(sessionMatch).toBeTruthy();
  expect(csrfMatch).toBeTruthy();
  return {
    sessionToken: sessionMatch![1]!,
    csrfToken: csrfMatch![1]!,
  };
}

// === POST: Create =========================================================

test("POST /api/admin/students creates a student (success)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    method: "POST",
    body: { fullName: "Budi Santoso", dateOfBirth: "2015-03-15", gender: "male" },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string; fullName: string };
  expect(json.fullName).toBe("Budi Santoso");
  expect(json.id).toBeTruthy();

  // Verify the student exists in the DB.
  const dbResult = await db.query(`SELECT full_name FROM students WHERE id = $1;`, [json.id]);
  expect((dbResult.rows[0] as { full_name: string }).full_name).toBe("Budi Santoso");

  // Verify audit event was written.
  const auditResult = await db.query(`SELECT action FROM audit_events WHERE target_id = $1;`, [json.id]);
  expect((auditResult.rows[0] as { action: string }).action).toBe("student.create");
});

test("POST /api/admin/students rejects empty fullName (422)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    method: "POST",
    body: { fullName: "" },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(422);
});

test("POST /api/admin/students rejects coach (403)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    method: "POST",
    body: { fullName: "Test Student" },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
});

test("POST /api/admin/students rejects parent (403)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    method: "POST",
    body: { fullName: "Test Student" },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
});

test("POST /api/admin/students rejects without session (401)", async () => {
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    method: "POST",
    body: { fullName: "Test Student" },
  });
  const res = await POST(req);
  expect(res.status).toBe(401);
});

test("POST /api/admin/students rejects without CSRF (403)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    method: "POST",
    body: { fullName: "Test Student" },
    cookies: { [sessionCookieName()]: sessionToken },
    // No CSRF cookie or header.
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
});

test("POST /api/admin/students rejects admin from different academy (403)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminB.email, adminB.password);
  const { POST } = await import("@/app/api/admin/students/route");
  // adminB is admin in Academy B, trying to create a student in Academy A.
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    method: "POST",
    body: { fullName: "Cross-Academy Student" },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
});

// === GET: List ===========================================================

test("GET /api/admin/students lists students (success)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  // Create a student directly in the DB.
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'List Test');`, [studentId, ACADEMY_A_ID]);

  const { GET } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { students: { id: string; full_name: string }[] };
  expect(json.students.length).toBeGreaterThanOrEqual(1);
  expect(json.students.some((s) => s.id === studentId)).toBe(true);
});

test("GET /api/admin/students does NOT list other academy's students", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  // Create a student in Academy B.
  const studentIdB = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Other Academy Student');`, [studentIdB, ACADEMY_B_ID]);

  const { GET } = await import("@/app/api/admin/students/route");
  const req = await makeRequest("/api/admin/students?academyId=" + ACADEMY_A_ID, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { students: { id: string }[] };
  // Academy B's student should NOT appear.
  expect(json.students.some((s) => s.id === studentIdB)).toBe(false);
});

// === GET /:id: Single student ============================================

test("GET /api/admin/students/:id returns the student (success)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Single Test');`, [studentId, ACADEMY_A_ID]);

  const { GET } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentId}?academyId=` + ACADEMY_A_ID, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { id: string; fullName: string };
  expect(json.id).toBe(studentId);
  expect(json.fullName).toBe("Single Test");
});

test("GET /api/admin/students/:id returns 404 for other academy's student", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  // Create a student in Academy B.
  const studentIdB = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Other Academy');`, [studentIdB, ACADEMY_B_ID]);

  const { GET } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentIdB}?academyId=` + ACADEMY_A_ID, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req, { params: Promise.resolve({ id: studentIdB }) });
  expect(res.status).toBe(404);
});

// === PATCH: Update =======================================================

test("PATCH /api/admin/students/:id updates the student (success)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Before Update');`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentId}?academyId=` + ACADEMY_A_ID, {
    method: "PATCH",
    body: { fullName: "After Update" },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { fullName: string };
  expect(json.fullName).toBe("After Update");

  // Verify the update persisted.
  const dbResult = await db.query(`SELECT full_name FROM students WHERE id = $1;`, [studentId]);
  expect((dbResult.rows[0] as { full_name: string }).full_name).toBe("After Update");

  // Verify audit event.
  const auditResult = await db.query(`SELECT action FROM audit_events WHERE target_id = $1 AND action = 'student.update';`, [studentId]);
  expect(auditResult.rows.length).toBe(1);
});

test("PATCH /api/admin/students/:id returns 404 for other academy's student", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentIdB = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Other Academy');`, [studentIdB, ACADEMY_B_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentIdB}?academyId=` + ACADEMY_A_ID, {
    method: "PATCH",
    body: { fullName: "Hacked" },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: studentIdB }) });
  expect(res.status).toBe(404);

  // Verify the student was NOT updated.
  const dbResult = await db.query(`SELECT full_name FROM students WHERE id = $1;`, [studentIdB]);
  expect((dbResult.rows[0] as { full_name: string }).full_name).toBe("Other Academy");
});

test("PATCH /api/admin/students/:id rejects without CSRF (403)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'No CSRF Test');`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentId}?academyId=` + ACADEMY_A_ID, {
    method: "PATCH",
    body: { fullName: "Should Not Update" },
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(403);
});

test("PATCH /api/admin/students/:id rejects empty update (422)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Empty Update Test');`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentId}?academyId=` + ACADEMY_A_ID, {
    method: "PATCH",
    body: {},
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(422);
});

test("PATCH /api/admin/students/:id can archive (archivedAt=true)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Archive Test');`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentId}?academyId=` + ACADEMY_A_ID, {
    method: "PATCH",
    body: { archivedAt: true },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { archivedAt: string | null };
  expect(json.archivedAt).not.toBeNull();
});

// === F1: Archive state preservation =======================================

test("F1: double-archive returns 409 and preserves original timestamp", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Double Archive');`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const baseUrl = `/api/admin/students/${studentId}?academyId=${ACADEMY_A_ID}`;

  // First archive succeeds.
  const res1 = await PATCH(await makeRequest(baseUrl, {
    method: "PATCH", body: { archivedAt: true },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res1.status).toBe(200);
  const json1 = (await res1.json()) as { archivedAt: string | null };
  expect(json1.archivedAt).not.toBeNull();
  const originalTs = json1.archivedAt!;

  // Second archive returns 409.
  const res2 = await PATCH(await makeRequest(baseUrl, {
    method: "PATCH", body: { archivedAt: true },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res2.status).toBe(409);

  // Verify original timestamp is unchanged.
  const dbResult = await db.query<{ archived_at: Date }>(`SELECT archived_at FROM students WHERE id = $1;`, [studentId]);
  expect((dbResult.rows[0] as { archived_at: Date }).archived_at.toISOString()).toBe(originalTs);

  // Verify no audit event for the rejected second archive.
  const auditResult = await db.query(`SELECT COUNT(*)::int AS c FROM audit_events WHERE target_id = $1 AND action = 'student.update';`, [studentId]);
  expect((auditResult.rows[0] as { c: number }).c).toBe(1); // only the first archive
});

test("F1: unarchive clears archived_at, double-unarchive returns 409", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, archived_at) VALUES ($1, $2, 'Unarchive Test', now());`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const baseUrl = `/api/admin/students/${studentId}?academyId=${ACADEMY_A_ID}`;

  // Unarchive succeeds.
  const res1 = await PATCH(await makeRequest(baseUrl, {
    method: "PATCH", body: { archivedAt: false },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res1.status).toBe(200);
  expect(((await res1.json()) as { archivedAt: string | null }).archivedAt).toBeNull();

  // Double-unarchive returns 409.
  const res2 = await PATCH(await makeRequest(baseUrl, {
    method: "PATCH", body: { archivedAt: false },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res2.status).toBe(409);
});

// === F2/F6: Date-of-birth roundtrip ======================================

test("F2: POST with dateOfBirth returns the same date in response", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { fullName: "Date Test", dateOfBirth: "2015-03-15" },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { dateOfBirth: string | null };
  expect(json.dateOfBirth).toBe("2015-03-15");
});

test("F2: GET/:id returns the same dateOfBirth", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth) VALUES ($1, $2, 'Date Get Test', '2015-03-15');`, [studentId, ACADEMY_A_ID]);

  const { GET } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentId}?academyId=${ACADEMY_A_ID}`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { dateOfBirth: string | null };
  expect(json.dateOfBirth).toBe("2015-03-15");
});

test("F2: PATCH dateOfBirth returns the updated date", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth) VALUES ($1, $2, 'Patch Date', '2010-01-01');`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/${studentId}?academyId=${ACADEMY_A_ID}`, {
    method: "PATCH", body: { dateOfBirth: "2015-03-15" },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { dateOfBirth: string | null }).dateOfBirth).toBe("2015-03-15");
});

// === F3: Audit rollback ==================================================

test("F3: failed transaction does not leave orphaned audit event", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);

  // Insert a student directly, then attempt to update with an invalid gender
  // that bypasses Zod but fails at DB CHECK level. We call the domain service
  // directly to bypass the route handler's Zod validation.
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Audit Rollback Test');`, [studentId, ACADEMY_A_ID]);

  const { updateStudent } = await import("@/lib/domain/students");
  const { AppError } = await import("@/lib/errors");

  // Build a principal from the admin user.
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const sessionReq = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const extracted = await extractPrincipal(sessionReq, db);
  const principal = extracted!.principal;

  // Attempt to update with an invalid gender value (bypassing Zod).
  try {
    await updateStudent(principal, ACADEMY_A_ID, studentId, {
      gender: "invalid_gender" as "male",
    }, db);
    expect.fail("should have thrown");
  } catch (err) {
    // The DB CHECK constraint should reject this.
    expect(err).toBeInstanceOf(AppError);
  }

  // Verify the student's full_name is unchanged (mutation rolled back).
  const dbResult = await db.query<{ full_name: string }>(`SELECT full_name FROM students WHERE id = $1;`, [studentId]);
  expect((dbResult.rows[0] as { full_name: string }).full_name).toBe("Audit Rollback Test");

  // Verify NO audit event was written for the failed mutation.
  const auditResult = await db.query(`SELECT COUNT(*)::int AS c FROM audit_events WHERE target_id = $1 AND action = 'student.update';`, [studentId]);
  expect((auditResult.rows[0] as { c: number }).c).toBe(0);
});

// === F4: Explicit null vs omitted ========================================

test("F4: PATCH {notes: null} clears notes, omitted leaves unchanged", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, notes) VALUES ($1, $2, 'Null Test', 'original notes');`, [studentId, ACADEMY_A_ID]);

  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const baseUrl = `/api/admin/students/${studentId}?academyId=${ACADEMY_A_ID}`;

  // PATCH with notes: null → clears the field.
  const res1 = await PATCH(await makeRequest(baseUrl, {
    method: "PATCH", body: { notes: null },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res1.status).toBe(200);
  expect(((await res1.json()) as { notes: string | null }).notes).toBeNull();

  // Verify DB shows null.
  const db1 = await db.query<{ notes: string | null }>(`SELECT notes FROM students WHERE id = $1;`, [studentId]);
  expect((db1.rows[0] as { notes: string | null }).notes).toBeNull();

  // PATCH with fullName only (notes omitted) → notes stays null.
  const res2 = await PATCH(await makeRequest(baseUrl, {
    method: "PATCH", body: { fullName: "Updated Name" },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res2.status).toBe(200);
  expect(((await res2.json()) as { notes: string | null }).notes).toBeNull();

  // Verify DB still shows null.
  const db2 = await db.query<{ notes: string | null }>(`SELECT notes FROM students WHERE id = $1;`, [studentId]);
  expect((db2.rows[0] as { notes: string | null }).notes).toBeNull();
});

// === F5: Archived listing + classId filter ================================

test("F5: archived students excluded by default, visible with includeArchived", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const activeId = randomUUID();
  const archivedId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Active Student');`, [activeId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name, archived_at) VALUES ($1, $2, 'Archived Student', now());`, [archivedId, ACADEMY_A_ID]);

  const { GET } = await import("@/app/api/admin/students/route");

  // Default: archived excluded.
  const req1 = await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res1 = await GET(req1);
  const json1 = (await res1.json()) as { students: { id: string }[] };
  expect(json1.students.some((s) => s.id === activeId)).toBe(true);
  expect(json1.students.some((s) => s.id === archivedId)).toBe(false);

  // includeArchived=true: both visible.
  const req2 = await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}&includeArchived=true`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res2 = await GET(req2);
  const json2 = (await res2.json()) as { students: { id: string }[] };
  expect(json2.students.some((s) => s.id === activeId)).toBe(true);
  expect(json2.students.some((s) => s.id === archivedId)).toBe(true);
});

test("F5: classId filter shows only students with active enrollment in that class", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  // Create two classes.
  const classA = randomUUID();
  const classB = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 10);`, [classA, ACADEMY_A_ID]);
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class B', 10);`, [classB, ACADEMY_A_ID]);

  // Create three students:
  // - studentInA: enrolled in class A (active)
  // - studentInB: enrolled in class B (active)
  // - studentNoEnroll: no enrollment
  const studentInA = randomUUID();
  const studentInB = randomUUID();
  const studentNoEnroll = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'In Class A');`, [studentInA, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'In Class B');`, [studentInB, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'No Enrollment');`, [studentNoEnroll, ACADEMY_A_ID]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, CURRENT_DATE);`, [randomUUID(), studentInA, classA]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, CURRENT_DATE);`, [randomUUID(), studentInB, classB]);

  const { GET } = await import("@/app/api/admin/students/route");

  // Filter by classA: only studentInA.
  const req1 = await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}&classId=${classA}`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res1 = await GET(req1);
  const json1 = (await res1.json()) as { students: { id: string }[] };
  expect(json1.students.some((s) => s.id === studentInA)).toBe(true);
  expect(json1.students.some((s) => s.id === studentInB)).toBe(false);
  expect(json1.students.some((s) => s.id === studentNoEnroll)).toBe(false);

  // Filter by classB: only studentInB.
  const req2 = await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}&classId=${classB}`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res2 = await GET(req2);
  const json2 = (await res2.json()) as { students: { id: string }[] };
  expect(json2.students.some((s) => s.id === studentInB)).toBe(true);
  expect(json2.students.some((s) => s.id === studentInA)).toBe(false);
});

// === F8: Malformed JSON, invalid UUID, missing academyId ==================

test("F8: POST with malformed JSON returns 422", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: "{invalid json",
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(422);
  const json = (await res.json()) as { error?: { code: string } };
  expect(json.error?.code).toBe("VALIDATION_FAILED");
});

test("F8: GET/:id with invalid UUID returns 422", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/not-a-uuid?academyId=${ACADEMY_A_ID}`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req, { params: Promise.resolve({ id: "not-a-uuid" }) });
  expect(res.status).toBe(422);
  const json = (await res.json()) as { error?: { code: string } };
  expect(json.error?.code).toBe("VALIDATION_FAILED");
});

test("F8: PATCH/:id with invalid UUID returns 422", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/students/[id]/route");
  const req = await makeRequest(`/api/admin/students/xyz?academyId=${ACADEMY_A_ID}`, {
    method: "PATCH", body: { fullName: "Test" },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: "xyz" }) });
  expect(res.status).toBe(422);
});

test("F8: POST without academyId returns 422", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/route");
  const req = await makeRequest(`/api/admin/students`, {
    method: "POST", body: { fullName: "No Academy" },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(422);
  const json = (await res.json()) as { error?: { code: string; message: string } };
  expect(json.error?.code).toBe("VALIDATION_FAILED");
  expect(json.error?.message).toContain("academyId");
});

test("F8: GET without academyId returns 422", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/route");
  const req = await makeRequest(`/api/admin/students`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  expect(res.status).toBe(422);
});

// === F3b: Audit INSERT failure rolls back the mutation ====================

test("F3b: audit INSERT failure after mutation success rolls back both", async () => {
  // Create an academy + student directly.
  const academyId = randomUUID();
  const studentId = randomUUID();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'Audit Test Academy', 'audit-test', 'Asia/Jakarta', true);`, [academyId]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Before Audit Fail');`, [studentId, academyId]);

  // Build a principal for writeAudit.
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const { writeAudit } = await import("@/lib/audit/writer");
  const { AppError } = await import("@/lib/errors");

  // Start a SERIALIZABLE transaction. Update the student (mutation succeeds),
  // then call writeAudit with a non-existent academy_id (FK violation →
  // audit INSERT fails). The entire transaction should roll back.
  try {
    await db.withTxSerializable(async (tx) => {
      // Mutation: update the student's name (succeeds).
      await tx.query(
        `UPDATE students SET full_name = 'After Audit Fail', updated_at = now() WHERE id = $1;`,
        [studentId],
      );
      // Audit INSERT with a non-existent academy_id → FK violation (23503).
      // This is a natural DB constraint, not a test-only hook.
      await writeAudit({
        tx,
        academyId: "00000000-0000-0000-0000-000000000099", // non-existent academy
        actorUserId: adminA.id,
        action: "student.update",
        targetType: "students",
        targetId: studentId,
        before: { fullName: "Before Audit Fail" },
        after: { fullName: "After Audit Fail" },
      });
    });
    expect.fail("should have thrown — audit INSERT FK violation");
  } catch (err) {
    // The error should be an AppError (writeAudit wraps it).
    expect(err).toBeInstanceOf(AppError);
  }

  // Verify the student mutation was ROLLED BACK (name unchanged).
  const studentResult = await db.query<{ full_name: string }>(
    `SELECT full_name FROM students WHERE id = $1;`,
    [studentId],
  );
  expect((studentResult.rows[0] as { full_name: string }).full_name).toBe("Before Audit Fail");

  // Verify NO audit event was written for this student.
  const auditResult = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE target_id = $1;`,
    [studentId],
  );
  expect((auditResult.rows[0] as { c: number }).c).toBe(0);
});
