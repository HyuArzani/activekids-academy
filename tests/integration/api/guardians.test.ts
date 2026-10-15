/**
 * API integration tests: Guardian link endpoints.
 *
 * Tests the actual route handlers by importing the exported functions
 * and calling them with real NextRequest objects against in-memory PgLite.
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
let studentIdA: string;
let studentIdB: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);

  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  studentIdA = randomUUID();
  studentIdB = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentIdA, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`, [studentIdB, ACADEMY_B_ID]);
});

afterEach(async () => {
  await teardownTestDb();
});

async function loginAndGetCookies(email: string, password: string): Promise<{ sessionToken: string; csrfToken: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", { method: "POST", body: { email, password } });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const sessionMatch = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie);
  const csrfMatch = new RegExp(`${csrfCookieName()}=([^;]+)`).exec(setCookie);
  return { sessionToken: sessionMatch![1]!, csrfToken: csrfMatch![1]! };
}

// === POST: Create guardian link ===========================================

test("POST creates guardian link (201)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: parentA.id, isPrimary: true, relationship: "mother" },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { guardianUserId: string; isPrimary: boolean };
  expect(json.guardianUserId).toBe(parentA.id);
  expect(json.isPrimary).toBe(true);

  // Verify audit event
  const audit = await db.query(`SELECT action FROM audit_events WHERE action = 'guardian_link.create';`);
  expect(audit.rows.length).toBe(1);
});

test("POST rejects duplicate link (409)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  // Pre-create the link
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, false);`, [randomUUID(), parentA.id, studentIdA]);

  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: parentA.id },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(409);
});

test("POST rejects non-parent guardian (403)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  // Try to link coachA as guardian — coach doesn't have parent role
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: coachA.id },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(403);
});

test("POST rejects nonexistent guardian user (403)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: randomUUID() },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(403);
});

test("POST rejects coach as admin (403)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: parentA.id },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(403);
});

test("POST rejects without session (401)", async () => {
  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: parentA.id },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(401);
});

test("POST rejects without CSRF (403)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: parentA.id },
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(403);
});

test("POST rejects cross-academy student (404)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  // studentIdB is in Academy B, adminA is in Academy A
  const req = await makeRequest(`/api/admin/students/${studentIdB}/guardians?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: { guardianUserId: parentA.id },
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req, { params: Promise.resolve({ id: studentIdB }) });
  expect(res.status).toBe(404);
});

test("POST allows multiple guardians for same student", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  // Create a second parent
  const parent2 = await createTestUser(db, { email: "parent2@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  const { POST } = await import("@/app/api/admin/students/[id]/guardians/route");
  const baseUrl = `/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`;
  const cookies = { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken };
  const headers = { [CSRF_HEADER]: csrfToken };

  const res1 = await POST(await makeRequest(baseUrl, { method: "POST", body: { guardianUserId: parentA.id }, cookies, headers }), { params: Promise.resolve({ id: studentIdA }) });
  expect(res1.status).toBe(201);

  const res2 = await POST(await makeRequest(baseUrl, { method: "POST", body: { guardianUserId: parent2.id }, cookies, headers }), { params: Promise.resolve({ id: studentIdA }) });
  expect(res2.status).toBe(201);
});

// === GET: List guardian links =============================================

test("GET lists guardian links with display fields (200)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  // Set a full_name on the parent user so we can verify it's returned.
  await db.query(`UPDATE users SET full_name = 'Parent A Name' WHERE id = $1;`, [parentA.id]);
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship) VALUES ($1, $2, $3, true, 'father');`, [randomUUID(), parentA.id, studentIdA]);

  const { GET } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians?academyId=${ACADEMY_A_ID}`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    guardians: {
      guardian_user_id: string;
      is_primary: boolean;
      relationship: string | null;
      guardian_email: string | null;
      guardian_full_name: string | null;
    }[];
  };
  expect(json.guardians.length).toBe(1);
  const g = json.guardians[0]!;
  expect(g.guardian_user_id).toBe(parentA.id);
  expect(g.is_primary).toBe(true);
  expect(g.relationship).toBe("father");
  // Phase B5.1: display fields (email + full_name) are now returned.
  expect(g.guardian_email).toBe("parent-a@example.com");
  expect(g.guardian_full_name).toBe("Parent A Name");
});

test("GET returns 404 for cross-academy student", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/route");
  const req = await makeRequest(`/api/admin/students/${studentIdB}/guardians?academyId=${ACADEMY_A_ID}`, {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req, { params: Promise.resolve({ id: studentIdB }) });
  expect(res.status).toBe(404);
});

// === DELETE: Remove guardian link =========================================

test("DELETE removes guardian link (200)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const linkId = randomUUID();
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, false);`, [linkId, parentA.id, studentIdA]);

  const { DELETE } = await import("@/app/api/admin/students/[id]/guardians/[linkId]/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians/${linkId}?academyId=${ACADEMY_A_ID}`, {
    method: "DELETE",
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await DELETE(req, { params: Promise.resolve({ id: studentIdA, linkId }) });
  expect(res.status).toBe(200);

  // Verify deleted
  const result = await db.query(`SELECT id FROM guardian_student_links WHERE id = $1;`, [linkId]);
  expect(result.rows.length).toBe(0);

  // Verify audit event
  const audit = await db.query(`SELECT action FROM audit_events WHERE action = 'guardian_link.remove';`);
  expect(audit.rows.length).toBe(1);
});

test("DELETE returns 404 for nonexistent link", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { DELETE } = await import("@/app/api/admin/students/[id]/guardians/[linkId]/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians/${randomUUID()}?academyId=${ACADEMY_A_ID}`, {
    method: "DELETE",
    cookies: { [sessionCookieName()]: sessionToken, [csrfCookieName()]: csrfToken },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await DELETE(req, { params: Promise.resolve({ id: studentIdA, linkId: randomUUID() }) });
  expect(res.status).toBe(404);
});

test("DELETE rejects without CSRF (403)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const linkId = randomUUID();
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, false);`, [linkId, parentA.id, studentIdA]);

  const { DELETE } = await import("@/app/api/admin/students/[id]/guardians/[linkId]/route");
  const req = await makeRequest(`/api/admin/students/${studentIdA}/guardians/${linkId}?academyId=${ACADEMY_A_ID}`, {
    method: "DELETE",
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await DELETE(req, { params: Promise.resolve({ id: studentIdA, linkId }) });
  expect(res.status).toBe(403);
});

// === Audit rollback =======================================================

test("audit rollback: failed guardian link creation leaves no audit", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const { createGuardianLink } = await import("@/lib/domain/guardians");
  const { AppError } = await import("@/lib/errors");

  const sessionReq = await makeRequest("/api/auth/session", { cookies: { [sessionCookieName()]: sessionToken } });
  const extracted = await extractPrincipal(sessionReq, db);
  const principal = extracted!.principal;

  // Try to link a guardian to a non-existent student (will fail at loadStudentInAcademy)
  try {
    await createGuardianLink(principal, ACADEMY_A_ID, randomUUID(), { guardianUserId: parentA.id }, db);
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
  }

  // Verify no audit event was created
  const audit = await db.query(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'guardian_link.create';`);
  expect((audit.rows[0] as { c: number }).c).toBe(0);
});

// === Phase B5.1: Eligible-guardian search =================================
// GET /api/admin/students/:id/guardians/eligible?q=<query>
//
// Tests verify: search returns parent-role users; cross-academy
// exclusion; duplicate-link marking; empty results; short-query
// rejection; non-parent exclusion; invalid student UUID; auth.

/** Set a full_name on an existing user (by id). */
async function setName(userId: string, fullName: string): Promise<void> {
  await db.query(`UPDATE users SET full_name = $1 WHERE id = $2;`, [fullName, userId]);
}

/** Create a NEW parent user with a full_name in the given academy. Use
 * a unique email (not the beforeEach parentA email). */
async function createNamedParent(
  academyId: string,
  email: string,
  fullName: string,
): Promise<TestUser> {
  const parent = await createTestUser(db, { email, password: "password123", role: "parent", academyId });
  await setName(parent.id, fullName);
  return parent;
}

test("eligible search: returns matching parent by name", async () => {
  // Set a name on parentA (created in beforeEach) so it's searchable.
  await setName(parentA.id, "Alice Andini");
  // Create a second named parent to verify scoping.
  const parentB = await createNamedParent(ACADEMY_A_ID, "parent-b@example.com", "Budi Bima");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Alice`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    eligible: { id: string; email: string; fullName: string | null; isAlreadyLinked: boolean }[];
  };
  // Alice matches; Budi does not.
  expect(json.eligible.length).toBe(1);
  expect(json.eligible[0]!.email).toBe("parent-a@example.com");
  expect(json.eligible[0]!.fullName).toBe("Alice Andini");
  expect(json.eligible[0]!.isAlreadyLinked).toBe(false);
  // Verify Budi is NOT in the results (search is scoped to the query).
  expect(json.eligible.find((e) => e.email === "parent-b@example.com")).toBeUndefined();
  void parentB;
});

test("eligible search: returns matching parent by email", async () => {
  await setName(parentA.id, "Alice Andini");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=parent-a@`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: { email: string }[] };
  expect(json.eligible.length).toBe(1);
  expect(json.eligible[0]!.email).toBe("parent-a@example.com");
});

test("eligible search: case-insensitive partial match", async () => {
  await setName(parentA.id, "Alice Andini");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  // lowercase search for an uppercase name
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=alice`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: { email: string }[] };
  expect(json.eligible.length).toBe(1);
  expect(json.eligible[0]!.email).toBe("parent-a@example.com");
});

test("eligible search: excludes cross-academy parents", async () => {
  // Alice in academy A; Charlie in academy B.
  await setName(parentA.id, "Alice Andini");
  const charlieB = await createNamedParent(ACADEMY_B_ID, "charlie-b@example.com", "Charlie Cross");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  // Search for "charlie" in academy A — must NOT return academy B's parent.
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=charlie`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: { email: string }[] };
  expect(json.eligible.find((e) => e.email === "charlie-b@example.com")).toBeUndefined();
  void charlieB;
});

test("eligible search: marks already-linked guardians", async () => {
  await setName(parentA.id, "Alice Andini");
  // Pre-create the link so parentA is already linked to studentIdA.
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, false);`, [randomUUID(), parentA.id, studentIdA]);

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Alice`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: { email: string; isAlreadyLinked: boolean }[] };
  expect(json.eligible.length).toBe(1);
  expect(json.eligible[0]!.email).toBe("parent-a@example.com");
  expect(json.eligible[0]!.isAlreadyLinked).toBe(true);
});

test("eligible search: excludes non-parent roles (coaches/admins)", async () => {
  // Give the coach + admin names that would match "Andini" if the search
  // didn't filter by role.
  await setName(coachA.id, "Coach Andini");
  await setName(adminA.id, "Admin Andini");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Andini`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: { email: string }[] };
  // Neither coachA nor adminA should appear — they're not parents.
  expect(json.eligible.find((e) => e.email === "coach-a@example.com")).toBeUndefined();
  expect(json.eligible.find((e) => e.email === "admin-a@example.com")).toBeUndefined();
});

test("eligible search: empty query returns empty list (no load-all)", async () => {
  await setName(parentA.id, "Alice Andini");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: unknown[] };
  expect(json.eligible.length).toBe(0);
});

test("eligible search: single-character query returns 422", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=A`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(422);
});

test("eligible search: no matches returns empty list (200)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=zzzznonexistent`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: unknown[] };
  expect(json.eligible.length).toBe(0);
});

test("eligible search: rejects non-UUID student ID (422)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/not-a-uuid/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Alice`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: "not-a-uuid" }) });
  expect(res.status).toBe(422);
});

test("eligible search: rejects cross-academy student (404)", async () => {
  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  // studentIdB is in Academy B; adminA is in Academy A → 404.
  const req = await makeRequest(
    `/api/admin/students/${studentIdB}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Alice`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdB }) });
  expect(res.status).toBe(404);
});

test("eligible search: rejects unauthenticated (401)", async () => {
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Alice`,
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(401);
});

test("eligible search: rejects coach (403)", async () => {
  const { sessionToken } = await loginAndGetCookies(coachA.email, coachA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Alice`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(403);
});

test("eligible search: ILIKE wildcards in query are treated as literals", async () => {
  // parentA has email "parent-a@example.com" and name "Alice Andini".
  // Search for "a%" (2 chars — passes the min-length check). If the `%`
  // is treated as an ILIKE wildcard, the pattern becomes "%a%%" which
  // matches anything containing "a" → returns parentA. If the `%` is
  // correctly escaped to a literal, the pattern becomes "%a\%%" which
  // matches only strings containing a literal "a%" → 0 results.
  await setName(parentA.id, "Alice Andini");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=${encodeURIComponent("a%")}`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: unknown[] };
  // A literal "a%" should match NO user (no email/name contains a literal
  // "a%"), confirming the wildcard was escaped, not treated as "match all".
  expect(json.eligible.length).toBe(0);
});

test("eligible search: does not return password hashes or credentials", async () => {
  await setName(parentA.id, "Alice Andini");

  const { sessionToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/[id]/guardians/eligible/route");
  const req = await makeRequest(
    `/api/admin/students/${studentIdA}/guardians/eligible?academyId=${ACADEMY_A_ID}&q=Alice`,
    { cookies: { [sessionCookieName()]: sessionToken } },
  );
  const res = await GET(req, { params: Promise.resolve({ id: studentIdA }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { eligible: Record<string, unknown>[] };
  expect(json.eligible.length).toBe(1);
  const row = json.eligible[0]!;
  // Verify only the 4 allowed fields are present — no hash/token/secret leakage.
  const allowedKeys = new Set(["id", "email", "fullName", "isAlreadyLinked"]);
  for (const key of Object.keys(row)) {
    expect(allowedKeys.has(key)).toBe(true);
  }
  expect(row).not.toHaveProperty("argon2id_hash");
  expect(row).not.toHaveProperty("argon2_params");
  expect(row).not.toHaveProperty("token_hash");
  expect(row).not.toHaveProperty("must_change_password");
});
