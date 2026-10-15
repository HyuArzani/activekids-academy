/**
 * API integration tests: Parent Skip Action UI contract (Phase 1).
 *
 * Verifies the API behavior that the SkipActionDialog component relies on:
 * - Missing Idempotency-Key header → 422
 * - Missing CSRF → 403
 * - Skip on non-active entitlement → 409 detail="invalid_status"
 * - Skip on no-assignment entitlement → 409 detail="no_assignment"
 * - Skip with expired session → 401
 * - Successful skip refetches schedule → updated state visible
 * - Retry with same key → replay (no duplicate mutation)
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
let pkgId: string;
let entActiveId: string;
let entSkippedId: string;
let entAwaitingId: string;
let entNoAssignmentId: string;

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
  await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, ACADEMY_A_ID, classId, slotId, versionId]);

  planId = randomUUID();
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1, $2, 'Starter 4', 4);`, [planId, ACADEMY_A_ID]);
  pkgId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [pkgId, studentA1, planId, classId]);

  // Separate package for the pre-skipped entitlement (so its skip_used=true
  // doesn't consume the first package's allowance).
  const pkgSkippedId = randomUUID();
  await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1);`, [pkgSkippedId, studentA1, planId, classId]);

  // Active with assignment (eligible for skip) — in the first package (allowance available)
  entActiveId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3);`, [entActiveId, pkgId, occ1Id]);
  // Already skipped (not eligible — invalid_status) — in the separate package
  entSkippedId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id, skip_used) VALUES ($1, $2, 1, 'skipped', $3, NULL, true);`, [entSkippedId, pkgSkippedId, occ1Id]);
  // Awaiting makeup (not eligible — invalid_status) — in the first package
  entAwaitingId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 2, 'awaiting_makeup', NULL, NULL);`, [entAwaitingId, pkgId]);
  // Active but no assignment (not eligible — no_assignment) — in the first package
  entNoAssignmentId = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 3, 'active', NULL, NULL);`, [entNoAssignmentId, pkgId]);
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

function skipPath(entId: string) { return `/api/parent/children/${studentA1}/entitlements/${entId}/skip?academyId=${ACADEMY_A_ID}`; }

// === Missing Idempotency-Key header → 422 =================================

test("Skip without Idempotency-Key header returns 422", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const res = await POST(
    await makeRequest(skipPath(entActiveId), { method: "POST", ...auth(s, c), body: {} }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(422);
  const json = (await res.json()) as { error: { code: string; message: string } };
  expect(json.error.code).toBe("VALIDATION_FAILED");
  expect(json.error.message).toContain("Idempotency-Key");
});

// === Missing CSRF → 403 ===================================================

test("Skip without CSRF token returns 403", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  // Send with session cookie + idempotency-key but NO CSRF header.
  const res = await POST(
    await makeRequest(skipPath(entActiveId), {
      method: "POST",
      cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c },
      headers: { "idempotency-key": "test-key-csrf" },
      body: {},
    }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: { code: string } };
  expect(json.error.code).toBe("CSRF_INVALID");
});

// === Skip on non-active entitlement → 409 invalid_status ================

test("Skip on skipped entitlement returns 409 with detail='invalid_status'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const res = await POST(
    await makeRequest(skipPath(entSkippedId), { method: "POST", ...auth(s, c, "key-invalid-status"), body: {} }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSkippedId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("invalid_status");
});

// === Skip on no-assignment entitlement → 409 no_assignment ===============

test("Skip on active entitlement with no assignment returns 409 with detail='no_assignment'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const res = await POST(
    await makeRequest(skipPath(entNoAssignmentId), { method: "POST", ...auth(s, c, "key-no-assign"), body: {} }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entNoAssignmentId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("no_assignment");
});

// === Session expired → 401 ===============================================

test("Skip with expired session returns 401", async () => {
  const { POST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  const res = await POST(
    await makeRequest(skipPath(entActiveId), { method: "POST", headers: { "idempotency-key": "key-expired" }, body: {} }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  expect(res.status).toBe(401);
});

// === Successful skip + schedule refresh shows updated state ===============

test("Successful skip → schedule refetch shows moveType='skipped'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) };
  const { POST: skipPOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  // Skip the active entitlement.
  const skipRes = await skipPOST(
    await makeRequest(skipPath(entActiveId), { method: "POST", ...auth(s, c, "key-success-refresh"), body: { reason: "Sick" } }),
    ctx,
  );
  expect(skipRes.status).toBe(200);
  const skipJson = (await skipRes.json()) as { status: string; skipAllowanceUsed: number };
  expect(skipJson.status).toBe("skipped");
  expect(skipJson.skipAllowanceUsed).toBe(1);

  // Refetch schedule — the skipped entitlement should show moveType='skipped'.
  const { GET: schedGET } = await import("@/app/api/parent/children/[studentId]/schedule/route");
  const schedRes = await schedGET(
    await makeRequest(`/api/parent/children/${studentA1}/schedule?academyId=${ACADEMY_A_ID}`, noAuth(s)),
    { params: Promise.resolve({ studentId: studentA1 }) },
  );
  expect(schedRes.status).toBe(200);
  const schedJson = (await schedRes.json()) as { schedule: { entitlementId: string; moveType: string; status: string }[] };
  const ent = schedJson.schedule.find((e) => e.entitlementId === entActiveId);
  expect(ent).toBeDefined();
  expect(ent!.moveType).toBe("skipped");
  expect(ent!.status).toBe("skipped");
});

// === Retry with same key → replay (no duplicate mutation) ================

test("Retry skip with same key + same body → replay (no duplicate event)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const ctx = { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) };
  const { POST: skipPOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  // First skip (simulating the original request that may have been lost).
  const res1 = await skipPOST(
    await makeRequest(skipPath(entActiveId), { method: "POST", ...auth(s, c, "key-retry-same"), body: { reason: "Sick" } }),
    ctx,
  );
  expect(res1.status).toBe(200);

  // Retry with the SAME key + SAME body (simulating a network-failure retry).
  const res2 = await skipPOST(
    await makeRequest(skipPath(entActiveId), { method: "POST", ...auth(s, c, "key-retry-same"), body: { reason: "Sick" } }),
    ctx,
  );
  expect(res2.status).toBe(200);
  const json2 = (await res2.json()) as { skipAllowanceUsed: number };
  // The skip allowance should NOT be consumed a second time (replay, not duplicate).
  expect(json2.skipAllowanceUsed).toBe(1);

  // Verify only one skip_requested event exists.
  const events = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'skip_requested';`, [entActiveId]);
  expect((events.rows[0] as { c: number }).c).toBe(1);

  // Verify only one idempotency record exists.
  const records = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'key-retry-same';`, [entActiveId]);
  expect((records.rows[0] as { c: number }).c).toBe(1);
});

// === Skip allowance exhausted → 409 skip_allowance_exceeded =============

test("Skip allowance exhausted returns 409 with detail='skip_allowance_exceeded'", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  // First skip on entActiveId (allowance=1).
  const { POST: skipPOST } = await import("@/app/api/parent/children/[studentId]/entitlements/[entitlementId]/skip/route");
  await skipPOST(
    await makeRequest(skipPath(entActiveId), { method: "POST", ...auth(s, c, "key-allowance-1"), body: {} }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entActiveId }) },
  );
  // Create another active entitlement in the same package to try a second skip.
  const entSecond = randomUUID();
  await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 5, 'active', $3, $3);`, [entSecond, pkgId, occ1Id]);
  const res = await skipPOST(
    await makeRequest(skipPath(entSecond), { method: "POST", ...auth(s, c, "key-allowance-2"), body: {} }),
    { params: Promise.resolve({ studentId: studentA1, entitlementId: entSecond }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.detail).toBe("skip_allowance_exceeded");
});
