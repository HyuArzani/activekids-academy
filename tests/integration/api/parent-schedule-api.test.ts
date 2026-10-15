/**
 * API integration tests: Stage 10 Phase 1 — extended schedule API +
 * eligible-occurrences endpoint + error detail sub-codes.
 *
 * Tests route handlers against in-memory PgLite (single-process — NOT real
 * PostgreSQL concurrency).
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
let studentB1: string;
let classId: string;
let versionId: string;
let slotId: string;
let planId: string;
let occ1Id: string;
let occ2Id: string;
let occPastId: string;
let occFullId: string;
let occOtherClassId: string;
let pkgId: string;
let ent1Id: string; // active, original
let ent2Id: string; // active, original
let entSkipId: string; // for skip test
let entAwaitingId: string; // awaiting_makeup
let entUnassignedId: string; // active, no occurrence (never assigned)

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
  parentB = await createTestUser(db, { email: "parent-b@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);
  // A different class for the class-mismatch test.
  occOtherClassId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class B', 12);`, [occOtherClassId, ACADEMY_A_ID]);

  studentA1 = randomUUID();
  studentB1 = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Child A1');`, [studentA1, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Child B1');`, [studentB1, ACADEMY_A_ID]);

  // Guardian links.
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), parentA.id, studentA1]);
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), parentB.id, studentB1]);

  // Enrollments.
  await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), studentA1, classId]);

  // Schedule version + slot.
  versionId = randomUUID();
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, classId]);
  slotId = randomUUID();
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [slotId, versionId]);

  // Future occurrences.
  occ1Id = randomUUID();
  occ2Id = randomUUID();
  occPastId = randomUUID();
  occFullId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occ2Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2024-01-01', '2024-01-01 15:00:00', '2024-01-01 16:00:00', 'planned', 12);`, [occPastId, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-07-01', '2027-07-01 15:00:00', '2027-07-01 16:00:00', 'planned', 1);`, [occFullId, ACADEMY_A_ID, classId, slotId, versionId]);

  // Package plan + package.
  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [planId, ACADEMY_A_ID]);
  pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [pkgId, studentA1, planId, classId]);

  // Entitlements.
  ent1Id = randomUUID();
  ent2Id = randomUUID();
  entSkipId = randomUUID();
  entAwaitingId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3);`, [ent1Id, pkgId, occ1Id]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 2, 'active', $3, $3);`, [ent2Id, pkgId, occ1Id]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 3, 'active', $3, $3);`, [entSkipId, pkgId, occ1Id]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 4, 'awaiting_makeup', NULL, NULL);`, [entAwaitingId, pkgId]);
  // Unassigned active entitlement (simulates a newly-purchased package with
  // no occurrences available at purchase time). Has a 'created' event.
  entUnassignedId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 5, 'active', NULL, NULL);`, [entUnassignedId, pkgId]);
  await db.query(`INSERT INTO entitlement_events (id, entitlement_id, event_type, occurred_at, actor_user_id) VALUES ($1, $2, 'created', now(), $3);`, [randomUUID(), entUnassignedId, adminA.id]);
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
function auth(s: string, c: string) {
  return { cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c }, headers: { [CSRF_HEADER]: c } };
}
function noAuth(s: string) { return { cookies: { [sessionCookieName()]: s } }; }

function schedulePath() { return `/api/parent/children/${studentA1}/schedule?academyId=${ACADEMY_A_ID}`; }
function eligiblePath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/eligible-occurrences?academyId=${ACADEMY_A_ID}`; }
function movePath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/move?academyId=${ACADEMY_A_ID}`; }
function skipPath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/skip?academyId=${ACADEMY_A_ID}`; }
function makeupPath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/makeup?academyId=${ACADEMY_A_ID}`; }

// === Extended schedule API — moveType derivation =========================

test("Schedule returns moveType='original' for untouched active entitlement", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(schedulePath(), noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { entitlementId: string; moveType: string; originalOccurrenceId: string; occurrenceId: string; wasMoved: boolean }[] };
  const ent1 = json.schedule.find((e) => e.entitlementId === ent1Id);
  expect(ent1).toBeDefined();
  expect(ent1!.moveType).toBe("original");
  expect(ent1!.wasMoved).toBe(false);
  expect(ent1!.originalOccurrenceId).toBe(occ1Id);
  expect(ent1!.occurrenceId).toBe(occ1Id);
});

test("Schedule returns moveType='skipped' for skipped entitlement", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // First skip the entitlement.
  const { POST: skipPOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  await skipPOST(await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-sk-sched" }, body: {} }), { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) });
  // Now fetch schedule.
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(schedulePath(), noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { entitlementId: string; moveType: string; status: string; occurrenceId: string | null }[] };
  const ent = json.schedule.find((e) => e.entitlementId === entSkipId);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("skipped");
  expect(ent!.status).toBe("skipped");
  expect(ent!.occurrenceId).toBe(null);
});

test("Schedule returns moveType='moved' after a normal parent move", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Move ent1 from occ1 to occ2.
  const { POST: movePOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  await movePOST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-mv-sched" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) });
  // Fetch schedule.
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(schedulePath(), noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { entitlementId: string; moveType: string; wasMoved: boolean; originalOccurrenceId: string; occurrenceId: string }[] };
  const ent = json.schedule.find((e) => e.entitlementId === ent1Id);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("moved");
  expect(ent!.wasMoved).toBe(true);
  expect(ent!.originalOccurrenceId).toBe(occ1Id);
  expect(ent!.occurrenceId).toBe(occ2Id);
});

test("Schedule returns moveType='makeup' after skip+makeup", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Skip entSkipId.
  const { POST: skipPOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  await skipPOST(await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-sk-mk" }, body: {} }), { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) });
  // Makeup to occ2.
  const { POST: makeupPOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  await makeupPOST(await makeRequest(makeupPath(entSkipId), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-mk-mk" }, body: { destinationOccurrenceId: occ2Id } }), { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) });
  // Fetch schedule.
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(schedulePath(), noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { entitlementId: string; moveType: string; status: string; occurrenceId: string }[] };
  const ent = json.schedule.find((e) => e.entitlementId === entSkipId);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("makeup");
  expect(ent!.status).toBe("active");
  expect(ent!.occurrenceId).toBe(occ2Id);
});

test("Schedule returns moveType='awaiting_makeup' for unassigned awaiting entitlement", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(schedulePath(), noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { entitlementId: string; moveType: string; status: string }[] };
  const ent = json.schedule.find((e) => e.entitlementId === entAwaitingId);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("awaiting_makeup");
  expect(ent!.status).toBe("awaiting_makeup");
});

test("Schedule returns moveType='unassigned' for active entitlement with no occurrence (Fix 1 regression)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const res = await GET(await makeRequest(schedulePath(), noAuth(s)), { params: Promise.resolve({ studentId: studentA1 }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { schedule: { entitlementId: string; moveType: string; status: string; occurrenceId: string | null; originalOccurrenceId: string | null; wasMoved: boolean }[] };
  const ent = json.schedule.find((e) => e.entitlementId === entUnassignedId);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("unassigned");
  expect(ent!.status).toBe("active");
  expect(ent!.occurrenceId).toBe(null);
  expect(ent!.originalOccurrenceId).toBe(null);
  expect(ent!.wasMoved).toBe(false);
});

// === Eligible-occurrences endpoint =======================================

test("Eligible occurrences returns future same-class occurrences (200)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(eligiblePath(ent1Id), noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string; occurrenceDate: string; availableSeats: number; capacity: number }[] };
  // Should include occ1, occ2, occFull (all future, same class, planned).
  // occPast is excluded (past). occFull has capacity=1.
  const ids = json.occurrences.map((o) => o.id);
  expect(ids).toContain(occ1Id);
  expect(ids).toContain(occ2Id);
  expect(ids).toContain(occFullId);
  expect(ids).not.toContain(occPastId);
});

test("Eligible occurrences rejects wrong guardian (404)", async () => {
  const { s, c } = await login(parentB.email, parentB.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(eligiblePath(ent1Id), noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(404);
});

test("Eligible occurrences rejects cross-academy (403)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(`/api/parent/children/${studentA1}/entitlements/${ent1Id}/eligible-occurrences?academyId=${ACADEMY_B_ID}`, noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(403);
});

test("Eligible occurrences rejects invalid UUID (422)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(`/api/parent/children/${studentA1}/entitlements/not-a-uuid/eligible-occurrences?academyId=${ACADEMY_A_ID}`, noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: "not-a-uuid" }) },
  );
  expect(res.status).toBe(422);
});

test("Eligible occurrences rejects entitlement not belonging to student (404)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Create an entitlement for studentB1's package, then try to access it via studentA1's URL.
  const pkgB = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [pkgB, studentB1, planId, classId]);
  const entB = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3);`, [entB, pkgB, occ1Id]);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  // parentA is NOT the guardian of studentB1, so this should 404 at the guardian check.
  const res = await GET(
    await makeRequest(eligiblePath(entB), noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entB }) },
  );
  expect(res.status).toBe(404);
});

test("Eligible occurrences computes availableSeats correctly", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // Pre-fill occFullId (capacity=1) with ent2.
  await db.query(`UPDATE session_entitlements SET assigned_occurrence_id = $2 WHERE id = $1;`, [ent2Id, occFullId]);
  const { GET } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/eligible-occurrences/route");
  const res = await GET(
    await makeRequest(eligiblePath(ent1Id), noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string; capacity: number; activeCount: number; availableSeats: number }[] };
  const full = json.occurrences.find((o) => o.id === occFullId);
  expect(full).toBeDefined();
  expect(full!.capacity).toBe(1);
  expect(full!.activeCount).toBe(1);
  expect(full!.availableSeats).toBe(0);
});

// === Error detail sub-codes =============================================

test("Move stale assignment returns 409 with detail='stale_assignment'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-stale-detail" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.code).toBe("CONFLICT");
  expect(json.error.detail).toBe("stale_assignment");
});

test("Move to past occurrence returns 409 with detail='past_occurrence'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-past-detail" }, body: { destinationOccurrenceId: occPastId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("past_occurrence");
});

test("Move to full occurrence returns 409 with detail='destination_full'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  // Pre-fill occFullId (capacity=1).
  await db.query(`UPDATE session_entitlements SET assigned_occurrence_id = $2 WHERE id = $1;`, [ent2Id, occFullId]);
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-full-detail" }, body: { destinationOccurrenceId: occFullId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("destination_full");
});

test("Move limit exceeded returns 409 with detail='move_limit_exceeded'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  // Move 1: occ1 → occ2.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-m1-d" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Move 2: occ2 → occ1.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-m2-d" }, body: { destinationOccurrenceId: occ1Id, expectedCurrentOccurrenceId: occ2Id } }), ctx);
  // Move 3: occ1 → occ2 — exceeds limit.
  const res = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-m3-d" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("move_limit_exceeded");
});

test("Skip allowance exceeded returns 409 with detail='skip_allowance_exceeded'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST: skipPOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  // First skip on entSkipId.
  await skipPOST(await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-sk-d1" }, body: {} }), { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) });
  // Second skip on ent1Id (same package).
  const res = await skipPOST(await makeRequest(skipPath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-sk-d2" }, body: {} }), { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) });
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("skip_allowance_exceeded");
});

test("Same key different payload returns 409 with detail='idempotency_key_reuse'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  // First: move to occ2.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-reuse-d" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Reset.
  await db.query(`UPDATE session_entitlements SET assigned_occurrence_id = $2 WHERE id = $1;`, [ent1Id, occ1Id]);
  // Same key, different destination.
  const res = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), headers: { ...auth(s, c).headers, "idempotency-key": "key-reuse-d" }, body: { destinationOccurrenceId: occFullId, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("idempotency_key_reuse");
});
