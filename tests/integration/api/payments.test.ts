/**
 * API integration tests: Payments (Stage 5 manual workflow).
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
let guardianA: TestUser;
let classId: string;
let studentId: string;
let studentBId: string;
let plan4Id: string;
let plan8Id: string;
let versionId: string;
let slotId: string;
let occId1: string;
let occId2: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
  guardianA = await createTestUser(db, { email: "guardian-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);

  studentId = randomUUID();
  studentBId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`, [studentBId, ACADEMY_B_ID]);

  // Enroll student in class (effective from a past date so occurrences are eligible).
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentId, classId]);

  // Link guardian to student (primary).
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship, contact_phone) VALUES ($1, $2, $3, TRUE, 'father', '+62 812 3456 7890');`, [randomUUID(), guardianA.id, studentId]);

  plan4Id = randomUUID();
  plan8Id = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [plan4Id, ACADEMY_A_ID]);
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Standard 8', 8);`, [plan8Id, ACADEMY_A_ID]);

  // Schedule version + slot + occurrences.
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

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    studentId,
    packagePlanId: plan4Id,
    amount: 400000,
    paymentMethod: "cash" as const,
    paymentDate: "2027-06-01",
    payerName: "Budi Guardian",
    idempotencyKey: `key-${randomUUID()}`,
    ...overrides,
  };
}

// === POST record payment =================================================

test("POST payment (cash, manual payer) creates payment + package + N entitlements + audit (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody(), ...auth(s, c) }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { paymentId: string; packageId: string; entitlementIds: string[]; message: string; replayed: boolean };
  expect(json.paymentId).toBeTruthy();
  expect(json.entitlementIds.length).toBe(4);
  expect(json.replayed).toBe(false);

  // Verify payment row.
  const p = await db.query<{ status: string; payment_method: string; payer_name: string | null; recorded_by: string }>(`SELECT status, payment_method, payer_name, recorded_by FROM payments WHERE id = $1;`, [json.paymentId]);
  const prow = p.rows[0] as { status: string; payment_method: string; payer_name: string | null; recorded_by: string };
  expect(prow.status).toBe("confirmed");
  expect(prow.payment_method).toBe("cash");
  expect(prow.payer_name).toBe("Budi Guardian");
  expect(prow.recorded_by).toBe(adminA.id);

  // Verify allocation.
  const alloc = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM payment_allocations WHERE payment_id = $1;`, [json.paymentId]);
  expect((alloc.rows[0] as { c: number }).c).toBe(1);

  // Verify entitlement count.
  const ent = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1;`, [json.packageId]);
  expect((ent.rows[0] as { c: number }).c).toBe(4);

  // Verify audit.
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'payment.record' AND target_id = $1;`, [json.paymentId]);
  expect((audit.rows[0] as { c: number }).c).toBe(1);

  // Verify message contains expected content.
  expect(json.message).toContain("Konfirmasi Pembayaran");
  expect(json.message).toContain("Student A");
  expect(json.message).toContain("Starter 4");
  expect(json.message).toContain("belum dijadwalkan");
});

test("POST payment (bank transfer, linked guardian payer) (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ paymentMethod: "bank_transfer", payerGuardianUserId: guardianA.id, payerName: undefined, referenceNumber: "TRX-001" }), ...auth(s, c) }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { paymentId: string };
  const p = await db.query<{ payer_user_id: string | null; payer_name: string | null; reference_number: string | null }>(`SELECT payer_user_id, payer_name, reference_number FROM payments WHERE id = $1;`, [json.paymentId]);
  const prow = p.rows[0] as { payer_user_id: string | null; payer_name: string | null; reference_number: string | null };
  expect(prow.payer_user_id).toBe(guardianA.id);
  expect(prow.payer_name).toBeNull();
  expect(prow.reference_number).toBe("TRX-001");
});

test("POST payment rejects zero amount (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ amount: 0 }), ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST payment rejects negative amount (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ amount: -100 }), ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST payment rejects missing payer (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ payerName: undefined }), ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST payment rejects both payer sources (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ payerGuardianUserId: guardianA.id, payerName: "Also Name" }), ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST payment rejects missing idempotencyKey (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ idempotencyKey: undefined }), ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST payment rejects cross-academy student (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ studentId: studentBId }), ...auth(s, c) }));
  expect(res.status).toBe(404);
});

test("POST payment rejects coach (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody(), ...auth(s, c) }));
  expect(res.status).toBe(403);
});

test("POST payment rejects parent (403)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody(), ...auth(s, c) }));
  expect(res.status).toBe(403);
});

test("POST payment rejects without CSRF (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody(), cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});

// === Idempotency =========================================================

test("Idempotency: same key + same body returns original, no duplicates (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const body = baseBody();
  const res1 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body, ...auth(s, c) }));
  expect(res1.status).toBe(201);
  const json1 = (await res1.json()) as { paymentId: string; entitlementIds: string[] };
  const res2 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body, ...auth(s, c) }));
  expect(res2.status).toBe(200);
  const json2 = (await res2.json()) as { paymentId: string; entitlementIds: string[]; replayed: boolean };
  expect(json2.paymentId).toBe(json1.paymentId);
  expect(json2.entitlementIds).toEqual(json1.entitlementIds);
  expect(json2.replayed).toBe(true);
  // No duplicate payments, packages, or entitlements.
  const payCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM payments WHERE idempotency_key = $1;`, [body.idempotencyKey]);
  expect((payCount.rows[0] as { c: number }).c).toBe(1);
  const entCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1;`, [json1.paymentId]);
  // entitlements tied to package, not payment — verify total entitlements for student = 4
  const totalEnt = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements e JOIN student_packages sp ON sp.id = e.student_package_id WHERE sp.student_id = $1;`, [studentId]);
  expect((totalEnt.rows[0] as { c: number }).c).toBe(4);
});

test("Idempotency: same key + different body returns 409", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const key = `key-${randomUUID()}`;
  const body1 = baseBody({ idempotencyKey: key, amount: 400000 });
  const res1 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: body1, ...auth(s, c) }));
  expect(res1.status).toBe(201);
  const body2 = baseBody({ idempotencyKey: key, amount: 500000 }); // different amount → different hash
  const res2 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: body2, ...auth(s, c) }));
  expect(res2.status).toBe(409);
  const json2 = (await res2.json()) as { error: { code: string } };
  expect(json2.error.code).toBe("CONFLICT");
});

test("Idempotency: different key with same body creates separate payments (201 each)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res1 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ idempotencyKey: "key-A" }), ...auth(s, c) }));
  expect(res1.status).toBe(201);
  const res2 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ idempotencyKey: "key-B" }), ...auth(s, c) }));
  expect(res2.status).toBe(201);
  const json1 = (await res1.json()) as { paymentId: string };
  const json2 = (await res2.json()) as { paymentId: string };
  expect(json1.paymentId).not.toBe(json2.paymentId);
});

// === Rollback ============================================================

test("Rollback: failed package purchase leaves no payment/allocation/entitlements/audit", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  // Use an invalid packagePlanId (cross-academy) to force failure after payment INSERT.
  const otherPlan = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'B Plan', 4);`, [otherPlan, ACADEMY_B_ID]);
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody({ packagePlanId: otherPlan }), ...auth(s, c) }));
  expect(res.status).toBe(404); // plan not found in academy A
  // Verify NO payment, allocation, package, entitlement, or audit was created.
  const payCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM payments WHERE recorded_by = $1;`, [adminA.id]);
  expect((payCount.rows[0] as { c: number }).c).toBe(0);
  const allocCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM payment_allocations;`);
  expect((allocCount.rows[0] as { c: number }).c).toBe(0);
  const pkgCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM student_packages WHERE student_id = $1;`, [studentId]);
  expect((pkgCount.rows[0] as { c: number }).c).toBe(0);
  const entCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements;`);
  expect((entCount.rows[0] as { c: number }).c).toBe(0);
  const auditCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'payment.record';`);
  expect((auditCount.rows[0] as { c: number }).c).toBe(0);
});

// === Message endpoint ===================================================

test("GET message returns Indonesian text with real assigned dates + 'belum dijadwalkan'", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const rec = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody(), ...auth(s, c) }));
  const recJson = (await rec.json()) as { paymentId: string; packageId: string; entitlementIds: string[] };

  // Assign 2 of 4 entitlements to occurrences.
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [recJson.entitlementIds[0]!, occId1]);
  await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [recJson.entitlementIds[1]!, occId2]);

  const { GET } = await import("@/app/api/admin/payments/[id]/message/route");
  const res = await GET(await makeRequest(`/api/admin/payments/${recJson.paymentId}/message?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: recJson.paymentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { message: string };
  expect(json.message).toContain("Sesi 1:");
  expect(json.message).toContain("16 Jun 2027");
  expect(json.message).toContain("Sesi 3: (belum dijadwalkan)");
  expect(json.message).toContain("Sesi 4: (belum dijadwalkan)");
  expect(json.message).toContain("Rp");
  expect(json.message).toContain("Terima kasih");
  // No fabricated dates for unassigned.
  expect(json.message).not.toContain("Sesi 3: 2027");
});

test("GET message rejects cross-academy (404)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/[id]/message/route");
  const res = await GET(await makeRequest(`/api/admin/payments/${randomUUID()}/message?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: randomUUID() }) });
  expect(res.status).toBe(404);
});

// === GET detail + list ==================================================

test("GET payment detail returns record (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const rec = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody(), ...auth(s, c) }));
  const recJson = (await rec.json()) as { paymentId: string };

  const { GET } = await import("@/app/api/admin/payments/[id]/route");
  const res = await GET(await makeRequest(`/api/admin/payments/${recJson.paymentId}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: recJson.paymentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { payment: { studentName: string; packageName: string; sessionCount: number; paymentMethod: string } };
  expect(json.payment.studentName).toBe("Student A");
  expect(json.payment.packageName).toBe("Starter 4");
  expect(json.payment.sessionCount).toBe(4);
  expect(json.payment.paymentMethod).toBe("cash");
});

test("GET payment list by student (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { method: "POST", body: baseBody(), ...auth(s, c) }));

  const { GET } = await import("@/app/api/admin/payments/route");
  const res = await GET(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}&studentId=${studentId}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { payments: { id: string }[] };
  expect(json.payments.length).toBe(1);
});

test("GET payment list rejects missing studentId (422)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/payments/route");
  const res = await GET(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(422);
});

// === Payer validation: unlinked guardian (Stage 5.1 gap) ===============

test("POST payment rejects guardian not linked to the student (404) + no records created", async () => {
  // guardianA is linked to studentId (from beforeEach). Create a SECOND
  // student in academy A and DON'T link guardianA to it.
  const otherStudentId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Other Student');`, [otherStudentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), otherStudentId, classId]);

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  // Use guardianA.id as payerGuardianUserId but target otherStudentId
  // (guardian is NOT linked to otherStudentId).
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: baseBody({ studentId: otherStudentId, payerGuardianUserId: guardianA.id, payerName: undefined }),
    ...auth(s, c),
  }));
  expect(res.status).toBe(404);

  // Verify NO records were created.
  const payCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM payments WHERE student_id = $1;`, [otherStudentId]);
  expect((payCount.rows[0] as { c: number }).c).toBe(0);
  const allocCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM payment_allocations;`);
  expect((allocCount.rows[0] as { c: number }).c).toBe(0);
  const pkgCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM student_packages WHERE student_id = $1;`, [otherStudentId]);
  expect((pkgCount.rows[0] as { c: number }).c).toBe(0);
  const entCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements e JOIN student_packages sp ON sp.id = e.student_package_id WHERE sp.student_id = $1;`, [otherStudentId]);
  expect((entCount.rows[0] as { c: number }).c).toBe(0);
  const auditCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'payment.record';`);
  expect((auditCount.rows[0] as { c: number }).c).toBe(0);
});

// === Notes persistence (Stage 5.1) ======================================

test("POST payment persists notes in the same tx (201) + notes returned in detail", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: baseBody({ notes: "First payment from this guardian" }),
    ...auth(s, c),
  }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { paymentId: string };

  // Verify notes persisted in the DB.
  const payRow = await db.query<{ notes: string | null }>(`SELECT notes FROM payments WHERE id = $1;`, [json.paymentId]);
  expect((payRow.rows[0] as { notes: string | null }).notes).toBe("First payment from this guardian");

  // Verify notes returned in GET detail.
  const { GET } = await import("@/app/api/admin/payments/[id]/route");
  const detailRes = await GET(await makeRequest(`/api/admin/payments/${json.paymentId}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: json.paymentId }) });
  const detailJson = (await detailRes.json()) as { payment: { notes: string | null } };
  expect(detailJson.payment.notes).toBe("First payment from this guardian");
});

test("Idempotent replay does NOT overwrite original notes", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const key = `notes-key-${randomUUID()}`;
  // First request with notes "Original note".
  const res1 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: baseBody({ idempotencyKey: key, notes: "Original note" }),
    ...auth(s, c),
  }));
  expect(res1.status).toBe(201);
  const json1 = (await res1.json()) as { paymentId: string };

  // Replay with the SAME body (same notes) — idempotent, returns original.
  const res2 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: baseBody({ idempotencyKey: key, notes: "Original note" }),
    ...auth(s, c),
  }));
  expect(res2.status).toBe(200);
  const json2 = (await res2.json()) as { paymentId: string; replayed: boolean };
  expect(json2.paymentId).toBe(json1.paymentId);
  expect(json2.replayed).toBe(true);

  // Notes unchanged.
  const payRow = await db.query<{ notes: string | null }>(`SELECT notes FROM payments WHERE id = $1;`, [json1.paymentId]);
  expect((payRow.rows[0] as { notes: string | null }).notes).toBe("Original note");
});

test("Idempotency: same key + different notes returns 409 (notes in body hash)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  const key = `notes-409-${randomUUID()}`;
  const res1 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: baseBody({ idempotencyKey: key, notes: "Note A" }),
    ...auth(s, c),
  }));
  expect(res1.status).toBe(201);

  // Same key, different notes → different body hash → 409.
  const res2 = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: baseBody({ idempotencyKey: key, notes: "Note B" }),
    ...auth(s, c),
  }));
  expect(res2.status).toBe(409);
});

test("GET payment detail returns null notes when none provided (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/payments/route");
  // No notes in body.
  const res = await POST(await makeRequest(`/api/admin/payments?academyId=${ACADEMY_A_ID}`, {
    method: "POST",
    body: baseBody(),
    ...auth(s, c),
  }));
  const json = (await res.json()) as { paymentId: string };

  const { GET } = await import("@/app/api/admin/payments/[id]/route");
  const detailRes = await GET(await makeRequest(`/api/admin/payments/${json.paymentId}?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: json.paymentId }) });
  const detailJson = (await detailRes.json()) as { payment: { notes: string | null } };
  expect(detailJson.payment.notes).toBeNull();
});
