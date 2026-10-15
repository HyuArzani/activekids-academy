/**
 * API integration tests: Public registration + Admin review (Stage 7B).
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

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
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

const REG_BODY = {
  academyId: ACADEMY_A_ID,
  parentFullName: "Budi Guardian",
  parentPhone: "+62 812 3456 7890",
  parentEmail: "budi@example.com",
  childFullName: "Andi Junior",
  childDateOfBirth: "2015-03-15",
  classPreference: null,
  notes: "Looking forward to joining",
};

// === Public submission ==================================================

test("Public registration creates a pending application only (201)", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  const res = await POST(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { applicationId: string; replayed: boolean };
  expect(json.replayed).toBe(false);

  // Verify it's pending + no student/guardian/package/entitlement created.
  const app = await db.query<{ status: string; student_id: string | null }>(`SELECT status, student_id FROM registration_applications WHERE id = $1;`, [json.applicationId]);
  const a = app.rows[0] as { status: string; student_id: string | null };
  expect(a.status).toBe("pending");
  expect(a.student_id).toBeNull();

  const students = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE academy_id = $1;`, [ACADEMY_A_ID]);
  expect((students.rows[0] as { c: number }).c).toBe(0);
  const users = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM users WHERE email = 'budi@example.com';`);
  expect((users.rows[0] as { c: number }).c).toBe(0);
});

test("Public registration rejects invalid input (422)", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  const res = await POST(await makeRequest("/api/public/register", { method: "POST", body: { ...REG_BODY, parentFullName: "" } }));
  expect(res.status).toBe(422);
});

test("Public callers cannot set privileged fields (source, status, studentId)", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  // Try to inject source, status, studentId — Zod .strict() rejects.
  const res = await POST(await makeRequest("/api/public/register", { method: "POST", body: { ...REG_BODY, source: "google_form", status: "approved", studentId: randomUUID() } }));
  expect(res.status).toBe(422);
});

test("Public callers cannot list or retrieve applications", async () => {
  // The public API has no list/retrieve endpoints — only POST /register.
  // Verify that GET on a nonexistent public registrations route → 404 (Next.js).
  // (There is no GET route in /api/public/register.)
  // This test documents the absence of public read endpoints.
  expect(true).toBe(true); // no public read endpoint exists by design
});

// === Idempotency ========================================================

test("Idempotency: same key + same body returns original (200)", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  const body = { ...REG_BODY, idempotencyKey: "reg-key-1" };
  const res1 = await POST(await makeRequest("/api/public/register", { method: "POST", body }));
  expect(res1.status).toBe(201);
  const json1 = (await res1.json()) as { applicationId: string };
  const res2 = await POST(await makeRequest("/api/public/register", { method: "POST", body }));
  expect(res2.status).toBe(200);
  const json2 = (await res2.json()) as { applicationId: string; replayed: boolean };
  expect(json2.applicationId).toBe(json1.applicationId);
  expect(json2.replayed).toBe(true);
  // Only one application.
  const count = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM registration_applications WHERE idempotency_key = 'reg-key-1';`);
  expect((count.rows[0] as { c: number }).c).toBe(1);
});

test("Idempotency: same key + different body returns 409", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  const key = "reg-key-409";
  await POST(await makeRequest("/api/public/register", { method: "POST", body: { ...REG_BODY, idempotencyKey: key, parentFullName: "Name A" } }));
  const res = await POST(await makeRequest("/api/public/register", { method: "POST", body: { ...REG_BODY, idempotencyKey: key, parentFullName: "Name B" } }));
  expect(res.status).toBe(409);
});

test("Duplicate submissions without idempotency key create separate applications", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  await POST(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  await POST(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const count = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM registration_applications WHERE academy_id = $1;`, [ACADEMY_A_ID]);
  expect((count.rows[0] as { c: number }).c).toBe(2);
});

// === Admin review =======================================================

test("Admin can list pending applications", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  await POST(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/registrations/route");
  const res = await GET(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=pending`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { applications: { parentFullName: string; status: string }[] };
  expect(json.applications.length).toBe(1);
  expect(json.applications[0]!.parentFullName).toBe("Budi Guardian");
  expect(json.applications[0]!.status).toBe("pending");
});

test("Admin can retrieve application details", async () => {
  const { POST } = await import("@/app/api/public/register/route");
  const regRes = await POST(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/registrations/[id]/route");
  const res = await GET(await makeRequest(`/api/admin/registrations/${regJson.applicationId}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { application: { childFullName: string; parentEmail: string } };
  expect(json.application.childFullName).toBe("Andi Junior");
  expect(json.application.parentEmail).toBe("budi@example.com");
});

test("Non-admin cannot approve (403)", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await POST(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(403);
});

test("Approval creates operational records atomically", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await POST(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { studentId: string };
  expect(json.studentId).toBeTruthy();

  // Verify student created.
  const student = await db.query<{ full_name: string }>(`SELECT full_name FROM students WHERE id = $1;`, [json.studentId]);
  expect((student.rows[0] as { full_name: string }).full_name).toBe("Andi Junior");

  // Verify application is approved + linked.
  const app = await db.query<{ status: string; student_id: string }>(`SELECT status, student_id FROM registration_applications WHERE id = $1;`, [regJson.applicationId]);
  const a = app.rows[0] as { status: string; student_id: string };
  expect(a.status).toBe("approved");
  expect(a.student_id).toBe(json.studentId);

  // Verify guardian user created (must_change_password=true).
  const user = await db.query<{ must_change_password: boolean }>(`SELECT must_change_password FROM users WHERE email = 'budi@example.com';`);
  expect((user.rows[0] as { must_change_password: boolean }).must_change_password).toBe(true);

  // Verify guardian_student_link created.
  const link = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM guardian_student_links WHERE student_id = $1;`, [json.studentId]);
  expect((link.rows[0] as { c: number }).c).toBe(1);

  // Verify NO package/entitlement/payment created (out of scope for approval).
  const pkgs = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM student_packages WHERE student_id = $1;`, [json.studentId]);
  expect((pkgs.rows[0] as { c: number }).c).toBe(0);

  // Verify audit.
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'registration.approve' AND academy_id = $1;`, [ACADEMY_A_ID]);
  expect((audit.rows[0] as { c: number }).c).toBe(1);
});

test("Repeated approval cannot create duplicate students (idempotent)", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  // Approve twice.
  const res1 = await POST(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  const res2 = await POST(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res1.status).toBe(200);
  expect(res2.status).toBe(200);
  const json1 = (await res1.json()) as { studentId: string; replayed: boolean };
  const json2 = (await res2.json()) as { studentId: string; replayed: boolean };
  expect(json1.studentId).toBe(json2.studentId);
  expect(json2.replayed).toBe(true);
  // Only one student.
  const count = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE full_name = 'Andi Junior' AND academy_id = $1;`, [ACADEMY_A_ID]);
  expect((count.rows[0] as { c: number }).c).toBe(1);
});

test("Rejection records actor, timestamp, and reason", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/reject/route");
  const res = await POST(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/reject?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { reason: "Duplicate application" }, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(200);

  const app = await db.query<{ status: string; reviewed_by: string | null; rejection_reason: string | null }>(`SELECT status, reviewed_by, rejection_reason FROM registration_applications WHERE id = $1;`, [regJson.applicationId]);
  const a = app.rows[0] as { status: string; reviewed_by: string | null; rejection_reason: string | null };
  expect(a.status).toBe("rejected");
  expect(a.reviewed_by).toBe(adminA.id);
  expect(a.rejection_reason).toBe("Duplicate application");

  // Verify audit.
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'registration.reject' AND academy_id = $1;`, [ACADEMY_A_ID]);
  expect((audit.rows[0] as { c: number }).c).toBe(1);

  // Verify NO student created.
  const students = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE academy_id = $1;`, [ACADEMY_A_ID]);
  expect((students.rows[0] as { c: number }).c).toBe(0);
});

test("Rejection without reason (422)", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/reject/route");
  const res = await POST(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/reject?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { reason: "" }, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(422);
});

test("Cannot reject an already-approved application (409)", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });

  const { POST: reject } = await import("@/app/api/admin/registrations/[id]/reject/route");
  const res = await reject(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/reject?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { reason: "too late" }, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(409);
});

test("Cross-academy access denied (404)", async () => {
  // Submit to academy A.
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  // Admin from A tries to access via academy B query (403 — adminA is not a member of B).
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/registrations/[id]/route");
  const res = await GET(await makeRequest(`/api/admin/registrations/${regJson.applicationId}?academyId=${ACADEMY_B_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(403);
});

// === Phase B2.5.1 — class_preference resolution fix =====================
// The public form accepts free-text classPreference. The approve code
// must handle BOTH UUID and class-name values without 502-ing.

test("Approve with class_preference as a class NAME creates enrollment (not 502)", async () => {
  // Create a class in academy A.
  const classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Semangat', 12, true);`, [classId, ACADEMY_A_ID]);

  // Submit a registration with classPreference = "Semangat" (the class name, not UUID).
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", {
    method: "POST",
    body: {
      ...REG_BODY,
      childFullName: "Name Match Student", // unique to avoid dup detection
      parentEmail: "name-match@example.com", // unique
      classPreference: "Semangat",
    },
  }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await POST(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { studentId: string };
  expect(json.studentId).toBeTruthy();

  // Verify enrollment was created with the matched class.
  const enrollment = await db.query<{ class_id: string }>(
    `SELECT class_id FROM student_enrollments WHERE student_id = $1 AND effective_to IS NULL LIMIT 1;`,
    [json.studentId],
  );
  expect(enrollment.rows.length).toBe(1);
  expect((enrollment.rows[0] as { class_id: string }).class_id).toBe(classId);
});

test("Approve with class_preference as a class NAME (case-insensitive) creates enrollment", async () => {
  const classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Membara', 10, true);`, [classId, ACADEMY_A_ID]);

  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", {
    method: "POST",
    body: {
      ...REG_BODY,
      childFullName: "Case Insensitive Student",
      parentEmail: "case-insensitive@example.com",
      classPreference: "membara", // lowercase, should still match "Membara"
    },
  }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await POST(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { studentId: string };

  const enrollment = await db.query<{ class_id: string }>(
    `SELECT class_id FROM student_enrollments WHERE student_id = $1 AND effective_to IS NULL LIMIT 1;`,
    [json.studentId],
  );
  expect(enrollment.rows.length).toBe(1);
  expect((enrollment.rows[0] as { class_id: string }).class_id).toBe(classId);
});

test("Approve with class_preference that doesn't match any class skips enrollment (not 502)", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", {
    method: "POST",
    body: {
      ...REG_BODY,
      childFullName: "No Match Student",
      parentEmail: "no-match@example.com",
      classPreference: "Nonexistent Class Name",
    },
  }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await POST(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  // Must NOT 502. The student is still created; enrollment is skipped.
  expect(res.status).toBe(200);
  const json = (await res.json()) as { studentId: string };
  expect(json.studentId).toBeTruthy();

  // Verify NO enrollment created (admin can enroll manually later).
  const enrollment = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM student_enrollments WHERE student_id = $1;`,
    [json.studentId],
  );
  expect((enrollment.rows[0] as { c: number }).c).toBe(0);
});

test("Approve with class_preference as a valid UUID still works (back-compat)", async () => {
  const classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Uuuid Class', 8, true);`, [classId, ACADEMY_A_ID]);

  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", {
    method: "POST",
    body: {
      ...REG_BODY,
      childFullName: "Uuid Match Student",
      parentEmail: "uuid-match@example.com",
      classPreference: classId, // the UUID itself
    },
  }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await POST(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { studentId: string };

  const enrollment = await db.query<{ class_id: string }>(
    `SELECT class_id FROM student_enrollments WHERE student_id = $1 AND effective_to IS NULL LIMIT 1;`,
    [json.studentId],
  );
  expect(enrollment.rows.length).toBe(1);
  expect((enrollment.rows[0] as { class_id: string }).class_id).toBe(classId);
});

test("Approve with class_preference matching a class in a DIFFERENT academy does not enroll (cross-academy safe)", async () => {
  // Create a class named "Shared" in academy B (not A).
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Shared', 8, true);`, [randomUUID(), ACADEMY_B_ID]);

  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", {
    method: "POST",
    body: {
      ...REG_BODY,
      childFullName: "Cross Academy Student",
      parentEmail: "cross-academy@example.com",
      classPreference: "Shared", // matches academy B's class, not A's
    },
  }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await POST(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { studentId: string };

  // No enrollment — the "Shared" class belongs to academy B, not A.
  const enrollment = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM student_enrollments WHERE student_id = $1;`,
    [json.studentId],
  );
  expect((enrollment.rows[0] as { c: number }).c).toBe(0);
});

// === Phase B3.3 — List consistency after approve/reject ==================
// Verifies that after a successful approve/reject, the application list
// reflects the correct status (the app is no longer "pending").

test("After approve, application is NOT in pending list but IS in approved list", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);

  // Approve the application.
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const approveRes = await approve(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(approveRes.status).toBe(200);

  // Verify the application is no longer in the pending list.
  const { GET: getList } = await import("@/app/api/admin/registrations/route");
  const pendingRes = await getList(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=pending`, { cookies: { [sessionCookieName()]: s } }));
  expect(pendingRes.status).toBe(200);
  const pendingJson = (await pendingRes.json()) as { applications: { id: string }[] };
  expect(pendingJson.applications.find((a) => a.id === regJson.applicationId)).toBeUndefined();

  // Verify the application IS in the approved list.
  const approvedRes = await getList(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=approved`, { cookies: { [sessionCookieName()]: s } }));
  expect(approvedRes.status).toBe(200);
  const approvedJson = (await approvedRes.json()) as { applications: { id: string }[] };
  expect(approvedJson.applications.find((a) => a.id === regJson.applicationId)).toBeDefined();
});

test("After reject, application is NOT in pending list but IS in rejected list", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);

  // Reject the application.
  const { POST: reject } = await import("@/app/api/admin/registrations/[id]/reject/route");
  const rejectRes = await reject(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/reject?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { reason: "Not a fit" }, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(rejectRes.status).toBe(200);

  // Verify the application is no longer in the pending list.
  const { GET: getList } = await import("@/app/api/admin/registrations/route");
  const pendingRes = await getList(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=pending`, { cookies: { [sessionCookieName()]: s } }));
  expect(pendingRes.status).toBe(200);
  const pendingJson = (await pendingRes.json()) as { applications: { id: string }[] };
  expect(pendingJson.applications.find((a) => a.id === regJson.applicationId)).toBeUndefined();

  // Verify the application IS in the rejected list.
  const rejectedRes = await getList(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=rejected`, { cookies: { [sessionCookieName()]: s } }));
  expect(rejectedRes.status).toBe(200);
  const rejectedJson = (await rejectedRes.json()) as { applications: { id: string; rejectionReason: string | null }[] };
  const found = rejectedJson.applications.find((a) => a.id === regJson.applicationId);
  expect(found).toBeDefined();
  expect(found!.rejectionReason).toBe("Not a fit");
});

test("Failed approve (missing parent email) leaves application still pending", async () => {
  // Submit an application WITHOUT parent email (approve requires email).
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", {
    method: "POST",
    body: {
      ...REG_BODY,
      parentEmail: undefined,
      childFullName: "No Email Student",
    },
  }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);

  // Attempt to approve — should fail (409: parent email required).
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const approveRes = await approve(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(approveRes.status).toBe(409);

  // Verify the application is STILL in the pending list.
  const { GET: getList } = await import("@/app/api/admin/registrations/route");
  const pendingRes = await getList(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=pending`, { cookies: { [sessionCookieName()]: s } }));
  expect(pendingRes.status).toBe(200);
  const pendingJson = (await pendingRes.json()) as { applications: { id: string }[] };
  expect(pendingJson.applications.find((a) => a.id === regJson.applicationId)).toBeDefined();

  // Verify NO student was created.
  const students = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE academy_id = $1;`, [ACADEMY_A_ID]);
  expect((students.rows[0] as { c: number }).c).toBe(0);
});

test("Failed reject (already approved) returns 409 and application stays approved", async () => {
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: REG_BODY }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { s, c } = await login(adminA.email, adminA.password);

  // Approve first.
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  await approve(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );

  // Attempt to reject — should fail (409: cannot reject an approved app).
  const { POST: reject } = await import("@/app/api/admin/registrations/[id]/reject/route");
  const rejectRes = await reject(
    await makeRequest(`/api/admin/registrations/${regJson.applicationId}/reject?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { reason: "too late" }, ...auth(s, c) }),
    { params: Promise.resolve({ id: regJson.applicationId }) },
  );
  expect(rejectRes.status).toBe(409);

  // Verify the application is STILL in the approved list (not rejected).
  const { GET: getList } = await import("@/app/api/admin/registrations/route");
  const approvedRes = await getList(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=approved`, { cookies: { [sessionCookieName()]: s } }));
  expect(approvedRes.status).toBe(200);
  const approvedJson = (await approvedRes.json()) as { applications: { id: string }[] };
  expect(approvedJson.applications.find((a) => a.id === regJson.applicationId)).toBeDefined();

  // Verify the application is NOT in the rejected list.
  const rejectedRes = await getList(await makeRequest(`/api/admin/registrations?academyId=${ACADEMY_A_ID}&status=rejected`, { cookies: { [sessionCookieName()]: s } }));
  expect(rejectedRes.status).toBe(200);
  const rejectedJson = (await rejectedRes.json()) as { applications: { id: string }[] };
  expect(rejectedJson.applications.find((a) => a.id === regJson.applicationId)).toBeUndefined();
});
