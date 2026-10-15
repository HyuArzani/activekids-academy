/**
 * API integration tests: Parent Move Action UI contract (Phase 2).
 *
 * Verifies the API behavior that the MoveActionDialog component relies on:
 * - Missing Idempotency-Key → 422
 * - Missing CSRF → 403
 * - Stale assignment → 409 stale_assignment
 * - Destination full → 409 destination_full
 * - Move limit exceeded → 409 move_limit_exceeded
 * - Past occurrence → 409 past_occurrence
 * - Idempotency key reuse → 409 idempotency_key_reuse
 * - Session expired → 401
 * - Successful move + schedule refetch shows moveType='moved'
 * - Retry with same key → replay (no duplicate event)
 * - Eligible-occurrences endpoint returns correct data
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
let occPastId: string;
let occFullId: string;
let pkgId: string;
let entActiveId: string;

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
  occPastId = randomUUID();
  occFullId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occ2Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2024-01-01', '2024-01-01 15:00:00', '2024-01-01 16:00:00', 'planned', 12);`, [occPastId, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-07-01', '2027-07-01 15:00:00', '2027-07-01 16:00:00', 'planned', 1);`, [occFullId, ACADEMY_A_ID, classId, slotId, versionId]);

  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [planId, ACADEMY_A_ID]);
  pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [pkgId, studentA1, planId, classId]);

  entActiveId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3);`, [entActiveId, pkgId, occ1Id]);
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
function movePath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/move?academyId=${ACADEMY_A_ID}`; }
function eligiblePath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/eligible-occurrences?academyId=${ACADEMY_A_ID}`; }

// === Eligible-occurrences endpoint =======================================

test("Eligible occurrences for move returns future same-class occurrences (200)", async () => {
  const { s } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(eligiblePath(entActiveId), noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string; availableSeats: number; capacity: number }[] };
  const ids = json.occurrences.map((o) => o.id);
  expect(ids).toContain(occ1Id);
  expect(ids).toContain(occ2Id);
  expect(ids).toContain(occFullId);
  expect(ids).not.toContain(occPastId);
});

test("Eligible occurrences rejects wrong guardian (404)", async () => {
  const wrongParent = await createTestUser(db, { email: "wrong@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
  const { s } = await login(wrongParent.email, wrongParent.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(eligiblePath(entActiveId), noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(404);
});

// === Move: missing Idempotency-Key → 422 =================================

test("Move without Idempotency-Key returns 422", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(422);
});

// === Move: missing CSRF → 403 ============================================

test("Move without CSRF token returns 403", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), {
      method: "POST",
      cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c },
      headers: { "idempotency-key": "key-no-csrf" },
      body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id },
    }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: { code: string } };
  expect(json.error.code).toBe("CSRF_INVALID");
});

// === Move: stale assignment → 409 stale_assignment =======================

test("Move with stale expectedCurrentOccurrenceId returns 409 stale_assignment", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  // E is at occ1, but we pass occ2 as expected (stale).
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-stale"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("stale_assignment");
});

// === Move: destination full → 409 destination_full =======================

test("Move to full occurrence returns 409 destination_full", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  // Pre-fill occFullId (capacity=1) with another entitlement.
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 2, 'active', $3, $3);`, [randomUUID(), pkgId, occFullId]);
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-full"), body: { destinationOccurrenceId: occFullId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("destination_full");
});

// === Move: past occurrence → 409 past_occurrence ========================

test("Move to past occurrence returns 409 past_occurrence", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-past"), body: { destinationOccurrenceId: occPastId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("past_occurrence");
});

// === Move: limit exceeded → 409 move_limit_exceeded ======================

test("Move limit exceeded returns 409 move_limit_exceeded", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) };
  // Move 1: occ1 → occ2.
  await POST(await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-m1"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Move 2: occ2 → occ1.
  await POST(await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-m2"), body: { destinationOccurrenceId: occ1Id, expectedCurrentOccurrenceId: occ2Id } }), ctx);
  // Move 3: occ1 → occ2 — exceeds limit (default 2).
  const res = await POST(await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-m3"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("move_limit_exceeded");
});

// === Move: session expired → 401 ========================================

test("Move with expired session returns 401", async () => {
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", headers: { "idempotency-key": "key-expired" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(401);
});

// === Move: successful + schedule refetch shows moveType='moved' ==========

test("Successful move → schedule refetch shows moveType='moved'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) };
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-success"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    ctx,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { assignedOccurrenceId: string; moveCountUsed: number; noOp: boolean };
  expect(json.assignedOccurrenceId).toBe(occ2Id);
  expect(json.moveCountUsed).toBe(1);
  expect(json.noOp).toBe(false);

  // Refetch schedule.
  const { GET: schedGET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const schedRes = await schedGET(
    await makeRequest(`/api/parent/children/${studentA1}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1 }) },
  );
  expect(schedRes.status).toBe(200);
  const schedJson = (await schedRes.json()) as { schedule: { entitlementId: string; moveType: string; occurrenceId: string; originalOccurrenceId: string }[] };
  const ent = schedJson.schedule.find((e) => e.entitlementId === entActiveId);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("moved");
  expect(ent!.occurrenceId).toBe(occ2Id);
  expect(ent!.originalOccurrenceId).toBe(occ1Id);
});

// === Move: retry with same key → replay (no duplicate) ===================

test("Retry move with same key + same body → replay (no duplicate event)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) };
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  // First move.
  const res1 = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-retry"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    ctx,
  );
  expect(res1.status).toBe(200);

  // Retry with SAME key + SAME body (simulating network-failure retry).
  const res2 = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-retry"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    ctx,
  );
  expect(res2.status).toBe(200);

  // Only 1 normal_moved event.
  const events = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [entActiveId]);
  expect((events.rows[0] as { c: number }).c).toBe(1);

  // Only 1 idempotency record.
  const records = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'key-retry';`, [entActiveId]);
  expect((records.rows[0] as { c: number }).c).toBe(1);
});

// === Move: same key different body → 409 idempotency_key_reuse ==========

test("Move with same key but different destination returns 409 idempotency_key_reuse", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) };
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  // First: move to occ2.
  await POST(await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-reuse"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Reset ent back to occ1.
  await db.query(`UPDATE session_entitlements SET assigned_occurrence_id = $2 WHERE id = $1;`, [entActiveId, occ1Id]);
  // Same key, different destination.
  const res = await POST(await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-reuse"), body: { destinationOccurrenceId: occFullId, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("idempotency_key_reuse");
});

// === Move: class mismatch → 409 class_mismatch ===========================

test("Move to different-class occurrence returns 409 class_mismatch", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Create a different class + occurrence in it.
  const otherClassId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class B', 12);`, [otherClassId, ACADEMY_A_ID]);
  const otherVersionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [otherVersionId, otherClassId]);
  const otherSlotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 3, '17:00', '18:00');`, [otherSlotId, otherVersionId]);
  const otherOccId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-30', '2027-06-30 17:00:00', '2027-06-30 18:00:00', 'planned', 12);`, [otherOccId, ACADEMY_A_ID, otherClassId, otherSlotId, otherVersionId]);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-class"), body: { destinationOccurrenceId: otherOccId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("class_mismatch");
});

// === Move: occurrence not planned → 409 occurrence_not_planned ============

test("Move to cancelled occurrence returns 409 occurrence_not_planned", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Create a cancelled occurrence.
  const cancelledOccId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-08-01', '2027-08-01 15:00:00', '2027-08-01 16:00:00', 'cancelled', 12);`, [cancelledOccId, ACADEMY_A_ID, classId, slotId, versionId]);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-cancelled"), body: { destinationOccurrenceId: cancelledOccId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("occurrence_not_planned");
});

// === Move: obsolete version → 409 obsolete_version ======================

test("Move to occurrence from obsolete schedule version returns 409 obsolete_version", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Create an obsolete schedule version (effective_to set).
  const obsoleteVersionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'superseded');`, [obsoleteVersionId, classId]);
  const obsoleteOccId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-09-01', '2027-09-01 15:00:00', '2027-09-01 16:00:00', 'planned', 12);`, [obsoleteOccId, ACADEMY_A_ID, classId, slotId, obsoleteVersionId]);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(entActiveId), { method: "POST", ...auth(s, c, "key-obsolete"), body: { destinationOccurrenceId: obsoleteOccId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { detail?: string } };
  expect(json.error.detail).toBe("obsolete_version");
});
