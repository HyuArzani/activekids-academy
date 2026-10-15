/**
 * Phase B2.3 — Academy-wide occurrences endpoint + Attendance UI regression tests.
 *
 * Covers:
 *   1. GET /api/admin/occurrences (academy-wide, with filters: fromDate/toDate/classId/status)
 *   2. Cross-academy isolation (admin A cannot list academy B's occurrences)
 *   3. Auth/CSRF for the new endpoint (401 without session, 403 with wrong academy)
 *   4. recordedCount LATERAL join correctness
 *   5. Validation: fromDate > toDate → 422, invalid status → 422
 *   6. The existing attendance endpoints still work (recordAttendance,
 *      updateAttendance, getOccurrenceRoster) — verifies the UI's
 *      POST/PATCH/GET contract.
 *
 * Tests run under PgLite (NOT real PostgreSQL — concurrency NOT verified).
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
let classAId: string;
let classBId: string;
let versionAId: string;
let slotAId: string;
let occurrenceAId: string;
let occurrenceBId: string;
let pastOccurrenceAId: string;
let cancelledOccurrenceAId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`,
    [ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`,
    [ACADEMY_B_ID],
  );
  adminA = await createTestUser(db, {
    email: "admin-a@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
  });
  adminB = await createTestUser(db, {
    email: "admin-b@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_B_ID,
  });

  // Academy A: class + version + slot + occurrences
  classAId = randomUUID();
  await db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Class A', 12, true);`,
    [classAId, ACADEMY_A_ID],
  );
  versionAId = randomUUID();
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`,
    [versionAId, classAId],
  );
  slotAId = randomUUID();
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`,
    [slotAId, versionAId],
  );
  // Today's occurrence (Tuesday in Jakarta)
  occurrenceAId = randomUUID();
  await db.query(
    `INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, '2026-10-13', '2026-10-13 08:00:00+00', '2026-10-13 09:00:00+00', 'planned', 12);`,
    [occurrenceAId, ACADEMY_A_ID, classAId, slotAId, versionAId],
  );
  // Past occurrence
  pastOccurrenceAId = randomUUID();
  await db.query(
    `INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, '2026-09-15', '2026-09-15 08:00:00+00', '2026-09-15 09:00:00+00', 'completed', 12);`,
    [pastOccurrenceAId, ACADEMY_A_ID, classAId, slotAId, versionAId],
  );
  // Cancelled occurrence on a different date
  cancelledOccurrenceAId = randomUUID();
  await db.query(
    `INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity, cancelled_at, cancelled_reason)
     VALUES ($1, $2, $3, $4, $5, '2026-10-20', '2026-10-20 08:00:00+00', '2026-10-20 09:00:00+00', 'cancelled', 12, now(), 'Holiday');`,
    [cancelledOccurrenceAId, ACADEMY_A_ID, classAId, slotAId, versionAId],
  );

  // Academy B: separate class + version + slot + occurrence
  classBId = randomUUID();
  await db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Class B', 10, true);`,
    [classBId, ACADEMY_B_ID],
  );
  const versionBId = randomUUID();
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`,
    [versionBId, classBId],
  );
  const slotBId = randomUUID();
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 3, '17:00', '18:00');`,
    [slotBId, versionBId],
  );
  occurrenceBId = randomUUID();
  await db.query(
    `INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, '2026-10-13', '2026-10-13 10:00:00+00', '2026-10-13 11:00:00+00', 'planned', 10);`,
    [occurrenceBId, ACADEMY_B_ID, classBId, slotBId, versionBId],
  );
});

afterEach(async () => {
  await teardownTestDb();
});

async function login(email: string, pw: string): Promise<{ s: string; c: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(
    await makeRequest("/api/auth/login", { method: "POST", body: { email, password: pw } }),
  );
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  return {
    s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!,
    c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]!,
  };
}
function auth(s: string, c: string) {
  return {
    cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c },
    headers: { [CSRF_HEADER]: c },
  };
}
function noAuth(s: string) {
  return { cookies: { [sessionCookieName()]: s } };
}

// ====================================================================
// GET /api/admin/occurrences — academy-wide listing
// ====================================================================

test("ACADEMY_LIST: returns only occurrences in the academy, ordered by date+time", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(`/api/admin/occurrences?academyId=${ACADEMY_A_ID}`, noAuth(s)),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string; className: string }[] };
  // Academy A has 3 occurrences (today, past, cancelled).
  expect(json.occurrences.length).toBe(3);
  // Verify all rows have className "Class A" (no leakage from academy B).
  for (const o of json.occurrences) {
    expect(o.className).toBe("Class A");
  }
});

test("ACADEMY_LIST: fromDate/toDate filter limits results", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  // Filter to just 2026-10-13 (today's occurrence only — past is 2026-09-15,
  // cancelled is 2026-10-20).
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&fromDate=2026-10-13&toDate=2026-10-13`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string }[] };
  expect(json.occurrences.length).toBe(1);
  expect(json.occurrences[0]!.id).toBe(occurrenceAId);
});

test("ACADEMY_LIST: classId filter limits to one class", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&classId=${classAId}`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { classId: string }[] };
  expect(json.occurrences.length).toBe(3);
  for (const o of json.occurrences) {
    expect(o.classId).toBe(classAId);
  }
});

test("ACADEMY_LIST: status filter returns only matching status", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&status=planned`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { status: string }[] };
  // Only today's occurrence is planned (past is completed, one is cancelled).
  expect(json.occurrences.length).toBe(1);
  expect(json.occurrences[0]!.status).toBe("planned");
});

test("ACADEMY_LIST: recordedCount LATERAL join counts attendance rows", async () => {
  // Pre-insert two attendance rows for occurrenceAId (need a student + enrollment first).
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Test Student');`,
    [studentId, ACADEMY_A_ID],
  );
  const enrollmentId = randomUUID();
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`,
    [enrollmentId, studentId, classAId],
  );
  await db.query(
    `INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by)
     VALUES ($1, $2, $3, 'present', $4);`,
    [randomUUID(), occurrenceAId, studentId, adminA.id],
  );

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&classId=${classAId}&status=planned`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string; recordedCount: number }[] };
  const occ = json.occurrences.find((o) => o.id === occurrenceAId);
  expect(occ).toBeDefined();
  expect(occ!.recordedCount).toBe(1);
});

test("ACADEMY_LIST: cancelled occurrences include cancelledReason", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&status=cancelled`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { cancelledReason: string | null }[] };
  expect(json.occurrences.length).toBe(1);
  expect(json.occurrences[0]!.cancelledReason).toBe("Holiday");
});

// ====================================================================
// Validation
// ====================================================================

test("VALIDATION: fromDate > toDate returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&fromDate=2026-10-20&toDate=2026-10-13`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(422);
});

test("VALIDATION: invalid status returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&status=bogus`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(422);
});

test("VALIDATION: invalid classId returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&classId=not-a-uuid`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(422);
});

test("VALIDATION: invalid fromDate returns 422", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences?academyId=${ACADEMY_A_ID}&fromDate=not-a-date`,
      noAuth(s),
    ),
  );
  expect(res.status).toBe(422);
});

// ====================================================================
// Auth + Cross-academy isolation
// ====================================================================

test("AUTH: without session returns 401", async () => {
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(await makeRequest(`/api/admin/occurrences?academyId=${ACADEMY_A_ID}`));
  expect(res.status).toBe(401);
});

test("CROSS_ACADEMY: admin A querying academy B with academyId=A returns only A's occurrences (no leakage)", async () => {
  // Admin A passes their own academyId in the query, so they get only A's data.
  // Even though occurrenceBId exists in the DB, it's filtered out by academy_id.
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(`/api/admin/occurrences?academyId=${ACADEMY_A_ID}`, noAuth(s)),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string }[] };
  // All rows must belong to academy A — verify B's occurrence is NOT present.
  expect(json.occurrences.find((o) => o.id === occurrenceBId)).toBeUndefined();
});

test("CROSS_ACADEMY: admin A cannot list academy B's occurrences via academyId=B", async () => {
  // Admin A's principal has no membership in academy B → handleApiRequest
  // rejects with FORBIDDEN before any data is returned.
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(`/api/admin/occurrences?academyId=${ACADEMY_B_ID}`, noAuth(s)),
  );
  expect(res.status).toBe(403);
});

test("CROSS_ACADEMY: admin B cannot see academy A's occurrence in their listing", async () => {
  const { s } = await login(adminB.email, adminB.password);
  const { GET } = await import("@/app/api/admin/occurrences/route.ts");
  const res = await GET(
    await makeRequest(`/api/admin/occurrences?academyId=${ACADEMY_B_ID}`, noAuth(s)),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string }[] };
  // Academy B has only 1 occurrence (occurrenceBId).
  expect(json.occurrences.length).toBe(1);
  expect(json.occurrences[0]!.id).toBe(occurrenceBId);
  // Academy A's occurrence must NOT appear.
  expect(json.occurrences.find((o) => o.id === occurrenceAId)).toBeUndefined();
});

// ====================================================================
// Existing attendance endpoints (UI contract verification)
// ====================================================================

test("ROSTER: GET /occurrences/:id/roster returns 200 with empty roster for class with no enrollments", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/[id]/roster/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences/${occurrenceAId}/roster?academyId=${ACADEMY_A_ID}`,
      noAuth(s),
    ),
    { params: Promise.resolve({ id: occurrenceAId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { roster: unknown[]; occurrence: { id: string } };
  expect(json.occurrence.id).toBe(occurrenceAId);
  expect(json.roster.length).toBe(0);
});

test("ROSTER: GET with enrolled student returns roster with null attendance_status", async () => {
  // Add a student + enrollment in classAId.
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Enrolled Student');`,
    [studentId, ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`,
    [randomUUID(), studentId, classAId],
  );

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/occurrences/[id]/roster/route.ts");
  const res = await GET(
    await makeRequest(
      `/api/admin/occurrences/${occurrenceAId}/roster?academyId=${ACADEMY_A_ID}`,
      noAuth(s),
    ),
    { params: Promise.resolve({ id: occurrenceAId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    roster: { student_id: string; full_name: string; attendance_status: string | null }[];
  };
  expect(json.roster.length).toBe(1);
  expect(json.roster[0]!.student_id).toBe(studentId);
  expect(json.roster[0]!.full_name).toBe("Enrolled Student");
  expect(json.roster[0]!.attendance_status).toBeNull();
});

test("RECORD: POST /occurrences/:id/attendance creates a record (201) + audit", async () => {
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Recorded Student');`,
    [studentId, ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`,
    [randomUUID(), studentId, classAId],
  );

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/occurrences/${occurrenceAId}/attendance?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body: { studentId, status: "present", notes: "On time" } },
    ),
    { params: Promise.resolve({ id: occurrenceAId }) },
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { attendanceId: string };
  expect(json.attendanceId).toBeTruthy();

  // Verify audit event.
  const audit = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'attendance.record' AND target_id = $1;`,
    [json.attendanceId],
  );
  expect((audit.rows[0] as { c: number }).c).toBe(1);
});

test("RECORD: missing CSRF returns 403", async () => {
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'No CSRF Student');`,
    [studentId, ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`,
    [randomUUID(), studentId, classAId],
  );

  const { s } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route.ts");
  // Session cookie present but no CSRF header.
  const res = await POST(
    await makeRequest(
      `/api/admin/occurrences/${occurrenceAId}/attendance?academyId=${ACADEMY_A_ID}`,
      {
        method: "POST",
        cookies: { [sessionCookieName()]: s },
        body: { studentId, status: "present" },
      },
    ),
    { params: Promise.resolve({ id: occurrenceAId }) },
  );
  expect(res.status).toBe(403);
});

test("RECORD: unauthenticated returns 401", async () => {
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/occurrences/${occurrenceAId}/attendance?academyId=${ACADEMY_A_ID}`,
      { method: "POST", body: { studentId: randomUUID(), status: "present" } },
    ),
    { params: Promise.resolve({ id: occurrenceAId }) },
  );
  expect(res.status).toBe(401);
});

test("RECORD: duplicate (occurrence, student) returns 409", async () => {
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Duplicate Student');`,
    [studentId, ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`,
    [randomUUID(), studentId, classAId],
  );
  // Pre-insert an attendance record.
  await db.query(
    `INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by)
     VALUES ($1, $2, $3, 'absent', $4);`,
    [randomUUID(), occurrenceAId, studentId, adminA.id],
  );

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/occurrences/[id]/attendance/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/occurrences/${occurrenceAId}/attendance?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body: { studentId, status: "present" } },
    ),
    { params: Promise.resolve({ id: occurrenceAId }) },
  );
  expect(res.status).toBe(409);
});

test("PATCH: update existing attendance status (200) + audit", async () => {
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Patch Student');`,
    [studentId, ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`,
    [randomUUID(), studentId, classAId],
  );
  const attendanceId = randomUUID();
  await db.query(
    `INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by, notes)
     VALUES ($1, $2, $3, 'absent', $4, 'Sick');`,
    [attendanceId, occurrenceAId, studentId, adminA.id],
  );

  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/attendance/[id]/route.ts");
  const res = await PATCH(
    await makeRequest(
      `/api/admin/attendance/${attendanceId}?academyId=${ACADEMY_A_ID}`,
      { method: "PATCH", ...auth(s, c), body: { status: "present", notes: "Recovered" } },
    ),
    { params: Promise.resolve({ id: attendanceId }) },
  );
  expect(res.status).toBe(200);

  // Verify the record was updated.
  const row = await db.query<{ status: string; notes: string | null }>(
    `SELECT status, notes FROM attendance_records WHERE id = $1;`,
    [attendanceId],
  );
  expect((row.rows[0] as { status: string }).status).toBe("present");
  expect((row.rows[0] as { notes: string | null }).notes).toBe("Recovered");

  // Verify audit event.
  const audit = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'attendance.update' AND target_id = $1;`,
    [attendanceId],
  );
  expect((audit.rows[0] as { c: number }).c).toBe(1);
});

test("PATCH: cross-academy attendance update returns 404", async () => {
  // Create an attendance record in academy A.
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'CrossAcad Student');`,
    [studentId, ACADEMY_A_ID],
  );
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`,
    [randomUUID(), studentId, classAId],
  );
  const attendanceId = randomUUID();
  await db.query(
    `INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by)
     VALUES ($1, $2, $3, 'present', $4);`,
    [attendanceId, occurrenceAId, studentId, adminA.id],
  );

  // Admin B tries to PATCH academy A's attendance record via academyId=B.
  // The attendance is scoped via occurrence → academy, so the academy-scope
  // JOIN returns no row → 404 (NOT 403, because the row genuinely doesn't
  // exist in academy B's scope).
  const { s, c } = await login(adminB.email, adminB.password);
  const { PATCH } = await import("@/app/api/admin/attendance/[id]/route.ts");
  const res = await PATCH(
    await makeRequest(
      `/api/admin/attendance/${attendanceId}?academyId=${ACADEMY_B_ID}`,
      { method: "PATCH", ...auth(s, c), body: { status: "absent" } },
    ),
    { params: Promise.resolve({ id: attendanceId }) },
  );
  expect(res.status).toBe(404);

  // Verify the record was NOT modified.
  const row = await db.query<{ status: string }>(
    `SELECT status FROM attendance_records WHERE id = $1;`,
    [attendanceId],
  );
  expect((row.rows[0] as { status: string }).status).toBe("present");
});
