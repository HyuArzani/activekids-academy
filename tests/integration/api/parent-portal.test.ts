/**
 * API integration tests: Parent Portal (Stage 8).
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
let parentA: TestUser;
let parentB: TestUser;
let studentA1: string;
let studentA2: string;
let studentB1: string;
let classId: string;
let versionId: string;
let slotId: string;
let planId: string;
let occId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
  parentB = await createTestUser(db, { email: "parent-b@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);

  // Two children for parentA, one for parentB.
  studentA1 = randomUUID();
  studentA2 = randomUUID();
  studentB1 = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Child A1');`, [studentA1, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Child A2');`, [studentA2, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Child B1');`, [studentB1, ACADEMY_A_ID]);

  // Guardian links.
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), parentA.id, studentA1]);
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, false);`, [randomUUID(), parentA.id, studentA2]);
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), parentB.id, studentB1]);

  // Enrollments.
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentA1, classId]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentA2, classId]);

  // Schedule + occurrence.
  versionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, classId]);
  slotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotId, versionId]);

  // A future occurrence.
  occId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occId, ACADEMY_A_ID, classId, slotId, versionId]);

  // Package + entitlements for studentA1.
  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [planId, ACADEMY_A_ID]);
  const pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkgId, studentA1, planId, classId]);
  for (let i = 0; i < 4; i++) {
    await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, $3, 'active', $4, $4);`, [randomUUID(), pkgId, i + 1, occId]);
  }

  // Attendance record for studentA1.
  await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by) VALUES ($1, $2, $3, 'present', $4);`, [randomUUID(), occId, studentA1, adminA.id]);

  // Semester + published report for studentA1.
  const semId = randomUUID();
  await db.query(`INSERT INTO semesters (id, academy_id, name, start_date, end_date) VALUES ($1, $2, 'Sem 1', '2027-01-01', '2027-06-30');`, [semId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO student_reports (id, student_id, semester_id, author_user_id, body, published_at) VALUES ($1, $2, $3, $4, 'Good progress', now());`, [randomUUID(), studentA1, semId, adminA.id]);
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
function noAuth(s: string) { return { cookies: { [sessionCookieName()]: s } }; }

// === Dashboard summary ===================================================

test("Parent dashboard summary returns children + sessions + packages + reports (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/parent/dashboard/summary?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { childrenCount: number; children: { fullName: string }[]; upcomingSessions: unknown[]; activePackages: { packageName: string }[]; availableReports: { semesterName: string }[] };
  expect(json.childrenCount).toBe(2);
  expect(json.children.some((c) => c.fullName === "Child A1")).toBe(true);
  expect(json.children.some((c) => c.fullName === "Child A2")).toBe(true);
  expect(json.activePackages.length).toBe(1);
  expect(json.activePackages[0]!.packageName).toBe("Starter 4");
  expect(json.availableReports.length).toBe(1);
  expect(json.availableReports[0]!.semesterName).toBe("Sem 1");
});

test("Parent dashboard rejects unauthenticated (401)", async () => {
  const { GET } = await import("@/app/api/parent/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/parent/dashboard/summary?academyId=${ACADEMY_A_ID}`, {}));
  expect(res.status).toBe(401);
});

test("Parent dashboard rejects admin (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/parent/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/parent/dashboard/summary?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(403);
});

test("Parent dashboard with no children returns empty (200)", async () => {
  // parentB has child B1 but B1 is linked to parentB. Create a new parent with no links.
  const newParent = await createTestUser(db, { email: "no-children@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
  const { s } = await login(newParent.email, newParent.password);
  const { GET } = await import("@/app/api/parent/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/parent/dashboard/summary?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { childrenCount: number };
  expect(json.childrenCount).toBe(0);
});

// === Children list ======================================================

test("Parent children list returns own children (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/route");
  const res = await GET(await makeRequest(`/api/parent/children?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { children: { studentId: string; fullName: string }[] };
  expect(json.children.length).toBe(2);
  expect(json.children.some((c) => c.fullName === "Child A1")).toBe(true);
  // Should NOT include parentB's child.
  expect(json.children.some((c) => c.fullName === "Child B1")).toBe(false);
});

test("Parent children list: parentB sees only own child (200)", async () => {
  const { s } = await login(parentB.email, parentB.password);
  const { GET } = await import("@/app/api/parent/children/route");
  const res = await GET(await makeRequest(`/api/parent/children?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { children: { fullName: string }[] };
  expect(json.children.length).toBe(1);
  expect(json.children[0]!.fullName).toBe("Child B1");
});

// === Child schedule ======================================================

test("Parent child schedule returns entitlements (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { status: string; className: string }[] };
  expect(json.schedule.length).toBe(4);
  expect(json.schedule[0]!.className).toBe("Class A");
});

test("Parent cannot access another parent's child schedule (404)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  // parentA tries to access parentB's child.
  const res = await GET(await makeRequest(`/api/parent/children/${studentB1}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentB1 }) });
  expect(res.status).toBe(404);
});

test("Child schedule rejects unauthenticated (401)", async () => {
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/schedule?academyId=${ACADEMY_A_ID}`, {}), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(401);
});

// === Child packages =====================================================

test("Parent child packages returns packages + entitlements (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/packages/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/packages?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { packages: { packageName: string; sessionCount: number; entitlements: { status: string }[] }[] };
  expect(json.packages.length).toBe(1);
  expect(json.packages[0]!.packageName).toBe("Starter 4");
  expect(json.packages[0]!.entitlements.length).toBe(4);
  expect(json.packages[0]!.entitlements.every((e) => e.status === "active")).toBe(true);
});

test("Parent cannot access another parent's child packages (404)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/packages/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentB1}/packages?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentB1 }) });
  expect(res.status).toBe(404);
});

// === Child attendance ===================================================

test("Parent child attendance returns records (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/attendance/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/attendance?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { attendance: { status: string; className: string }[] };
  expect(json.attendance.length).toBe(1);
  expect(json.attendance[0]!.status).toBe("present");
  expect(json.attendance[0]!.className).toBe("Class A");
});

test("Parent cannot access another parent's child attendance (404)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/attendance/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentB1}/attendance?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentB1 }) });
  expect(res.status).toBe(404);
});

// === Child reports ======================================================

test("Parent child reports returns published reports (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/reports/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/reports?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { reports: { semesterName: string; body: string }[] };
  expect(json.reports.length).toBe(1);
  expect(json.reports[0]!.semesterName).toBe("Sem 1");
  expect(json.reports[0]!.body).toBe("Good progress");
});

test("Parent child reports does NOT return unpublished (200, empty)", async () => {
  // Add an unpublished report.
  const semId = randomUUID();
  await db.query(`INSERT INTO semesters (id, academy_id, name, start_date, end_date) VALUES ($1, $2, 'Sem 2', '2027-07-01', '2027-12-31');`, [semId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO student_reports (id, student_id, semester_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'Draft report');`, [randomUUID(), studentA1, semId, adminA.id]);

  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/reports/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/reports?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { reports: { semesterName: string }[] };
  expect(json.reports.length).toBe(1); // only the published one
  expect(json.reports[0]!.semesterName).toBe("Sem 1"); // NOT "Sem 2"
});

test("Parent cannot access another parent's child reports (404)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/reports/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentB1}/reports?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentB1 }) });
  expect(res.status).toBe(404);
});

// === Cross-academy ======================================================

test("Cross-academy access denied (403)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  // parentA is a member of A only — requesting B is forbidden.
  const { GET } = await import("@/app/api/parent/children/route");
  const res = await GET(await makeRequest(`/api/parent/children?academyId=${ACADEMY_B_ID}`, noAuth(s)));
  expect(res.status).toBe(403);
});

// === Archived student exclusion =========================================

test("Archived student is excluded from children list", async () => {
  // Archive studentA2.
  await db.query(`UPDATE students SET archived_at = now() WHERE id = $1;`, [studentA2]);
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/route");
  const res = await GET(await makeRequest(`/api/parent/children?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  const json = (await res.json()) as { children: { fullName: string }[] };
  expect(json.children.length).toBe(1); // only A1 (A2 archived)
  expect(json.children[0]!.fullName).toBe("Child A1");
});

// === Multiple children access ===========================================

test("Parent with multiple children can access each child's data", async () => {
  const { s } = await login(parentA.email, parentA.password);
  // Access child A1 schedule.
  const { GET: getSched } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res1 = await getSched(await makeRequest(`/api/parent/children/${studentA1}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res1.status).toBe(200);

  // Access child A2 schedule (A2 has no packages but should still work).
  const res2 = await getSched(await makeRequest(`/api/parent/children/${studentA2}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA2 }) });
  expect(res2.status).toBe(200);
  const json2 = (await res2.json()) as { schedule: unknown[] };
  expect(json2.schedule.length).toBe(0); // A2 has no entitlements
});

// === Archived student historical read access (Stage 8.1 fix) ===========

test("Archived student: guardian can still access historical schedule (200)", async () => {
  // Create package + entitlement for studentA2 (already enrolled in classId).
  const pkg2 = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkg2, studentA2, planId, classId]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3);`, [randomUUID(), pkg2, occId]);

  // Now archive.
  await db.query(`UPDATE students SET archived_at = now() WHERE id = $1;`, [studentA2]);

  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA2}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA2 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { status: string }[] };
  expect(json.schedule.length).toBe(1);
});

test("Archived student: guardian can still access historical attendance (200)", async () => {
  await db.query(`UPDATE students SET archived_at = now() WHERE id = $1;`, [studentA1]);
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/attendance/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/attendance?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { attendance: { status: string }[] };
  expect(json.attendance.length).toBe(1);
  expect(json.attendance[0]!.status).toBe("present");
});

test("Archived student: guardian can still access historical packages (200)", async () => {
  await db.query(`UPDATE students SET archived_at = now() WHERE id = $1;`, [studentA1]);
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/packages/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/packages?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { packages: { packageName: string }[] };
  expect(json.packages.length).toBe(1);
  expect(json.packages[0]!.packageName).toBe("Starter 4");
});

test("Archived student: guardian can still access historical reports (200)", async () => {
  await db.query(`UPDATE students SET archived_at = now() WHERE id = $1;`, [studentA1]);
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/reports/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/reports?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { reports: { semesterName: string }[] };
  expect(json.reports.length).toBe(1);
});

test("Archived student: still excluded from children list + dashboard", async () => {
  await db.query(`UPDATE students SET archived_at = now() WHERE id = $1;`, [studentA2]);
  const { s } = await login(parentA.email, parentA.password);

  // Children list excludes archived.
  const { GET: getChildren } = await import("@/app/api/parent/children/route");
  const childrenRes = await getChildren(await makeRequest(`/api/parent/children?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  const childrenJson = (await childrenRes.json()) as { children: { fullName: string }[] };
  expect(childrenJson.children.length).toBe(1); // only A1 (A2 archived)
  expect(childrenJson.children[0]!.fullName).toBe("Child A1");

  // Dashboard excludes archived from childrenCount.
  const { GET: getSummary } = await import("@/app/api/parent/dashboard/summary/route");
  const dashRes = await getSummary(await makeRequest(`/api/parent/dashboard/summary?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  const dashJson = (await dashRes.json()) as { childrenCount: number };
  expect(dashJson.childrenCount).toBe(1);
});

// === Package/entitlement aggregation without double-counting ==========

test("Package count does not double-count with multiple entitlements", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/parent/dashboard/summary?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  const json = (await res.json()) as { activePackages: { packageName: string; sessionCount: number; activeEntitlements: number }[] };
  expect(json.activePackages.length).toBe(1); // exactly 1 package for A1
  expect(json.activePackages[0]!.activeEntitlements).toBe(4); // 4 active entitlements
  expect(json.activePackages[0]!.sessionCount).toBe(4); // session_count = 4
});

// === Invalid student IDs ================================================

test("Invalid studentId (non-UUID format) returns 422", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(`/api/parent/children/not-a-uuid/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: "not-a-uuid" }) });
  expect(res.status).toBe(422);
});

test("Random UUID (no guardian link) returns 404", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(`/api/parent/children/${randomUUID()}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: randomUUID() }) });
  expect(res.status).toBe(404);
});

// === Response field exposure ============================================

test("Dashboard response does not expose internal audit/auth fields", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/parent/dashboard/summary?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  const json = (await res.json()) as Record<string, unknown>;
  const jsonStr = JSON.stringify(json);
  // No sensitive fields.
  expect(jsonStr).not.toContain("password");
  expect(jsonStr).not.toContain("hash");
  expect(jsonStr).not.toContain("token");
  expect(jsonStr).not.toContain("email"); // parent email not exposed
  expect(jsonStr).not.toContain("reviewed_by");
  expect(jsonStr).not.toContain("audit");
  expect(jsonStr).not.toContain("session_token");
});

test("Attendance response does not expose recorded_by or internal IDs unnecessarily", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/attendance/route");
  const res = await GET(await makeRequest(`/api/parent/children/${studentA1}/attendance?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  const json = (await res.json()) as { attendance: Record<string, unknown>[] };
  const jsonStr = JSON.stringify(json);
  expect(jsonStr).not.toContain("recorded_by");
  expect(jsonStr).not.toContain("password");
  expect(jsonStr).not.toContain("hash");
  expect(jsonStr).not.toContain("token");
});

// === Video access isolation (existing route, regression) ===============

test("Parent video access: parent sees own child's videos, not another's", async () => {
  // Create a video for studentA1.
  await db.query(`INSERT INTO student_training_videos (id, student_id, uploaded_by, title, youtube_url, is_published) VALUES ($1, $2, $3, 'Training 1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', true);`, [randomUUID(), studentA1, adminA.id]);

  const { s: parentASession } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/students/[id]/videos/route");

  // parentA can see studentA1's videos.
  const res1 = await GET(await makeRequest(`/api/parent/students/${studentA1}/videos?academyId=${ACADEMY_A_ID}`, noAuth(parentASession)), { params: Promise.resolve({ id: studentA1 }) });
  expect(res1.status).toBe(200);
  const json1 = (await res1.json()) as { videos: { title: string }[] };
  expect(json1.videos.length).toBe(1);

  // parentA CANNOT see studentB1's videos (no guardian link).
  const { s: parentBSession } = await login(parentB.email, parentB.password);
  const res2 = await GET(await makeRequest(`/api/parent/students/${studentA1}/videos?academyId=${ACADEMY_A_ID}`, noAuth(parentBSession)), { params: Promise.resolve({ id: studentA1 }) });
  expect(res2.status).toBe(403); // parentB is not linked to studentA1
});
