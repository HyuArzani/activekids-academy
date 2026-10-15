/**
 * API integration tests: Attendance management (Stage 4).
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
let parentA: TestUser;
let classId: string;
let otherClassId: string;
let studentId: string;
let otherStudentId: string;
let studentBId: string;
let planId: string;
let packageId: string;
let entitlementIds: string[] = [];
let versionId: string;
let slotId: string;
let slotBId: string;
let occId1: string;
let occId2: string;
let pastOccId: string;
let attendanceId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  otherClassId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class B', 12);`, [otherClassId, ACADEMY_A_ID]);

  studentId = randomUUID();
  otherStudentId = randomUUID();
  studentBId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student Other');`, [otherStudentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`, [studentBId, ACADEMY_B_ID]);

  // Enroll studentId in classId (effective from a past date so all test occurrences are eligible).
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classId]);

  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Plan 4', 4);`, [planId, ACADEMY_A_ID]);
  packageId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [packageId, studentId, planId, classId]);

  // 4 unassigned entitlements
  entitlementIds = [];
  for (let i = 0; i < 4; i++) {
    const eid = randomUUID();
    await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, $3, 'active');`, [eid, packageId, i + 1]);
    entitlementIds.push(eid);
  }

  // Schedule version + slot + occurrences (future dates so generation is valid).
  versionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, classId]);
  slotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotId, versionId]);
  // A second slot used only for cross-academy occurrences (avoids the
  // (schedule_slot_id, occurrence_date) UNIQUE collision when reusing the
  // same date as an academy-A occurrence).
  slotBId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 3, '17:00', '18:00');`, [slotBId, versionId]);
  occId1 = randomUUID();
  occId2 = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occId1, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occId2, ACADEMY_A_ID, classId, slotId, versionId]);

  // A past occurrence (for historical correction tests).
  pastOccId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-01-05', '2027-01-05 15:00:00', '2027-01-05 16:00:00', 'planned', 12);`, [pastOccId, ACADEMY_A_ID, classId, slotId, versionId]);

  // Pre-record one attendance for update/correct/history tests (present, linked to entitlement 0).
  // Assign entitlement 0 to occId1 first.
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[0], occId1]);
  attendanceId = randomUUID();
  await db.query(
    `INSERT INTO attendance_records (id, training_occurrence_id, student_id, entitlement_id, status, recorded_by, notes)
     VALUES ($1, $2, $3, $4, 'present', $5, 'Initial record');`,
    [attendanceId, occId1, studentId, entitlementIds[0]!, adminA.id],
  );
  // Mark entitlement 0 as completed (matching recordAttendance's behavior).
  await db.query(`UPDATE session_entitlements SET status = 'completed' WHERE id = $1;`, [entitlementIds[0]!]);
  await db.query(`INSERT INTO entitlement_events (id, entitlement_id, event_type, occurred_at, actor_user_id, reason) VALUES ($1, $2, 'completed', now(), $3, 'Attendance recorded as present');`, [randomUUID(), entitlementIds[0]!, adminA.id]);
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

// === GET occurrence roster ===============================================

test("GET roster lists enrolled students + attendance (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/[id]/roster/route");
  const res = await GET(await makeRequest(`/api/admin/occurrences/${occId1}/roster?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: occId1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { roster: { student_id: string; attendance_id: string | null }[] };
  expect(json.roster.length).toBe(1);
  expect(json.roster[0]!.student_id).toBe(studentId);
  // The pre-recorded attendance row should be reflected.
  expect(json.roster[0]!.attendance_id).toBe(attendanceId);
});

test("GET roster rejects cross-academy occurrence (404)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  // Create an occurrence in academy B (use slotBId to avoid UNIQUE collision).
  const occB = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 17:00:00', '2027-06-16 18:00:00', 'planned', 12);`, [occB, ACADEMY_B_ID, classId, slotBId, versionId]);
  const { GET } = await import("@/app/api/admin/occurrences/[id]/roster/route");
  const res = await GET(await makeRequest(`/api/admin/occurrences/${occB}/roster?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: occB }) });
  expect(res.status).toBe(404);
});

test("GET roster rejects coach (403)", async () => {
  const { s } = await login(coachA.email, coachA.password);
  const { GET } = await import("@/app/api/admin/occurrences/[id]/roster/route");
  const res = await GET(await makeRequest(`/api/admin/occurrences/${occId1}/roster?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: occId1 }) });
  expect(res.status).toBe(403);
});

// === POST record attendance =============================================

test("POST attendance records (201) + audit", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId2}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "present", notes: "On time" }, ...auth(s, c) }), { params: Promise.resolve({ id: occId2 }) });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { attendanceId: string };
  // Verify audit.
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'attendance.record';`);
  expect((audit.rows[0] as { c: number }).c).toBeGreaterThanOrEqual(1);
  // Verify attendance row.
  const ar = await db.query<{ status: string; notes: string | null }>(`SELECT status, notes FROM attendance_records WHERE id = $1;`, [json.attendanceId]);
  expect((ar.rows[0] as { status: string }).status).toBe("present");
  expect((ar.rows[0] as { notes: string | null }).notes).toBe("On time");
});

test("POST attendance rejects duplicate (409)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  // occId1 already has attendance for studentId.
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId1}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "absent" }, ...auth(s, c) }), { params: Promise.resolve({ id: occId1 }) });
  expect(res.status).toBe(409);
});

test("POST attendance rejects unenrolled student (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // otherStudentId is NOT enrolled in classId.
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId2}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId: otherStudentId, status: "present" }, ...auth(s, c) }), { params: Promise.resolve({ id: occId2 }) });
  expect(res.status).toBe(422);
});

test("POST attendance rejects cross-academy occurrence (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const occB = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 17:00:00', '2027-06-16 18:00:00', 'planned', 12);`, [occB, ACADEMY_B_ID, classId, slotBId, versionId]);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occB}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "present" }, ...auth(s, c) }), { params: Promise.resolve({ id: occB }) });
  expect(res.status).toBe(404);
});

test("POST attendance rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId2}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "present" }, ...auth(s, c) }), { params: Promise.resolve({ id: occId2 }) });
  expect(res.status).toBe(403);
});

test("POST attendance rejects parent (403)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId2}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "present" }, ...auth(s, c) }), { params: Promise.resolve({ id: occId2 }) });
  expect(res.status).toBe(403);
});

test("POST attendance rejects without CSRF (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId2}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "present" }, cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: occId2 }) });
  expect(res.status).toBe(403);
});

test("POST attendance with entitlement marks it completed (atomically)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Assign entitlement 1 to occId2 first.
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[1]!, occId2]);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId2}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "late", entitlementId: entitlementIds[1] }, ...auth(s, c) }), { params: Promise.resolve({ id: occId2 }) });
  expect(res.status).toBe(201);
  // Entitlement 1 should be completed.
  const ent = await db.query<{ status: string }>(`SELECT status FROM session_entitlements WHERE id = $1;`, [entitlementIds[1]!]);
  expect((ent.rows[0] as { status: string }).status).toBe("completed");
  // An entitlement 'completed' event should exist.
  const ev = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'completed';`, [entitlementIds[1]!]);
  expect((ev.rows[0] as { c: number }).c).toBe(1);
});

test("POST attendance 'absent' does NOT consume skip or change entitlement", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Assign entitlement 2 to occId2 first.
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[2]!, occId2]);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route");
  const res = await POST(await makeRequest(`/api/admin/occurrences/${occId2}/attendance?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { studentId, status: "absent", entitlementId: entitlementIds[2] }, ...auth(s, c) }), { params: Promise.resolve({ id: occId2 }) });
  expect(res.status).toBe(201);
  // Entitlement 2 should remain 'active'.
  const ent = await db.query<{ status: string; skip_used: boolean }>(`SELECT status, skip_used FROM session_entitlements WHERE id = $1;`, [entitlementIds[2]!]);
  const row = ent.rows[0] as { status: string; skip_used: boolean };
  expect(row.status).toBe("active");
  expect(row.skip_used).toBe(false);
  // No 'completed' event for this entitlement.
  const ev = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'completed';`, [entitlementIds[2]!]);
  expect((ev.rows[0] as { c: number }).c).toBe(0);
});

// === PATCH update attendance ============================================

test("PATCH attendance updates notes (200) + audit", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/attendance/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/attendance/${attendanceId}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { notes: "Updated note" }, ...auth(s, c) }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(200);
  const ar = await db.query<{ notes: string | null }>(`SELECT notes FROM attendance_records WHERE id = $1;`, [attendanceId]);
  expect((ar.rows[0] as { notes: string | null }).notes).toBe("Updated note");
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'attendance.update' AND target_id = $1;`, [attendanceId]);
  expect((audit.rows[0] as { c: number }).c).toBe(1);
});

test("PATCH attendance rejects empty update (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/attendance/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/attendance/${attendanceId}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(422);
});

test("PATCH attendance rejects without CSRF (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/attendance/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/attendance/${attendanceId}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { notes: "x" }, cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(403);
});

test("PATCH attendance rejects cross-academy (404)", async () => {
  // Create an attendance in academy B.
  const occB = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 17:00:00', '2027-06-16 18:00:00', 'planned', 12);`, [occB, ACADEMY_B_ID, classId, slotBId, versionId]);
  const attB = randomUUID();
  await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by) VALUES ($1, $2, $3, 'present', $4);`, [attB, occB, studentBId, adminA.id]);
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/attendance/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/attendance/${attB}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { notes: "x" }, ...auth(s, c) }), { params: Promise.resolve({ id: attB }) });
  expect(res.status).toBe(404);
});

// === POST correct attendance ===========================================

test("POST correct changes status with reason (200) + audit with reason", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/attendance/[id]/correct/route");
  const res = await POST(await makeRequest(`/api/admin/attendance/${attendanceId}/correct?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { status: "late", reason: "Wrong status recorded" }, ...auth(s, c) }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(200);
  const ar = await db.query<{ status: string }>(`SELECT status FROM attendance_records WHERE id = $1;`, [attendanceId]);
  expect((ar.rows[0] as { status: string }).status).toBe("late");
  const audit = await db.query<{ reason: string | null }>(`SELECT reason FROM audit_events WHERE action = 'attendance.correct' AND target_id = $1;`, [attendanceId]);
  expect((audit.rows[0] as { reason: string | null }).reason).toBe("Wrong status recorded");
});

test("POST correct rejects empty reason (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/attendance/[id]/correct/route");
  const res = await POST(await makeRequest(`/api/admin/attendance/${attendanceId}/correct?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { status: "late", reason: "" }, ...auth(s, c) }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(422);
});

test("POST correct rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/attendance/[id]/correct/route");
  const res = await POST(await makeRequest(`/api/admin/attendance/${attendanceId}/correct?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { status: "late", reason: "fix" }, ...auth(s, c) }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(403);
});

test("POST correct rejects without CSRF (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/attendance/[id]/correct/route");
  const res = await POST(await makeRequest(`/api/admin/attendance/${attendanceId}/correct?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { status: "late", reason: "fix" }, cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(403);
});

test("POST correct (absent→present) marks entitlement completed (forward rule)", async () => {
  // Create a fresh attendance record with status 'absent' + linked active entitlement.
  // Assign entitlement 3 to occId2.
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [entitlementIds[3]!, occId2]);
  const attId = randomUUID();
  await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, entitlement_id, status, recorded_by) VALUES ($1, $2, $3, $4, 'absent', $5);`, [attId, occId2, studentId, entitlementIds[3]!, adminA.id]);
  // entitlement 3 should still be 'active' (absent doesn't mark completed).
  const before = await db.query<{ status: string }>(`SELECT status FROM session_entitlements WHERE id = $1;`, [entitlementIds[3]!]);
  expect((before.rows[0] as { status: string }).status).toBe("active");

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/attendance/[id]/correct/route");
  const res = await POST(await makeRequest(`/api/admin/attendance/${attId}/correct?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { status: "present", reason: "Student actually attended" }, ...auth(s, c) }), { params: Promise.resolve({ id: attId }) });
  expect(res.status).toBe(200);
  const after = await db.query<{ status: string }>(`SELECT status FROM session_entitlements WHERE id = $1;`, [entitlementIds[3]!]);
  expect((after.rows[0] as { status: string }).status).toBe("completed");
});

// === Audit rollback =====================================================

test("audit rollback: failed correct leaves no audit", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const { correctAttendance } = await import("@/lib/domain/attendance");
  const { AppError } = await import("@/lib/errors");
  const principal = (await extractPrincipal(await makeRequest("/api/auth/session", { cookies: { [sessionCookieName()]: s } }), db))!.principal;

  // Attempt to correct a non-existent attendance ID.
  try {
    await correctAttendance(principal, ACADEMY_A_ID, randomUUID(), { status: "present", reason: "fix" }, db);
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
  }
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'attendance.correct';`);
  expect((audit.rows[0] as { c: number }).c).toBe(0);
});

// === GET attendance history =============================================

test("GET attendance by studentId returns history (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/attendance/route");
  const res = await GET(await makeRequest(`/api/admin/attendance?academyId=${ACADEMY_A_ID}&studentId=${studentId}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { attendance: { id: string; status: string }[] };
  expect(json.attendance.length).toBeGreaterThanOrEqual(1);
  expect(json.attendance.some((a) => a.id === attendanceId)).toBe(true);
});

test("GET attendance by date range returns history (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/attendance/route");
  const res = await GET(await makeRequest(`/api/admin/attendance?academyId=${ACADEMY_A_ID}&fromDate=2027-06-01&toDate=2027-06-30`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { attendance: { id: string }[] };
  expect(json.attendance.some((a) => a.id === attendanceId)).toBe(true);
});

test("GET attendance rejects invalid date format (422)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/attendance/route");
  const res = await GET(await makeRequest(`/api/admin/attendance?academyId=${ACADEMY_A_ID}&fromDate=not-a-date&toDate=2027-06-30`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(422);
});

test("GET attendance rejects missing params (422)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/attendance/route");
  const res = await GET(await makeRequest(`/api/admin/attendance?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(422);
});

test("GET attendance rejects coach (403)", async () => {
  const { s } = await login(coachA.email, coachA.password);
  const { GET } = await import("@/app/api/admin/attendance/route");
  const res = await GET(await makeRequest(`/api/admin/attendance?academyId=${ACADEMY_A_ID}&studentId=${studentId}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});

test("GET single attendance returns record (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/attendance/[id]/route");
  const res = await GET(await makeRequest(`/api/admin/attendance/${attendanceId}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: attendanceId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { attendance: { id: string; status: string; class_name: string } };
  expect(json.attendance.id).toBe(attendanceId);
  expect(json.attendance.status).toBe("present");
  expect(json.attendance.class_name).toBe("Class A");
});

test("GET single attendance rejects cross-academy (404)", async () => {
  const occB = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 17:00:00', '2027-06-16 18:00:00', 'planned', 12);`, [occB, ACADEMY_B_ID, classId, slotBId, versionId]);
  const attB = randomUUID();
  await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by) VALUES ($1, $2, $3, 'present', $4);`, [attB, occB, studentBId, adminA.id]);
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/attendance/[id]/route");
  const res = await GET(await makeRequest(`/api/admin/attendance/${attB}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: attB }) });
  expect(res.status).toBe(404);
});
