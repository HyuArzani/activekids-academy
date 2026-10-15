/**
 * API integration tests: Package plans + student package purchase.
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
let classId: string;
let studentId: string;
let plan4Id: string;
let plan8Id: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 10);`, [classId, ACADEMY_A_ID]);
  studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  plan4Id = randomUUID();
  plan8Id = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [plan4Id, ACADEMY_A_ID]);
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Standard 8', 8);`, [plan8Id, ACADEMY_A_ID]);
  // Enroll student
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classId]);
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

// === Package plan CRUD ===================================================

test("POST plan creates (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/package-plans/route");
  const res = await POST(await makeRequest(`/api/admin/package-plans?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { name: "New Plan", sessionCount: 12 }, ...auth(s, c) }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { name: string; session_count: number };
  expect(json.name).toBe("New Plan");
  expect(json.session_count).toBe(12);
});

test("POST plan rejects invalid sessionCount (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/package-plans/route");
  const res = await POST(await makeRequest(`/api/admin/package-plans?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { name: "Bad", sessionCount: 0 }, ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("GET plans lists all (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/package-plans/route");
  const res = await GET(await makeRequest(`/api/admin/package-plans?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { plans: unknown[] }).plans.length).toBe(2);
});

test("PATCH plan updates (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/package-plans/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/package-plans/${plan4Id}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { name: "Updated" }, ...auth(s, c) }), { params: Promise.resolve({ id: plan4Id }) });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { name: string }).name).toBe("Updated");
});

test("POST plan rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/package-plans/route");
  const res = await POST(await makeRequest(`/api/admin/package-plans?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { name: "X", sessionCount: 4 }, ...auth(s, c) }));
  expect(res.status).toBe(403);
});

// === Package purchase ====================================================

test("POST purchase creates exactly N entitlements (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: plan8Id }, ...auth(s, c) }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { entitlementIds: string[]; unassignedCount: number };
  expect(json.entitlementIds.length).toBe(8);
  expect(json.unassignedCount).toBe(8);
  // Verify DB
  const dbCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = (SELECT id FROM student_packages WHERE student_id = $1 ORDER BY purchased_at DESC LIMIT 1);`, [studentId]);
  expect((dbCount.rows[0] as { c: number }).c).toBe(8);
});

test("POST purchase 4-session plan creates exactly 4", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: plan4Id }, ...auth(s, c) }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { entitlementIds: string[] }).entitlementIds.length).toBe(4);
});

test("POST purchase rejects student without enrollment (409)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Create student without enrollment
  const noEnrollId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'NoEnroll');`, [noEnrollId, ACADEMY_A_ID]);
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await POST(await makeRequest(`/api/admin/students/${noEnrollId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: plan4Id }, ...auth(s, c) }), { params: Promise.resolve({ id: noEnrollId }) });
  expect(res.status).toBe(409);
});

test("POST purchase rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: plan4Id }, ...auth(s, c) }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(403);
});

test("POST purchase rejects nonexistent plan (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: randomUUID() }, ...auth(s, c) }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(404);
});

test("POST purchase rejects without CSRF (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: plan4Id }, cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(403);
});

// === GET student package history =========================================

test("GET student packages lists history (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  // Create a package directly
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [randomUUID(), studentId, plan4Id, classId]);
  const { GET } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await GET(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { packages: { plan_name: string }[] };
  expect(json.packages.length).toBe(1);
  expect(json.packages[0]!.plan_name).toBe("Starter 4");
});

// === GET package details =================================================

test("GET package details returns entitlements (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Purchase via API
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const purchaseRes = await POST(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: plan4Id }, ...auth(s, c) }), { params: Promise.resolve({ id: studentId }) });
  const pkgId = ((await purchaseRes.json()) as { packageId: string }).packageId;
  // Get details
  const { GET } = await import("@/app/api/admin/packages/[id]/route");
  const res = await GET(await makeRequest(`/api/admin/packages/${pkgId}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: pkgId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { planName: string; sessionCount: number; entitlements: { sequence: number }[] };
  expect(json.planName).toBe("Starter 4");
  expect(json.sessionCount).toBe(4);
  expect(json.entitlements.length).toBe(4);
  expect(json.entitlements.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
});

// === Audit rollback ======================================================

test("audit rollback: failed purchase leaves no audit", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const { purchasePackage } = await import("@/lib/domain/packages");
  const { AppError } = await import("@/lib/errors");
  const principal = (await extractPrincipal(await makeRequest("/api/auth/session", { cookies: { [sessionCookieName()]: s } }), db))!.principal;

  // Try to purchase with a plan from another academy
  const otherPlanId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Other', 4);`, [otherPlanId, ACADEMY_B_ID]);

  try {
    await purchasePackage(principal, ACADEMY_A_ID, { studentId, packagePlanId: otherPlanId }, db);
    expect.fail("should have thrown");
  } catch (err) { expect(err).toBeInstanceOf(AppError); }

  const audit = await db.query(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'package.purchase';`);
  expect((audit.rows[0] as { c: number }).c).toBe(0);
});

// === Unassigned entitlements are visible =================================

test("purchase creates unassigned entitlements visible and recoverable", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/packages/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/packages?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { packagePlanId: plan4Id }, ...auth(s, c) }), { params: Promise.resolve({ id: studentId }) });
  const pkgId = ((await res.json()) as { packageId: string }).packageId;

  // Verify all entitlements have NULL original/assigned occurrence (unassigned)
  const ents = await db.query<{ original_occurrence_id: string | null; assigned_occurrence_id: string | null; status: string }>(
    `SELECT original_occurrence_id, assigned_occurrence_id, status FROM session_entitlements WHERE student_package_id = $1 ORDER BY sequence;`, [pkgId]);
  for (const row of ents.rows as { original_occurrence_id: string | null; assigned_occurrence_id: string | null; status: string }[]) {
    expect(row.original_occurrence_id).toBeNull();
    expect(row.assigned_occurrence_id).toBeNull();
    expect(row.status).toBe("active");
  }
});
