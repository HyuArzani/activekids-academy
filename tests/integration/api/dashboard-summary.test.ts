/**
 * API integration tests: Dashboard summary (Stage 6A).
 * Tests route handlers against in-memory PgLite. NOT real PostgreSQL.
 *
 * "Today" is computed via the academy's timezone (Asia/Jakarta) using
 * the Intl API, matching the domain's `computeDateBoundaries`. Tests
 * insert data with the SAME dynamically-computed date so they pass
 * regardless of when they run.
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
let mustChangeAdmin: TestUser;
let classId: string;
let slotId: string;
let versionId: string;
let planId: string;
let studentId: string;
let student2Id: string;
let studentBId: string;

/** Compute today's date (YYYY-MM-DD) in Asia/Jakarta — matches the domain. */
function todayJakarta(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/** First day of current Jakarta month. */
function monthStartJakarta(): string {
  const t = todayJakarta();
  return `${t.slice(0, 8)}01`;
}

/** First day of next Jakarta month (exclusive upper bound). */
function monthEndJakarta(): string {
  const t = todayJakarta();
  const y = parseInt(t.slice(0, 4), 10);
  const m = parseInt(t.slice(5, 7), 10);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return `${String(nextY).padStart(4, "0")}-${String(nextM).padStart(2, "0")}-01`;
}

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  mustChangeAdmin = await createTestUser(db, { email: "mustchange@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID, mustChangePassword: true });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);

  studentId = randomUUID();
  student2Id = randomUUID();
  studentBId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B2');`, [student2Id, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B Academy');`, [studentBId, ACADEMY_B_ID]);

  // Schedule version + slot for academy A.
  versionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, classId]);
  slotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotId, versionId]);

  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Plan 4', 4);`, [planId, ACADEMY_A_ID]);
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

// Helper: create a training occurrence on a given date with a given status.
// Creates a unique schedule_slot per call to avoid UNIQUE(slot, date) collisions.
async function createOccurrence(date: string, status: "planned" | "cancelled" = "planned"): Promise<string> {
  const occSlot = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 4, '17:00', '18:00');`, [occSlot, versionId]);
  const id = randomUUID();
  await db.query(
    `INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, $6, '${date} 15:00:00', '${date} 16:00:00', $7, 12);`,
    [id, ACADEMY_A_ID, classId, occSlot, versionId, date, status],
  );
  return id;
}

// Helper: enroll a student (effective_from, optional effective_to).
async function enroll(student: string, effectiveFrom: string, effectiveTo: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5);`,
    [randomUUID(), student, classId, effectiveFrom, effectiveTo],
  );
}

// Helper: record attendance for a student at an occurrence.
async function recordAtt(occId: string, student: string, status: "present" | "absent" | "excused" | "late"): Promise<void> {
  await db.query(
    `INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, legacy_status, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6);`,
    [randomUUID(), occId, student, status === "late" ? "present" : status, status === "late" ? "late" : null, adminA.id],
  );
}

// Helper: create a package + N entitlements with given statuses.
async function createPackage(student: string, statuses: ("active" | "completed" | "skipped" | "awaiting_makeup" | "cancelled")[]): Promise<string> {
  const pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4);`, [pkgId, student, planId, classId]);
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i]!;
    const eid = randomUUID();
    if (s === "completed") {
      const occId = await createOccurrence(`2027-0${i + 1}-0${i + 1}`, "planned");
      await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, $3, 'completed', $4, $4);`, [eid, pkgId, i + 1, occId]);
    } else if (s === "skipped") {
      await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, skip_used) VALUES ($1, $2, $3, 'skipped', TRUE);`, [eid, pkgId, i + 1]);
    } else if (s === "active") {
      await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, $3, 'active');`, [eid, pkgId, i + 1]);
    } else {
      await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, $3, $4);`, [eid, pkgId, i + 1, s]);
    }
  }
  return pkgId;
}

// === 1. Shape + correct counts ==========================================

test("GET summary returns expected shape + correct counts (200)", async () => {
  const today = todayJakarta();
  const mStart = monthStartJakarta();

  // Student A: enrolled (active). Student B2: starts today.
  await enroll(studentId, "2026-01-01");
  await enroll(student2Id, today);

  // Today's occurrence + attendance.
  const occId = await createOccurrence(today, "planned");
  await recordAtt(occId, studentId, "present");
  await recordAtt(occId, student2Id, "late");

  // Packages: A has 2 active + 1 completed (usable). B2 has 4 completed (exhausted).
  await createPackage(studentId, ["active", "active", "completed"]);
  await createPackage(student2Id, ["completed", "completed", "completed", "completed"]);

  // This month's payment + expense.
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash) VALUES ($1, $2, $3, $4, 400000, 'IDR', 'confirmed', $3, now(), 'Budi', 'cash', $5, $3, $6, $7);`, [randomUUID(), ACADEMY_A_ID, adminA.id, studentId, mStart, `k-${randomUUID()}`, "h1"]);
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'field_rent', 500000, 'IDR', $3, $4);`, [randomUUID(), ACADEMY_A_ID, mStart, adminA.id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    today: string; monthStart: string; monthEnd: string;
    students: { currentlyEnrolled: number; startingToday: number };
    sessions: { scheduledToday: number; attendanceToday: { present: number; absent: number; excused: number; late: number } };
    packages: { withUsableSessions: number; exhausted: number };
    entitlements: { awaitingMakeup: number; unassignedActive: number };
    finances: { monthPaymentTotal: string; monthExpenseTotal: string };
  };

  expect(json.today).toBe(today);
  expect(json.monthStart).toBe(mStart);
  expect(json.monthEnd).toBe(monthEndJakarta());
  expect(json.students.currentlyEnrolled).toBe(2); // A + B2 both active today
  expect(json.students.startingToday).toBe(1); // B2 starts today
  expect(json.sessions.scheduledToday).toBe(1); // one planned occurrence today
  expect(json.sessions.attendanceToday.present).toBe(1);
  expect(json.sessions.attendanceToday.late).toBe(1);
  expect(json.sessions.attendanceToday.absent).toBe(0);
  expect(json.sessions.attendanceToday.excused).toBe(0);
  expect(json.packages.withUsableSessions).toBe(1); // studentId's package
  expect(json.packages.exhausted).toBe(1); // student2Id's package
  expect(json.entitlements.unassignedActive).toBe(2); // studentId's 2 active (unassigned)
  expect(json.entitlements.awaitingMakeup).toBe(0);
  expect(json.finances.monthPaymentTotal).toBe("400000.00");
  expect(json.finances.monthExpenseTotal).toBe("500000.00");
});

// === 2. Non-Admin rejected ==============================================

test("GET summary rejects coach (403)", async () => {
  const { s } = await login(coachA.email, coachA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});

// === 3. Missing/invalid academyId ======================================

test("GET summary rejects missing academyId (422)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(422);
});

test("GET summary rejects non-member academy (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  // adminA is a member of A only — requesting B is forbidden.
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_B_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});

// === 4. Cross-academy records excluded =================================

test("Cross-academy records are excluded from counts", async () => {
  const today = todayJakarta();
  // Academy B: student, occurrence, payment, expense.
  const classB = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class B', 12);`, [classB, ACADEMY_B_ID]);
  const svB = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [svB, classB]);
  const slotB = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotB, svB]);
  await enroll(studentBId, "2026-01-01");
  const occB = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, $6, '${today} 15:00:00', '${today} 16:00:00', 'planned', 12);`, [occB, ACADEMY_B_ID, classB, slotB, svB, today]);
  await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by) VALUES ($1, $2, $3, 'present', $4);`, [randomUUID(), occB, studentBId, adminA.id]);
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash) VALUES ($1, $2, $3, $4, 999999, 'IDR', 'confirmed', $3, now(), 'B Payer', 'cash', $5, $3, $6, $7);`, [randomUUID(), ACADEMY_B_ID, adminA.id, studentBId, today, `k-${randomUUID()}`, "hb"]);
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'field_rent', 888888, 'IDR', $3, $4);`, [randomUUID(), ACADEMY_B_ID, today, adminA.id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { students: { currentlyEnrolled: number }; sessions: { scheduledToday: number }; finances: { monthPaymentTotal: string; monthExpenseTotal: string } };
  // Academy A has no students enrolled, no occurrences, no payments/expenses.
  expect(json.students.currentlyEnrolled).toBe(0);
  expect(json.sessions.scheduledToday).toBe(0);
  expect(json.finances.monthPaymentTotal).toBe("0.00");
  expect(json.finances.monthExpenseTotal).toBe("0.00");
});

// === 5. Forced password change enforced =================================

test("GET summary enforces must_change_password (426)", async () => {
  const { s } = await login(mustChangeAdmin.email, mustChangeAdmin.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(426);
});

// === 6. Cancelled occurrences not counted ===============================

test("Cancelled occurrences are not counted as scheduled today", async () => {
  const today = todayJakarta();
  await enroll(studentId, "2026-01-01");
  await createOccurrence(today, "planned");
  await createOccurrence(today, "cancelled"); // excluded

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { sessions: { scheduledToday: number } };
  expect(json.sessions.scheduledToday).toBe(1); // only the planned one
});

// === 7. Joins do not inflate counts ====================================

test("Multiple joins do not inflate attendance/student/payment/expense totals", async () => {
  const today = todayJakarta();
  const mStart = monthStartJakarta();
  await enroll(studentId, "2026-01-01");

  // One occurrence today. Two attendance records (present + late).
  const occId = await createOccurrence(today, "planned");
  await recordAtt(occId, studentId, "present");
  await recordAtt(occId, student2Id, "late");

  // One payment with TWO allocations (to test allocation doesn't inflate payment sum).
  await enroll(student2Id, "2026-01-01");
  const pkg1 = await createPackage(studentId, ["active"]);
  const pkg2 = await createPackage(student2Id, ["active"]);
  const payId = randomUUID();
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash) VALUES ($1, $2, $3, $4, 400000, 'IDR', 'confirmed', $3, now(), 'Budi', 'cash', $5, $3, $6, $7);`, [payId, ACADEMY_A_ID, adminA.id, studentId, mStart, `k-${randomUUID()}`, "h1"]);
  await db.query(`INSERT INTO payment_allocations (id, payment_id, student_package_id, amount) VALUES ($1, $2, $3, 200000);`, [randomUUID(), payId, pkg1]);
  await db.query(`INSERT INTO payment_allocations (id, payment_id, student_package_id, amount) VALUES ($1, $2, $3, 200000);`, [randomUUID(), payId, pkg2]);
  // Two expenses (to verify SUM is correct, not multiplied).
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'field_rent', 100000, 'IDR', $3, $4);`, [randomUUID(), ACADEMY_A_ID, mStart, adminA.id]);
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'ops', 50000, 'IDR', $3, $4);`, [randomUUID(), ACADEMY_A_ID, mStart, adminA.id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as {
    students: { currentlyEnrolled: number };
    sessions: { attendanceToday: { present: number; late: number } };
    finances: { monthPaymentTotal: string; monthExpenseTotal: string };
  };
  // 2 students enrolled (not inflated by 2 allocations).
  expect(json.students.currentlyEnrolled).toBe(2);
  // 1 present + 1 late (not inflated by joins).
  expect(json.sessions.attendanceToday.present).toBe(1);
  expect(json.sessions.attendanceToday.late).toBe(1);
  // Payment sum = 400000 (the payment amount), NOT 400000 * 2 allocations.
  expect(json.finances.monthPaymentTotal).toBe("400000.00");
  // Expense sum = 150000 (100k + 50k), NOT multiplied.
  expect(json.finances.monthExpenseTotal).toBe("150000.00");
});

// === 8. Monthly boundaries (Jakarta calendar month) ====================

test("Monthly totals use Jakarta calendar-month boundaries [start, end)", async () => {
  const today = todayJakarta();
  const mStart = monthStartJakarta();
  const mEnd = monthEndJakarta();

  // Payment IN the current month (on mStart).
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash) VALUES ($1, $2, $3, $4, 100000, 'IDR', 'confirmed', $3, now(), 'In', 'cash', $5, $3, $6, $7);`, [randomUUID(), ACADEMY_A_ID, adminA.id, studentId, mStart, `k-in-${randomUUID()}`, "hi"]);
  // Payment BEFORE the current month (day before mStart — excluded).
  const bDate = new Date(mStart + "T00:00:00Z");
  bDate.setUTCDate(bDate.getUTCDate() - 1);
  const beforeStr = bDate.toISOString().slice(0, 10);
  await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash) VALUES ($1, $2, $3, $4, 999999, 'IDR', 'confirmed', $3, now(), 'Before', 'cash', $5, $3, $6, $7);`, [randomUUID(), ACADEMY_A_ID, adminA.id, studentId, beforeStr, `k-before-${randomUUID()}`, "hb"]);

  // Expense ON mEnd — excluded (exclusive upper bound).
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'field_rent', 777777, 'IDR', $3, $4);`, [randomUUID(), ACADEMY_A_ID, mEnd, adminA.id]);
  // Expense IN the month (today, included).
  await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1, $2, 'ops', 200000, 'IDR', $3, $4);`, [randomUUID(), ACADEMY_A_ID, today, adminA.id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { finances: { monthPaymentTotal: string; monthExpenseTotal: string }; monthStart: string; monthEnd: string };
  // Payment: only the in-month one (100000); the before-month one excluded.
  expect(json.finances.monthPaymentTotal).toBe("100000.00");
  // Expense: only the in-month one (200000); the mEnd one excluded.
  expect(json.finances.monthExpenseTotal).toBe("200000.00");
  expect(json.monthStart).toBe(mStart);
  expect(json.monthEnd).toBe(mEnd);
});

// === 9. No database mutation ===========================================

test("GET summary does not mutate database records", async () => {
  const today = todayJakarta();
  await enroll(studentId, "2026-01-01");
  const occId = await createOccurrence(today, "planned");
  await recordAtt(occId, studentId, "present");

  // Snapshot row counts before.
  const beforeCounts = await db.query<{ p: number; e: number; a: number; ar: number }>(
    `SELECT
      (SELECT COUNT(*)::int FROM payments WHERE academy_id = $1) AS p,
      (SELECT COUNT(*)::int FROM academy_expenses WHERE academy_id = $1) AS e,
      (SELECT COUNT(*)::int FROM audit_events WHERE academy_id = $1) AS a,
      (SELECT COUNT(*)::int FROM attendance_records) AS ar;`,
    [ACADEMY_A_ID],
  );
  const b = beforeCounts.rows[0] as { p: number; e: number; a: number; ar: number };

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);

  // Snapshot after — no change.
  const afterCounts = await db.query<{ p: number; e: number; a: number; ar: number }>(
    `SELECT
      (SELECT COUNT(*)::int FROM payments WHERE academy_id = $1) AS p,
      (SELECT COUNT(*)::int FROM academy_expenses WHERE academy_id = $1) AS e,
      (SELECT COUNT(*)::int FROM audit_events WHERE academy_id = $1) AS a,
      (SELECT COUNT(*)::int FROM attendance_records) AS ar;`,
    [ACADEMY_A_ID],
  );
  const a = afterCounts.rows[0] as { p: number; e: number; a: number; ar: number };
  expect(a.p).toBe(b.p);
  expect(a.e).toBe(b.e);
  expect(a.a).toBe(b.a); // no audit writes
  expect(a.ar).toBe(b.ar);
});

// === startingToday verification (Stage 6B.2 Part 1) ====================

test("startingToday excludes archived students", async () => {
  const today = todayJakarta();
  // Student A: not archived, enrollment starts today → counted.
  await enroll(studentId, today);
  // Student B2: archived, enrollment starts today → NOT counted.
  await enroll(student2Id, today);
  await db.query(`UPDATE students SET archived_at = now() WHERE id = $1;`, [student2Id]);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { students: { startingToday: number; currentlyEnrolled: number } };
  expect(json.students.startingToday).toBe(1); // only studentId (non-archived)
  expect(json.students.currentlyEnrolled).toBe(1); // archived excluded from enrolled too
});

test("startingToday requires effective_from = today (not yesterday, not tomorrow)", async () => {
  const today = todayJakarta();
  // Yesterday — not starting today.
  const yesterday = new Date(today + "T00:00:00Z");
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  await enroll(studentId, yesterday.toISOString().slice(0, 10));
  // Tomorrow — not starting today.
  const tomorrow = new Date(today + "T00:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await enroll(student2Id, tomorrow.toISOString().slice(0, 10));

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { students: { startingToday: number } };
  expect(json.students.startingToday).toBe(0);
});

test("startingToday uses Jakarta timezone (effective_from matches academy-local date)", async () => {
  // This test verifies that the domain computes "today" in Asia/Jakarta,
  // not UTC. We insert an enrollment with effective_from = todayJakarta().
  // If the domain used UTC, the date might differ (Jakarta is UTC+7).
  const today = todayJakarta();
  await enroll(studentId, today);

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { today: string; students: { startingToday: number } };
  // The API's "today" field should match the Jakarta-computed date.
  expect(json.today).toBe(today);
  expect(json.students.startingToday).toBe(1);
});

test("startingToday does not inflate from multiple enrollment records", async () => {
  const today = todayJakarta();
  // Create TWO enrollment rows for the same student with effective_from = today.
  // (This violates the partial UNIQUE on active enrollments, so the second
  // must have effective_to set to avoid the unique constraint.)
  await enroll(studentId, today, null); // active
  await enroll(studentId, today, today); // ended same-day (different row, same effective_from)

  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/dashboard/summary/route");
  const res = await GET(await makeRequest(`/api/admin/dashboard/summary?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { students: { startingToday: number } };
  // COUNT(DISTINCT student_id) → 1, not 2.
  expect(json.students.startingToday).toBe(1);
});
