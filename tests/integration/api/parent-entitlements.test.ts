/**
 * API integration tests: Parent scheduling mutations (Stage 9).
 *
 * Tests route handlers against in-memory PgLite (single-process — NOT real
 * PostgreSQL concurrency). Verifies business logic, idempotency, state
 * machine, authorization, and error mapping. Concurrency guarantees
 * (SERIALIZABLE, SSI, FOR UPDATE) are verified ONLY by the real-PostgreSQL
 * tests in tests/integration/pg/.
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
let pkgId: string;
let ent1Id: string;
let ent2Id: string;
let entSkipId: string;
let entAwaitingId: string;
let entOtherPkgId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
  parentB = await createTestUser(db, { email: "parent-b@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  classId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);

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

  // Future occurrences (occ1 = current assignment, occ2 = move target).
  occ1Id = randomUUID();
  occ2Id = randomUUID();
  occPastId = randomUUID();
  occFullId = randomUUID();
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occ2Id, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2024-01-01', '2024-01-01 15:00:00', '2024-01-01 16:00:00', 'planned', 12);`, [occPastId, ACADEMY_A_ID, classId, slotId, versionId]);
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-07-01', '2027-07-01 15:00:00', '2027-07-01 16:00:00', 'planned', 1);`, [occFullId, ACADEMY_A_ID, classId, slotId, versionId]);

  // Package plan + package (skip_allowance=1 by default).
  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [planId, ACADEMY_A_ID]);
  pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [pkgId, studentA1, planId, classId]);

  // Entitlements: ent1 + ent2 active on occ1; entSkip for skip test; entAwaiting for makeup test.
  ent1Id = randomUUID();
  ent2Id = randomUUID();
  entSkipId = randomUUID();
  entAwaitingId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3);`, [ent1Id, pkgId, occ1Id]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 2, 'active', $3, $3);`, [ent2Id, pkgId, occ1Id]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 3, 'active', $3, $3);`, [entSkipId, pkgId, occ1Id]);
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 4, 'awaiting_makeup', NULL, NULL);`, [entAwaitingId, pkgId]);

  // A second package for studentB1 (for cross-parent tests).
  entOtherPkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [entOtherPkgId, studentB1, planId, classId]);
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
function skipPath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/skip?academyId=${ACADEMY_A_ID}`; }
function makeupPath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/makeup?academyId=${ACADEMY_A_ID}`; }

async function dbRow<T>(query: string, params: unknown[]): Promise<T> {
  const r = await db.query<T>(query, params);
  return r.rows[0] as T;
}

// === Normal move =========================================================

test("Parent move succeeds (200): changes assigned, preserves original, creates event + idempotency record", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), {
      method: "POST",
      ...auth(s, c, "key-move-1"),
      body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id },
    }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { operation: string; assignedOccurrenceId: string; originalOccurrenceId: string; noOp: boolean; moveCountUsed: number };
  expect(json.operation).toBe("move");
  expect(json.assignedOccurrenceId).toBe(occ2Id);
  expect(json.originalOccurrenceId).toBe(occ1Id); // original preserved
  expect(json.noOp).toBe(false);
  expect(json.moveCountUsed).toBe(1);

  // DB invariants.
  const ent = await dbRow<{ assigned_occurrence_id: string; original_occurrence_id: string; status: string }>(`SELECT assigned_occurrence_id, original_occurrence_id, status FROM session_entitlements WHERE id = $1;`, [ent1Id]);
  expect(ent.assigned_occurrence_id).toBe(occ2Id);
  expect(ent.original_occurrence_id).toBe(occ1Id); // original NOT changed
  expect(ent.status).toBe("active");

  const events = await db.query<{ event_type: string }>(`SELECT event_type FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [ent1Id]);
  expect(events.rows.length).toBe(1);

  const records = await db.query<{ idempotency_key: string; no_op: boolean }>(`SELECT idempotency_key, no_op FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'key-move-1';`, [ent1Id]);
  expect(records.rows.length).toBe(1);
  expect((records.rows[0] as { no_op: boolean }).no_op).toBe(false);
});

test("Parent move no-op (200): expected===dest, no event, no quota, idempotency record stored", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), {
      method: "POST",
      ...auth(s, c, "key-noop-1"),
      body: { destinationOccurrenceId: occ1Id, expectedCurrentOccurrenceId: occ1Id },
    }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { noOp: boolean; moveCountUsed: number };
  expect(json.noOp).toBe(true);
  expect(json.moveCountUsed).toBe(0);

  // No normal_moved event.
  const events = await db.query(`SELECT id FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [ent1Id]);
  expect(events.rows.length).toBe(0);

  // Idempotency record IS stored (no_op=true).
  const records = await db.query(`SELECT no_op FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'key-noop-1';`, [ent1Id]);
  expect(records.rows.length).toBe(1);
  expect((records.rows[0] as { no_op: boolean }).no_op).toBe(true);
});

test("Parent move replay (200): same key + same body returns stored result, no new event/record", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  const req1 = await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-replay"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } });
  await POST(req1, ctx);
  // Replay: same key, same body. E is now at occ2, so expected=occ1 is stale — but replay should return stored result.
  const req2 = await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-replay"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } });
  const res2 = await POST(req2, ctx);
  expect(res2.status).toBe(200);
  const json2 = (await res2.json()) as { assignedOccurrenceId: string };
  expect(json2.assignedOccurrenceId).toBe(occ2Id); // original result

  // No duplicate event/record.
  const events = await db.query(`SELECT id FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [ent1Id]);
  expect(events.rows.length).toBe(1);
  const records = await db.query(`SELECT id FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'key-replay';`, [ent1Id]);
  expect(records.rows.length).toBe(1);
});

test("Parent move same key different payload (409): idempotency_key_reuse, non-retryable", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  // First: move to occ2.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-reuse"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Reset ent1 back to occ1 for the second move attempt.
  await db.query(`UPDATE session_entitlements SET assigned_occurrence_id = $2 WHERE id = $1;`, [ent1Id, occ1Id]);
  // Second: same key but different destination → reuse conflict.
  const res = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-reuse"), body: { destinationOccurrenceId: occFullId, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(409);
  // No second event/record.
  const records = await db.query(`SELECT id FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'key-reuse';`, [ent1Id]);
  expect(records.rows.length).toBe(1);
});

test("Parent move stale assignment (409): expected !== current", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  // E is at occ1, but we pass expected=occ2 (stale).
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-stale"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string } };
  expect(json.error.code).toBe("CONFLICT");
  // No mutation.
  const ent = await dbRow<{ assigned_occurrence_id: string }>(`SELECT assigned_occurrence_id FROM session_entitlements WHERE id = $1;`, [ent1Id]);
  expect(ent.assigned_occurrence_id).toBe(occ1Id);
});

test("Parent move to past occurrence (409): historical lock", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-past"), body: { destinationOccurrenceId: occPastId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(409);
});

test("Parent move to full occurrence (409): capacity exceeded", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  // occFullId has capacity=1. Pre-fill it with ent2.
  await db.query(`UPDATE session_entitlements SET assigned_occurrence_id = $2 WHERE id = $1;`, [ent2Id, occFullId]);
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-full"), body: { destinationOccurrenceId: occFullId, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string } };
  expect(json.error.code).toBe("CONFLICT");
});

test("Parent move limit exceeded (409): 2 moves already used", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  // Move 1: occ1 → occ2.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-m1"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Move 2: occ2 → occ1 (need a 3rd occurrence for this test — reuse occ1 as dest, occ2 as source).
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-m2"), body: { destinationOccurrenceId: occ1Id, expectedCurrentOccurrenceId: occ2Id } }), ctx);
  // Move 3: occ1 → occ2 again — should exceed limit (default 2).
  const res = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-m3"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(409);
  const events = await db.query(`SELECT id FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [ent1Id]);
  expect(events.rows.length).toBe(2);
});

test("Parent move unauthorized (403): admin role cannot use parent endpoint", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-admin"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(403);
});

test("Parent move wrong guardian (404): parentB cannot move parentA's child's entitlement", async () => {
  const { s, c } = await login(parentB.email, parentB.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-b"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(404);
});

test("Parent move unauthenticated (401)", async () => {
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", headers: { "idempotency-key": "key-noauth" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(401);
});

test("Parent move missing idempotency key (422)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(422);
});

test("Parent move invalid entitlement UUID (422)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(`/api/parent/children/${studentA1}/entitlements/not-a-uuid/move?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c, "key-bad-uuid"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: "not-a-uuid" }) },
  );
  expect(res.status).toBe(422);
});

test("Parent move cross-academy (403)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(`/api/parent/children/${studentA1}/entitlements/${ent1Id}/move?academyId=${ACADEMY_B_ID}`, { method: "POST", ...auth(s, c, "key-xa"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(403);
});

test("Parent move missing CSRF (403)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const res = await POST(
    await makeRequest(movePath(ent1Id), { method: "POST", cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c }, headers: { "idempotency-key": "key-nocsrf" }, body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(403);
});

// === Skip ================================================================

test("Parent skip succeeds (200): status=skipped, skip_used=true, event + record", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const res = await POST(
    await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c, "key-skip-1"), body: { reason: "Sick" } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { operation: string; status: string; skipAllowanceUsed: number };
  expect(json.operation).toBe("skip");
  expect(json.status).toBe("skipped");
  expect(json.skipAllowanceUsed).toBe(1);

  const ent = await dbRow<{ status: string; skip_used: boolean; assigned_occurrence_id: string | null }>(`SELECT status, skip_used, assigned_occurrence_id FROM session_entitlements WHERE id = $1;`, [entSkipId]);
  expect(ent.status).toBe("skipped");
  expect(ent.skip_used).toBe(true);
  expect(ent.assigned_occurrence_id).toBe(null);
});

test("Parent skip replay (200): same key returns stored result", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) };
  await POST(await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c, "key-skip-rep"), body: { reason: "Sick" } }), ctx);
  const res = await POST(await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c, "key-skip-rep"), body: { reason: "Sick" } }), ctx);
  expect(res.status).toBe(200);
  const events = await db.query(`SELECT id FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'skip_requested';`, [entSkipId]);
  expect(events.rows.length).toBe(1);
});

test("Parent skip allowance exceeded (409): skip_allowance=1 already used", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) };
  // First skip on entSkipId (allowance=1).
  await POST(await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c, "key-skip-a"), body: {} }), ctx);
  // Second skip on ent1Id (same package, allowance already consumed).
  const res = await POST(await makeRequest(skipPath(ent1Id), { method: "POST", ...auth(s, c, "key-skip-b"), body: {} }), { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) });
  expect(res.status).toBe(409);
  const skipCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1 AND skip_used = TRUE;`, [pkgId]);
  expect((skipCount.rows[0] as { c: number }).c).toBe(1);
});

test("Parent skip wrong guardian (404)", async () => {
  const { s, c } = await login(parentB.email, parentB.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const res = await POST(
    await makeRequest(skipPath(entSkipId), { method: "POST", ...auth(s, c, "key-skip-b"), body: {} }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkipId }) },
  );
  expect(res.status).toBe(404);
});

// === Makeup ==============================================================

test("Parent makeup succeeds (200): assigns new occurrence, status=active", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entAwaitingId), { method: "POST", ...auth(s, c, "key-makeup-1"), body: { destinationOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entAwaitingId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { operation: string; assignedOccurrenceId: string; status: string };
  expect(json.operation).toBe("makeup");
  expect(json.assignedOccurrenceId).toBe(occ2Id);
  expect(json.status).toBe("active");

  const ent = await dbRow<{ status: string; assigned_occurrence_id: string }>(`SELECT status, assigned_occurrence_id FROM session_entitlements WHERE id = $1;`, [entAwaitingId]);
  expect(ent.status).toBe("active");
  expect(ent.assigned_occurrence_id).toBe(occ2Id);
});

test("Parent makeup on active entitlement (409): must be skipped or awaiting", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(ent1Id), { method: "POST", ...auth(s, c, "key-makeup-act"), body: { destinationOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) },
  );
  expect(res.status).toBe(409);
});

test("Parent makeup replay (200): same key returns stored result", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entAwaitingId }) };
  await POST(await makeRequest(makeupPath(entAwaitingId), { method: "POST", ...auth(s, c, "key-mk-rep"), body: { destinationOccurrenceId: occ2Id } }), ctx);
  const res = await POST(await makeRequest(makeupPath(entAwaitingId), { method: "POST", ...auth(s, c, "key-mk-rep"), body: { destinationOccurrenceId: occ2Id } }), ctx);
  expect(res.status).toBe(200);
  const events = await db.query(`SELECT id FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'makeup_assigned';`, [entAwaitingId]);
  expect(events.rows.length).toBe(1);
});

test("Parent makeup wrong guardian (404)", async () => {
  const { s, c } = await login(parentB.email, parentB.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/makeup/route");
  const res = await POST(
    await makeRequest(makeupPath(entAwaitingId), { method: "POST", ...auth(s, c, "key-mk-b"), body: { destinationOccurrenceId: occ2Id } }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entAwaitingId }) },
  );
  expect(res.status).toBe(404);
});

// === No-op move → later move → replay original ==========================

test("No-op move then real move then replay original key: original no-op result preserved", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  // K1: move to occ1 (no-op, E already at occ1).
  const r1 = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "K1"), body: { destinationOccurrenceId: occ1Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(r1.status).toBe(200);
  const j1 = (await r1.json()) as { noOp: boolean };
  expect(j1.noOp).toBe(true);
  // K2: move occ1 → occ2.
  const r2 = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "K2"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(r2.status).toBe(200);
  // Replay K1: should return original no-op result, NOT move E back to occ1.
  const r3 = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "K1"), body: { destinationOccurrenceId: occ1Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(r3.status).toBe(200);
  const j3 = (await r3.json()) as { noOp: boolean };
  expect(j3.noOp).toBe(true);
  // E is still at occ2 (not moved back to occ1).
  const ent = await dbRow<{ assigned_occurrence_id: string }>(`SELECT assigned_occurrence_id FROM session_entitlements WHERE id = $1;`, [ent1Id]);
  expect(ent.assigned_occurrence_id).toBe(occ2Id);
  // Only 1 normal_moved event (from K2).
  const events = await db.query(`SELECT id FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [ent1Id]);
  expect(events.rows.length).toBe(1);
  // 2 idempotency records (K1 no-op + K2 move).
  const records = await db.query(`SELECT id FROM entitlement_idempotency_records WHERE entitlement_id = $1;`, [ent1Id]);
  expect(records.rows.length).toBe(2);
});

// === Original-occurrence immutability ====================================

test("Original occurrence immutability: move does not change original_occurrence_id", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  // Move occ1 → occ2.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-imm-1"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Move occ2 → occ1.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-imm-2"), body: { destinationOccurrenceId: occ1Id, expectedCurrentOccurrenceId: occ2Id } }), ctx);
  const ent = await dbRow<{ original_occurrence_id: string; assigned_occurrence_id: string }>(`SELECT original_occurrence_id, assigned_occurrence_id FROM session_entitlements WHERE id = $1;`, [ent1Id]);
  expect(ent.original_occurrence_id).toBe(occ1Id); // never changed
  expect(ent.assigned_occurrence_id).toBe(occ1Id);
});

// === Guardian revoked before replay ======================================

test("Guardian access revoked before replay (404): stored result not disclosed", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/move/route");
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: ent1Id }) };
  // First: successful move with key K.
  await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-revoke"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  // Revoke guardian link.
  await db.query(`DELETE FROM guardian_student_links WHERE guardian_user_id = $1 AND student_id = $2;`, [parentA.id, studentA1]);
  // Replay K: should get 404 (guardian check before replay).
  const res = await POST(await makeRequest(movePath(ent1Id), { method: "POST", ...auth(s, c, "key-revoke"), body: { destinationOccurrenceId: occ2Id, expectedCurrentOccurrenceId: occ1Id } }), ctx);
  expect(res.status).toBe(404);
});
