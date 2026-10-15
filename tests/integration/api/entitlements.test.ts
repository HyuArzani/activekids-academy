/**
 * API integration tests: Entitlement assignment and recovery.
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
let planId: string;
let packageId: string;
let versionId: string;
let slotId: string;
let occId1: string;
let occId2: string;
let entitlementIds: string[] = [];

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);
  studentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classId]);

  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Plan 4', 4);`, [planId, ACADEMY_A_ID]);
  packageId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [packageId, studentId, planId, classId]);

  // Create 4 unassigned entitlements
  entitlementIds = [];
  for (let i = 0; i < 4; i++) {
    const eid = randomUUID();
    await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, $3, 'active');`, [eid, packageId, i + 1]);
    entitlementIds.push(eid);
  }

  // Create schedule version + slots + occurrences
  versionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, classId]);
  slotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotId, versionId]);
  occId1 = randomUUID();
  occId2 = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occId1, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occId2, ACADEMY_A_ID, classId, slotId, versionId]);
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

// === GET entitlements ====================================================

test("GET entitlements lists all for package (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/packages/[id]/entitlements/route");
  const res = await GET(await makeRequest(`/api/admin/packages/${packageId}/entitlements?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: packageId }) });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { entitlements: unknown[] }).entitlements.length).toBe(4);
});

// === POST assign ========================================================

test("POST assign succeeds (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/assign/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/assign?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { occurrenceId: occId1 }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(200);
  // Verify assignment
  const dbRes = await db.query<{ original: string | null; assigned: string | null }>(`SELECT original_occurrence_id AS original, assigned_occurrence_id AS assigned FROM session_entitlements WHERE id = $1;`, [entitlementIds[0]!]);
  const row = dbRes.rows[0] as { original: string | null; assigned: string | null };
  expect(row.original).toBe(occId1);
  expect(row.assigned).toBe(occId1);
});

test("POST assign rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/assign/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/assign?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { occurrenceId: occId1 }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(403);
});

test("POST assign rejects already-assigned to different (409)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Pre-assign to occId1
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[0], occId1]);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/assign/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/assign?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { occurrenceId: occId2 }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(409);
});

test("POST assign rejects cancelled occurrence (409)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  await db.query(`UPDATE training_occurrences SET status = 'cancelled' WHERE id = $1;`, [occId1]);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/assign/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/assign?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { occurrenceId: occId1 }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(409);
});

test("POST assign is idempotent (same occurrence → 200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Pre-assign to occId1
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[0], occId1]);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/assign/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/assign?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { occurrenceId: occId1 }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(200);
});

test("POST assign rejects without CSRF (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/assign/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/assign?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { occurrenceId: occId1 }, cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(403);
});

// === POST admin correct =================================================

test("POST correct reassigns with reason (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Pre-assign to occId1
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[0], occId1]);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/correct/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/correct?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { newAssignedOccurrenceId: occId2, reason: "Schedule change" }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(200);
  // Verify assigned changed, original unchanged
  const dbRes = await db.query<{ original: string | null; assigned: string | null }>(`SELECT original_occurrence_id AS original, assigned_occurrence_id AS assigned FROM session_entitlements WHERE id = $1;`, [entitlementIds[0]!]);
  const row = dbRes.rows[0] as { original: string | null; assigned: string | null };
  expect(row.original).toBe(occId1); // immutable
  expect(row.assigned).toBe(occId2); // reassigned
  // Verify audit event
  const audit = await db.query(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'entitlement.admin_correct';`);
  expect((audit.rows[0] as { c: number }).c).toBe(1);
});

test("POST correct rejects empty reason (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/entitlements/[id]/correct/route");
  const res = await POST(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/correct?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { newAssignedOccurrenceId: occId2, reason: "" }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(422);
});

// === POST bulk-assign unassigned ========================================

test("POST assign-unassigned assigns all eligible (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/packages/[id]/entitlements/assign-unassigned/route");
  const res = await POST(await makeRequest(`/api/admin/packages/${packageId}/entitlements/assign-unassigned?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c) }), { params: Promise.resolve({ id: packageId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { assigned: number; stillUnassigned: number };
  // 2 occurrences with capacity 12, 4 entitlements → all 4 assigned
  expect(json.assigned).toBe(4);
  expect(json.stillUnassigned).toBe(0);
});

test("POST assign-unassigned returns 0 when no eligible occurrences", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Cancel both occurrences
  await db.query(`UPDATE training_occurrences SET status = 'cancelled';`);
  const { POST } = await import("@/app/api/admin/packages/[id]/entitlements/assign-unassigned/route");
  const res = await POST(await makeRequest(`/api/admin/packages/${packageId}/entitlements/assign-unassigned?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c) }), { params: Promise.resolve({ id: packageId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { assigned: number; stillUnassigned: number };
  expect(json.assigned).toBe(0);
  expect(json.stillUnassigned).toBe(4);
});

// === GET events =========================================================

test("GET events lists history (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Assign an entitlement (creates an 'occurrence_assigned' event)
  const { POST: assignPost } = await import("@/app/api/admin/entitlements/[id]/assign/route");
  await assignPost(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/assign?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { occurrenceId: occId1 }, ...auth(s, c) }), { params: Promise.resolve({ id: entitlementIds[0]! }) });

  const { GET } = await import("@/app/api/admin/entitlements/[id]/events/route");
  const res = await GET(await makeRequest(`/api/admin/entitlements/${entitlementIds[0]}/events?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: entitlementIds[0]! }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { events: { event_type: string }[] };
  expect(json.events.length).toBeGreaterThanOrEqual(1);
  expect(json.events.some((e) => e.event_type === "occurrence_assigned")).toBe(true);
});

// === Audit rollback ======================================================

test("audit rollback: failed assign leaves no audit", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const { assignOccurrence } = await import("@/lib/domain/entitlements");
  const { AppError } = await import("@/lib/errors");
  const principal = (await extractPrincipal(await makeRequest("/api/auth/session", { cookies: { [sessionCookieName()]: s } }), db))!.principal;

  // Try to assign to a non-existent occurrence
  try {
    await assignOccurrence(principal, ACADEMY_A_ID, { entitlementId: entitlementIds[0]!, occurrenceId: randomUUID() }, db);
    expect.fail("should have thrown");
  } catch (err) { expect(err).toBeInstanceOf(AppError); }

  const audit = await db.query(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'entitlement.assign_occurrence';`);
  expect((audit.rows[0] as { c: number }).c).toBe(0);
});

// === Original occurrence immutability ===================================

test("admin correct cannot change original_occurrence_id", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Pre-assign
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[0], occId1]);
  // Try to directly change original via DB (trigger should block)
  try {
    await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[0], occId2]);
    expect.fail("trigger should have blocked");
  } catch (err) {
    expect((err as { serverCause?: { message?: string } }).serverCause?.message ?? (err as Error).message).toContain("immutable");
  }
});

// === Cross-academy =======================================================

test("GET entitlements rejects cross-academy package (404)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  // Create package in academy B
  const studentB = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'B Student');`, [studentB, ACADEMY_B_ID]);
  const pkgB = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkgB, studentB, planId, classId]);
  const { GET } = await import("@/app/api/admin/packages/[id]/entitlements/route");
  const res = await GET(await makeRequest(`/api/admin/packages/${pkgB}/entitlements?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: pkgB }) });
  expect(res.status).toBe(404);
});
