/**
 * API integration tests: Parent Makeup Action UI contract (Phase 3).
 *
 * Verifies the API behavior that the MakeupActionDialog component relies on:
 * - Missing Idempotency-Key → 422
 * - Missing CSRF → 403
 * - Makeup on active entitlement → 409 invalid_status
 * - Makeup to full occurrence → 409 destination_full
 * - Makeup with expired session → 401
 * - Successful makeup + schedule refetch shows moveType='makeup'
 * - Retry with same key → replay (no duplicate event)
 * - Same key different body → 409 idempotency_key_reuse
 * - Eligible-occurrences for a skipped entitlement returns destinations
 *
 * Tests are PgLite-backed (single-process — NOT real PostgreSQL concurrency).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  setupTestDb,
  teardownTestDb,
  createTestUser,
  makeRequest,
  ACADEMY_A_ID,
  type TestUser,
} from "../_auth-helpers";
import type { DbClient } from "@/lib/db";
import { sessionCookieName } from "@/lib/auth/session";
import { csrfCookieName, CSRF_HEADER } from "@/lib/auth/csrf";

let db: DbClient;
let parentA: TestUser;
let studentA1: string;
let classId: string;
let versionId: string;
let slotId: string;
let planId: string;
let occ1Id: string;
let occ2Id: string;
let occFullId: string;
let pkgId: string;
let entSkippedId: string;
let entActiveId: string;
let entAwaitingId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);
  studentA1 = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Child A1');`, [studentA1, ACADEMY_A_ID]);
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), parentA.id, studentA1]);
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentA1, classId]);

  versionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, classId]);
  slotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotId, versionId]);

  occ1Id = randomUUID();
  occ2Id = randomUUID();
  occFullId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occ2Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-07-01', '2027-07-01 15:00:00', '2027-07-01 16:00:00', 'planned', 1);`, [occFullId, ACADEMY_A_ID, classId, slotId, versionId]);

  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [planId, ACADEMY_A_ID]);
  pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [pkgId, studentA1, planId, classId]);

  // Active entitlement (eligible for skip/move, NOT makeup)
  entActiveId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3);`, [entActiveId, pkgId, occ1Id]);
  // Skipped entitlement (eligible for makeup)
  entSkippedId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id, skip_used) VALUES ($1, $2, 2, 'skipped', $3, NULL, true);`, [entSkippedId, pkgId, occ1Id]);
  // Awaiting makeup entitlement (eligible for makeup)
  entAwaitingId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 3, 'awaiting_makeup', NULL, NULL);`, [entAwaitingId, pkgId]);
});

afterEach(async () => { await teardownTestDb(); });

async function login(email: string, pw: string): Promise<{ s: string; c: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(await makeRequest("/api/auth/login", { method: "POST", body: { email, password: pw } }));
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  return {
    s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!,
    c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]!,
  };
}
function auth(s: string, c: string, idempotencyKey?: string) {
  const headers: Record<string, string> = { [CSRF_HEADER]: c };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return { cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c }, headers };
}
function noAuth(s: string) { return { cookies: { [sessionCookieName()]: s } }; }
function makeupPath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/makeup?academyId=${ACADEMY_A_ID}`; }
function eligiblePath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/eligible-occurrences?academyId=${ACADEMY_A_ID}`; }

// === Missing Idempotency-Key → 422 =======================================

test("Makeup without Idempotency-Key returns 422", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c), body: { destinationOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(422);
  const json = (await res.json()) as { error: { message: string } };
  expect(json.error.message).toContain("Idempotency-Key");
});

// === Missing CSRF → 403 ===================================================

test("Makeup without CSRF token returns 403", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entSkippedId), {
      method: "POST",
      cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c },
      headers: { "idempotency-key": "key-no-csrf" },
      body: { destinationOccurrenceId: occ2Id },
    }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: { code: string } };
  expect(json.error.code).toBe("CSRF_INVALID");
});

// === Makeup on active entitlement → 409 invalid_status ==================

test("Makeup on active entitlement returns 409 invalid_status", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entActiveId), { method: "POST", ...auth(s, c, "key-invalid-status"), body: { destinationOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("invalid_status");
});

// === Makeup to full occurrence → 409 destination_full ===================

test("Makeup to full occurrence returns 409 destination_full", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Pre-fill occFullId (capacity=1).
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 4, 'active', $3, $3);`, [randomUUID(), pkgId, occFullId]);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-full"), body: { destinationOccurrenceId: occFullId } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("destination_full");
});

// === Session expired → 401 ===============================================

test("Makeup with expired session returns 401", async () => {
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", headers: { "idempotency-key": "key-expired" }, body: { destinationOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(401);
});

// === Successful makeup + schedule refetch shows moveType='makeup' =======

test("Successful makeup → schedule refetch shows moveType='makeup'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) };
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-success"), body: { destinationOccurrenceId: occ2Id, reason: "Catching up" } }),
    ctx,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { operation: string; assignedOccurrenceId: string; status: string; originalOccurrenceId: string };
  expect(json.operation).toBe("makeup");
  expect(json.assignedOccurrenceId).toBe(occ2Id);
  expect(json.status).toBe("active");
  expect(json.originalOccurrenceId).toBe(occ1Id); // original preserved

  // Refetch schedule.
  const { GET: schedGET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const schedRes = await schedGET(
    await makeRequest(`/api/parent/children/${studentA1}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1 }) },
  );
  expect(schedRes.status).toBe(200);
  const schedJson = (await schedRes.json()) as { schedule: { entitlementId: string; moveType: string; status: string; occurrenceId: string; originalOccurrenceId: string }[] };
  const ent = schedJson.schedule.find((e) => e.entitlementId === entSkippedId);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("makeup");
  expect(ent!.status).toBe("active");
  expect(ent!.occurrenceId).toBe(occ2Id);
  expect(ent!.originalOccurrenceId).toBe(occ1Id);
});

// === Retry with same key → replay (no duplicate) =======================

test("Retry makeup with same key + same body → replay (no duplicate event)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) };
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  // First makeup.
  const res1 = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-retry"), body: { destinationOccurrenceId: occ2Id } }),
    ctx,
  );
  expect(res1.status).toBe(200);

  // Retry with SAME key + SAME body.
  const res2 = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-retry"), body: { destinationOccurrenceId: occ2Id } }),
    ctx,
  );
  expect(res2.status).toBe(200);

  // Only 1 makeup_assigned event.
  const events = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'makeup_assigned';`, [entSkippedId]);
  expect((events.rows[0] as { c: number }).c).toBe(1);

  // Only 1 idempotency record.
  const records = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'key-retry';`, [entSkippedId]);
  expect((records.rows[0] as { c: number }).c).toBe(1);
});

// === Same key different body → 409 idempotency_key_reuse ===============

test("Makeup with same key but different destination returns 409 idempotency_key_reuse", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) };
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  // First: makeup to occ2.
  await POST(await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-reuse"), body: { destinationOccurrenceId: occ2Id } }), ctx);
  // Reset ent back to skipped for the second attempt.
  await db.query(`UPDATE session_entitlements SET status = 'skipped', assigned_occurrence_id = NULL, updated_at = now() WHERE id = $1;`, [entSkippedId]);
  // Same key, different destination.
  const res = await POST(await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-reuse"), body: { destinationOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("idempotency_key_reuse");
});

// === Eligible-occurrences for a skipped entitlement =====================

test("Eligible occurrences for skipped entitlement returns future same-class (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(eligiblePath(entSkippedId), noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string; availableSeats: number }[] };
  const ids = json.occurrences.map((o) => o.id);
  expect(ids).toContain(occ1Id);
  expect(ids).toContain(occ2Id);
  expect(ids).toContain(occFullId);
});

// === Makeup on awaiting_makeup entitlement → 200 ========================

test("Makeup on awaiting_makeup entitlement succeeds (200)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entAwaitingId), { method: "POST", ...auth(s, c, "key-awaiting"), body: { destinationOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entAwaitingId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { status: string; assignedOccurrenceId: string };
  expect(json.status).toBe("active");
  expect(json.assignedOccurrenceId).toBe(occ2Id);
});

// === Makeup: occurrence not planned → 409 occurrence_not_planned ============

test("Makeup to cancelled occurrence returns 409 occurrence_not_planned", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const cancelledOccId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-08-01', '2027-08-01 15:00:00', '2027-08-01 16:00:00', 'cancelled', 12);`, [cancelledOccId, ACADEMY_A_ID, classId, slotId, versionId]);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-mk-cancelled"), body: { destinationOccurrenceId: cancelledOccId } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("occurrence_not_planned");
});

// === Makeup: obsolete version → 409 obsolete_version ====================

test("Makeup to occurrence from obsolete schedule version returns 409 obsolete_version", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const obsoleteVersionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'superseded');`, [obsoleteVersionId, classId]);
  const obsoleteOccId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-09-01', '2027-09-01 15:00:00', '2027-09-01 16:00:00', 'planned', 12);`, [obsoleteOccId, ACADEMY_A_ID, classId, slotId, obsoleteVersionId]);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entSkippedId), { method: "POST", ...auth(s, c, "key-mk-obsolete"), body: { destinationOccurrenceId: obsoleteOccId } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("obsolete_version");
});
