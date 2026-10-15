/**
 * API integration tests: Dashboard quota reminders (Stage 5).
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
let student2Id: string;
let student3Id: string;
let studentNoPkgId: string;
let plan4Id: string;
let guardianA: TestUser;
let sv1: string;
let slot1: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  guardianA = await createTestUser(db, { email: "guardian-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);

  studentId = randomUUID();
  student2Id = randomUUID();
  student3Id = randomUUID();
  studentNoPkgId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student Exhausted');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student Makeup');`, [student2Id, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student Scheduling');`, [student3Id, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student No Pkg');`, [studentNoPkgId, ACADEMY_A_ID]);

  // Enroll all in class.
  for (const sid of [studentId, student2Id, student3Id, studentNoPkgId]) {
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), sid, classId]);
  }

  // Link guardian to studentId (primary, with phone).
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship, contact_phone) VALUES ($1, $2, $3, TRUE, 'father', '+62 812 3456 7890');`, [randomUUID(), guardianA.id, studentId]);

  plan4Id = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [plan4Id, ACADEMY_A_ID]);

  // Student Exhausted: all 4 entitlements completed (need real occurrences for FK).
  const pkg1 = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkg1, studentId, plan4Id, classId]);
  sv1 = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [sv1, classId]);
  slot1 = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slot1, sv1]);
  for (let i = 0; i < 4; i++) {
    const occId = randomUUID();
    const date = `2027-0${(i + 1)}-0${i + 1}`;
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, $6, '${date} 15:00:00', '${date} 16:00:00', 'planned', 12);`, [occId, ACADEMY_A_ID, classId, slot1, sv1, date]);
    const eid = randomUUID();
    await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, $3, 'completed', $4, $4);`, [eid, pkg1, i + 1, occId]);
  }

  // Student Makeup: 0 active, 2 skipped/awaiting (skipped requires skip_used=TRUE).
  const pkg2 = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkg2, student2Id, plan4Id, classId]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, skip_used) VALUES ($1, $2, 1, 'skipped', TRUE);`, [randomUUID(), pkg2]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, 2, 'awaiting_makeup');`, [randomUUID(), pkg2]);

  // Student Scheduling: 2 active unassigned + 1 active assigned.
  const pkg3 = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkg3, student3Id, plan4Id, classId]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, 1, 'active');`, [randomUUID(), pkg3]); // unassigned
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, 2, 'active');`, [randomUUID(), pkg3]); // unassigned
  const occId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occId, ACADEMY_A_ID, classId, slot1, sv1]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 3, 'active', $3, $3);`, [randomUUID(), pkg3, occId]); // assigned

  // Student No Pkg: no packages at all.
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

// === GET quota reminders =================================================

test("GET quota-reminders returns 3 distinct lists (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/quota-reminders/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/quota-reminders?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    exhausted: { studentId: string; studentName: string; primaryGuardianName: string | null; primaryGuardianPhone: string | null; reminderText: string }[];
    makeupNeeded: { studentId: string; studentName: string; reminderText: string }[];
    schedulingNeeded: { studentId: string; studentName: string; unassignedActiveCount: number; reminderText: string }[];
  };

  // List A (exhausted): studentId.
  expect(json.exhausted.length).toBe(1);
  expect(json.exhausted[0]!.studentId).toBe(studentId);
  expect(json.exhausted[0]!.studentName).toBe("Student Exhausted");
  // Guardian full_name is NULL in test setup (createTestUser doesn't set it).
  expect(json.exhausted[0]!.primaryGuardianName).toBeNull();
  // Phone comes from guardian_student_links.contact_phone.
  expect(json.exhausted[0]!.primaryGuardianPhone).toBe("+62 812 3456 7890");
  expect(json.exhausted[0]!.reminderText).toContain("Student Exhausted");
  expect(json.exhausted[0]!.reminderText).toContain("sesi");

  // List B (makeupNeeded): student2Id.
  expect(json.makeupNeeded.length).toBe(1);
  expect(json.makeupNeeded[0]!.studentId).toBe(student2Id);
  expect(json.makeupNeeded[0]!.reminderText).toContain("menunggu makeup");

  // List C (schedulingNeeded): student3Id.
  expect(json.schedulingNeeded.length).toBe(1);
  expect(json.schedulingNeeded[0]!.studentId).toBe(student3Id);
  expect(json.schedulingNeeded[0]!.unassignedActiveCount).toBe(2);
  expect(json.schedulingNeeded[0]!.reminderText).toContain("belum dijadwalkan");
});

test("Student with no package history appears in NONE of the lists (correction #3)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/quota-reminders/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/quota-reminders?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { exhausted: { studentId: string }[]; makeupNeeded: { studentId: string }[]; schedulingNeeded: { studentId: string }[] };
  const allStudentIds = [...json.exhausted, ...json.makeupNeeded, ...json.schedulingNeeded].map((r) => r.studentId);
  expect(allStudentIds).not.toContain(studentNoPkgId);
});

test("Multiple packages for one student do not produce duplicate entries", async () => {
  // Give studentId a second package (also all completed, reusing sv1/slot1
  // from beforeEach — only one active schedule version per class allowed).
  const pkg2 = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkg2, studentId, plan4Id, classId]);
  for (let i = 0; i < 4; i++) {
    const occId = randomUUID();
    const date = `2027-0${(i + 5)}-0${(i + 5)}`;
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, $6, '${date} 15:00:00', '${date} 16:00:00', 'planned', 12);`, [occId, ACADEMY_A_ID, classId, slot1, sv1, date]);
    const eid = randomUUID();
    await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, $3, 'completed', $4, $4);`, [eid, pkg2, i + 1, occId]);
  }

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/quota-reminders/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/quota-reminders?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { exhausted: { studentId: string; completedCount: number }[] };
  // Student appears ONCE in exhausted, with summed completed count = 8.
  const studentExhausted = json.exhausted.filter((r) => r.studentId === studentId);
  expect(studentExhausted.length).toBe(1);
  expect(studentExhausted[0]!.completedCount).toBe(8);
});

test("GET quota-reminders rejects coach (403)", async () => {
  const { s } = await login(coachA.email, coachA.password);
  const { GET } = await import("@/app/api/admin/dashboard/quota-reminders/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/quota-reminders?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});

test("GET quota-reminders is academy-scoped (no cross-academy students)", async () => {
  // Add a student in academy B with completed entitlements (real occurrences).
  const studentB = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B Exhausted');`, [studentB, ACADEMY_B_ID]);
  const classB = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class B', 12);`, [classB, ACADEMY_B_ID]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentB, classB]);
  const planB = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'B Plan', 4);`, [planB, ACADEMY_B_ID]);
  const pkgB = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkgB, studentB, planB, classB]);
  const svB = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [svB, classB]);
  const slotB = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotB, svB]);
  for (let i = 0; i < 4; i++) {
    const occId = randomUUID();
    const date = `2027-0${(i + 1)}-2${(i + 1)}`;
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, $6, '${date} 15:00:00', '${date} 16:00:00', 'planned', 12);`, [occId, ACADEMY_B_ID, classB, slotB, svB, date]);
    const eid = randomUUID();
    await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, $3, 'completed', $4, $4);`, [eid, pkgB, i + 1, occId]);
  }

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/quota-reminders/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/quota-reminders?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { exhausted: { studentId: string }[] };
  expect(json.exhausted.some((r) => r.studentId === studentB)).toBe(false);
});
