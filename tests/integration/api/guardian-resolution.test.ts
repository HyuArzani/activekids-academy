/**
 * API integration tests: Existing-parent guardian resolution (Stage 7B.3).
 * Tests that email match cannot auto-link, Admin can explicitly resolve,
 * cross-academy rejection, idempotency, audit, no partial changes.
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
let existingGuardian: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  // Pre-existing guardian (parent) with a known email.
  existingGuardian = await createTestUser(db, { email: "existing@parent.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
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

async function submitReg(email: string): Promise<string> {
  const { POST } = await import("@/app/api/public/register/route");
  const res = await POST(await makeRequest("/api/public/register", {
    method: "POST",
    body: { academyId: ACADEMY_A_ID, parentFullName: "Some Parent", parentPhone: "+62 1", parentEmail: email, childFullName: "New Child", childDateOfBirth: "2015-01-01" },
  }));
  const json = (await res.json()) as { applicationId: string };
  return json.applicationId;
}

// === Tests ===============================================================

test("Email match alone cannot auto-link (CONFLICT)", async () => {
  const appId = await submitReg("existing@parent.com");
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${appId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: appId }) });
  expect(res.status).toBe(409);
  // Verify no student, no link created.
  const students = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE full_name = 'New Child';`);
  expect((students.rows[0] as { c: number }).c).toBe(0);
  const links = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM guardian_student_links WHERE guardian_user_id = $1;`, [existingGuardian.id]);
  expect((links.rows[0] as { c: number }).c).toBe(0);
  // Application stays pending.
  const app = await db.query<{ status: string }>(`SELECT status FROM registration_applications WHERE id = $1;`, [appId]);
  expect((app.rows[0] as { status: string }).status).toBe("pending");
});

test("Admin can explicitly resolve guardian, then approve succeeds", async () => {
  const appId = await submitReg("existing@parent.com");
  const { s, c } = await login(adminA.email, adminA.password);

  // Resolve: Admin selects the existing guardian.
  const { POST: resolve } = await import("@/app/api/admin/registrations/[id]/resolve-guardian/route");
  const resolveRes = await resolve(await makeRequest(`/api/admin/registrations/${appId}/resolve-guardian?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { guardianUserId: existingGuardian.id, reason: "Verified parent identity by phone" }, ...auth(s, c),
  }), { params: Promise.resolve({ id: appId }) });
  expect(resolveRes.status).toBe(200);

  // Verify resolution recorded.
  const app = await db.query<{ resolved_guardian_user_id: string | null; resolution_reason: string | null; resolved_by: string | null }>(`SELECT resolved_guardian_user_id, resolution_reason, resolved_by FROM registration_applications WHERE id = $1;`, [appId]);
  const a = app.rows[0] as { resolved_guardian_user_id: string | null; resolution_reason: string | null; resolved_by: string | null };
  expect(a.resolved_guardian_user_id).toBe(existingGuardian.id);
  expect(a.resolution_reason).toBe("Verified parent identity by phone");
  expect(a.resolved_by).toBe(adminA.id);

  // Now approve — should succeed (uses resolved guardian).
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const approveRes = await approve(await makeRequest(`/api/admin/registrations/${appId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: appId }) });
  expect(approveRes.status).toBe(200);
  const approveJson = (await approveRes.json()) as { studentId: string };

  // Verify student + link created.
  const link = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM guardian_student_links WHERE guardian_user_id = $1 AND student_id = $2;`, [existingGuardian.id, approveJson.studentId]);
  expect((link.rows[0] as { c: number }).c).toBe(1);
  // No duplicate user.
  const users = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM users WHERE email = 'existing@parent.com';`);
  expect((users.rows[0] as { c: number }).c).toBe(1);
});

test("Non-admin cannot resolve guardian (403)", async () => {
  const appId = await submitReg("existing@parent.com");
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/resolve-guardian/route");
  const res = await POST(await makeRequest(`/api/admin/registrations/${appId}/resolve-guardian?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { guardianUserId: existingGuardian.id, reason: "test" }, ...auth(s, c),
  }), { params: Promise.resolve({ id: appId }) });
  expect(res.status).toBe(403);
});

test("Cross-academy guardian selection rejected (404)", async () => {
  const appId = await submitReg("existing@parent.com");
  // Create a guardian in academy B.
  const guardianB = await createTestUser(db, { email: "guardian-b@example.com", password: "password123", role: "parent", academyId: ACADEMY_B_ID });
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/resolve-guardian/route");
  const res = await POST(await makeRequest(`/api/admin/registrations/${appId}/resolve-guardian?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { guardianUserId: guardianB.id, reason: "cross-academy" }, ...auth(s, c),
  }), { params: Promise.resolve({ id: appId }) });
  expect(res.status).toBe(404);
});

test("Retrying approval after resolve-guardian is idempotent", async () => {
  const appId = await submitReg("existing@parent.com");
  const { s, c } = await login(adminA.email, adminA.password);

  // Resolve.
  const { POST: resolve } = await import("@/app/api/admin/registrations/[id]/resolve-guardian/route");
  await resolve(await makeRequest(`/api/admin/registrations/${appId}/resolve-guardian?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { guardianUserId: existingGuardian.id, reason: "verified" }, ...auth(s, c),
  }), { params: Promise.resolve({ id: appId }) });

  // Approve twice.
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res1 = await approve(await makeRequest(`/api/admin/registrations/${appId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: appId }) });
  const res2 = await approve(await makeRequest(`/api/admin/registrations/${appId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: appId }) });
  expect(res1.status).toBe(200);
  expect(res2.status).toBe(200);
  const json1 = (await res1.json()) as { studentId: string; replayed: boolean };
  const json2 = (await res2.json()) as { studentId: string; replayed: boolean };
  expect(json1.studentId).toBe(json2.studentId);
  expect(json2.replayed).toBe(true);
  // Only one student + one link.
  const students = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE full_name = 'New Child';`);
  expect((students.rows[0] as { c: number }).c).toBe(1);
  const links = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM guardian_student_links WHERE guardian_user_id = $1;`, [existingGuardian.id]);
  expect((links.rows[0] as { c: number }).c).toBe(1);
});

test("Failed approval after resolve leaves no partial changes", async () => {
  const appId = await submitReg("existing@parent.com");
  // Create a pre-existing student with the same name (duplicate detection will CONFLICT).
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth) VALUES ($1, $2, 'New Child', '2015-01-01');`, [randomUUID(), ACADEMY_A_ID]);

  const { s, c } = await login(adminA.email, adminA.password);
  // Resolve.
  const { POST: resolve } = await import("@/app/api/admin/registrations/[id]/resolve-guardian/route");
  await resolve(await makeRequest(`/api/admin/registrations/${appId}/resolve-guardian?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { guardianUserId: existingGuardian.id, reason: "verified" }, ...auth(s, c),
  }), { params: Promise.resolve({ id: appId }) });

  // Approve should fail (duplicate student).
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${appId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: appId }) });
  expect(res.status).toBe(409);
  // Verify no link created, application stays pending.
  const links = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM guardian_student_links WHERE guardian_user_id = $1;`, [existingGuardian.id]);
  expect((links.rows[0] as { c: number }).c).toBe(0);
  const app = await db.query<{ status: string }>(`SELECT status FROM registration_applications WHERE id = $1;`, [appId]);
  expect((app.rows[0] as { status: string }).status).toBe("pending");
});

test("Resolution is auditable", async () => {
  const appId = await submitReg("existing@parent.com");
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/registrations/[id]/resolve-guardian/route");
  await POST(await makeRequest(`/api/admin/registrations/${appId}/resolve-guardian?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { guardianUserId: existingGuardian.id, reason: "Phone verification" }, ...auth(s, c),
  }), { params: Promise.resolve({ id: appId }) });

  const audit = await db.query<{ c: number; reason: string | null }>(`SELECT COUNT(*)::int AS c, reason FROM audit_events WHERE action = 'registration.resolve_guardian' AND academy_id = $1 GROUP BY reason;`, [ACADEMY_A_ID]);
  const a = audit.rows[0] as { c: number; reason: string | null };
  expect(a.c).toBe(1);
  expect(a.reason).toBe("Phone verification");
});
