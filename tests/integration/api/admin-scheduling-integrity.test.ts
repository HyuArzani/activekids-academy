/**
 * Phase B2.2.1 — Scheduling Integrity regression tests.
 *
 * Focused tests covering the confirmed defects fixed in this phase:
 *
 *   1. Timezone correctness — occurrence start_at/end_at are stored as the
 *      actual Jakarta wall-clock instants (UTC+7), not server-local time.
 *      The sandbox runs in UTC; before the fix, "Tuesday 15:00 Jakarta"
 *      was stored as 15:00 UTC (= 22:00 Jakarta Tuesday), 7 hours off.
 *   2. Effective-date validation — new version's effective_from must be
 *      strictly later than the previous active version's effective_from
 *      (rejects overlapping/contradictory periods).
 *   3. Slot deletion conflict — deleting a slot that has occurrences
 *      returns 409 CONFLICT with `slot_in_use`, not an opaque 500.
 *   4. Slot deletion from superseded version — returns 409 with
 *      `slot_in_superseded_version`.
 *   5. Audit trail — schedule_version.create records the superseded
 *      version id in `before`; schedule_slot.delete records the slot's
 *      weekday/time in `before`.
 *   6. Historical preservation — generating under a new version does NOT
 *      rewrite existing occurrences' schedule_version_id snapshot.
 *   7. Generation boundaries — weeksAhead=1 produces exactly 7 days
 *      (inclusive start, exclusive end), not 8.
 *   8. Idempotent replay — running the same generation twice produces
 *      no new rows and reports idempotent=true.
 *
 * Tests run under PgLite (NOT real PostgreSQL — concurrency behavior is
 * NOT verified here; see tests/integration/pg/ for PG tests, which are
 * skipped in-sandbox).
 */

import { test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
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
let admin: TestUser;
let classId: string;
// Cached login session — avoids hitting the per-minute rate limit (default
// 10 logins/min) when many tests in this file each need an authenticated
// principal. Re-login is forced only on the first call.
let cachedSession: { s: string; c: string } | null = null;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`,
    [ACADEMY_A_ID],
  );
  admin = await createTestUser(db, {
    email: "admin@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
  });
  classId = randomUUID();
  await db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'TestClass', 12, true);`,
    [classId, ACADEMY_A_ID],
  );
  // Reset the cached session on each new DB setup — the prior session
  // belongs to the previous in-memory DB instance.
  cachedSession = null;
});

afterEach(async () => {
  await teardownTestDb();
});

// Hoist the rate-limit reset so the first login in each test isn't blocked
// by leftover state from the prior test. (The rate limiter is in-memory
// per-process; this is a no-op for a fresh process.)
beforeAll(() => {
  cachedSession = null;
});

async function login(): Promise<{ s: string; c: string }> {
  if (cachedSession) return cachedSession;
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(
    await makeRequest("/api/auth/login", {
      method: "POST",
      body: { email: admin.email, password: admin.password },
    }),
  );
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  cachedSession = {
    s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!,
    c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]!,
  };
  return cachedSession;
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

/** Create an active schedule version and return its id. */
async function createVersion(effectiveFrom: string): Promise<string> {
  const { s, c } = await login();
  const { POST } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body: { effectiveFrom } },
    ),
    { params: Promise.resolve({ id: classId }) },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Create a slot in the given version. */
async function createSlot(
  versionId: string,
  slot: { weekday: number; startTime: string; endTime: string; capacityOverride?: number },
): Promise<string> {
  const { s, c } = await login();
  const { POST } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/schedule-versions/${versionId}/slots?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body: slot },
    ),
    { params: Promise.resolve({ id: versionId }) },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Generate occurrences via the admin endpoint. */
async function generateOccurrences(
  body: { weeksAhead: number; fromDate?: string },
): Promise<{ generated: number; idempotent: boolean }> {
  const { s, c } = await login();
  const { POST } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body },
    ),
    { params: Promise.resolve({ id: classId }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { generated: number; idempotent: boolean };
}

// ====================================================================
// 1. Timezone correctness
// ====================================================================

test("TIMEZONE: stored start_at is the Jakarta wall-clock instant (UTC+7), not server-local", async () => {
  // Server runs in UTC. A Tuesday 15:00-16:00 Jakarta slot must be stored
  // as start_at = 2026-01-06 08:00:00+00 (= 15:00 Jakarta), NOT as
  // 2026-01-06 15:00:00+00 (= 22:00 Jakarta, the pre-fix bug).
  const versionId = await createVersion("2026-01-01");
  await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });

  await generateOccurrences({ weeksAhead: 2, fromDate: "2026-01-04" });

  // Verify the stored start_at directly from the DB.
  const result = await db.query<{ start_at: Date; occurrence_date: Date }>(
    `SELECT start_at, occurrence_date FROM training_occurrences WHERE class_id = $1 ORDER BY start_at LIMIT 1;`,
    [classId],
  );
  expect(result.rows.length).toBeGreaterThan(0);
  const row = result.rows[0] as { start_at: Date; occurrence_date: Date };
  const startUtc = row.start_at.toISOString();
  // Expected: 2026-01-06 08:00:00.000Z (Tuesday 15:00 Jakarta = 08:00 UTC).
  expect(startUtc).toBe("2026-01-06T08:00:00.000Z");

  // occurrence_date is a DATE column; verify it's Tuesday 2026-01-06
  // (Jakarta calendar date). The DB driver returns it as a Date at UTC
  // midnight of that calendar day.
  const occDate = row.occurrence_date.toISOString();
  expect(occDate).toBe("2026-01-06T00:00:00.000Z");
});

test("TIMEZONE: listing API renders startAt as Jakarta wall-clock HH:MM", async () => {
  const versionId = await createVersion("2026-01-01");
  await createSlot(versionId, { weekday: 6, startTime: "09:00", endTime: "10:30" });
  await generateOccurrences({ weeksAhead: 1, fromDate: "2026-01-04" });

  const { s } = await login();
  const { GET } = await import("@/app/api/admin/classes/[id]/occurrences/route.ts");
  const res = await GET(
    await makeRequest(`/api/admin/classes/${classId}/occurrences?academyId=${ACADEMY_A_ID}`, noAuth(s)),
    { params: Promise.resolve({ id: classId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { startAt: string }[] };
  expect(json.occurrences.length).toBeGreaterThan(0);
  // The API formats start_at as 'YYYY-MM-DD"T"HH24:MI:SS"Z"' in
  // Asia/Jakarta. The Saturday 09:00 Jakarta slot must render as
  // "2026-01-10T09:00:00Z" (literal Z suffix, Jakarta wall-clock).
  // Pre-fix bug: it would render as "2026-01-10T16:00:00Z" (16:00 = 09:00
  // Jakarta interpreted as server-local UTC, then displayed as Jakarta).
  expect(json.occurrences[0]!.startAt).toBe("2026-01-10T09:00:00Z");
});

// ====================================================================
// 2. Effective-date validation
// ====================================================================

test("EFFECTIVE_DATE: new effectiveFrom < previous is rejected with 422", async () => {
  // First version effective 2026-03-01.
  await createVersion("2026-03-01");
  // Try to create a new active version effective 2026-02-01 (earlier).
  const { s, c } = await login();
  const { POST } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-02-01" } },
    ),
    { params: Promise.resolve({ id: classId }) },
  );
  expect(res.status).toBe(422);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.code).toBe("VALIDATION_FAILED");
  expect(json.error.detail).toContain("before_previous_effective_date");
  expect(json.error.detail).toContain("2026-03-01");
});

test("EFFECTIVE_DATE: new effectiveFrom == previous is rejected with 422", async () => {
  await createVersion("2026-03-01");
  const { s, c } = await login();
  const { POST } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-03-01" } },
    ),
    { params: Promise.resolve({ id: classId }) },
  );
  expect(res.status).toBe(422);
});

test("EFFECTIVE_DATE: first version has no previous — no overlap check applies", async () => {
  // No prior version; creating the first active version with any valid
  // date must succeed (no "previous version" comparison).
  const versionId = await createVersion("2026-01-01");
  expect(versionId).toBeTruthy();
});

// ====================================================================
// 3. Slot deletion conflict (referenced by occurrences)
// ====================================================================

test("SLOT_DELETE: deleting a slot referenced by occurrences returns 409 slot_in_use", async () => {
  const versionId = await createVersion("2026-01-01");
  const slotId = await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  await generateOccurrences({ weeksAhead: 1, fromDate: "2026-01-04" });

  const { s, c } = await login();
  const { DELETE } = await import("@/app/api/admin/schedule-slots/[id]/route.ts");
  const res = await DELETE(
    await makeRequest(
      `/api/admin/schedule-slots/${slotId}?academyId=${ACADEMY_A_ID}`,
      { method: "DELETE", ...auth(s, c) },
    ),
    { params: Promise.resolve({ id: slotId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string; message?: string } };
  expect(json.error.code).toBe("CONFLICT");
  expect(json.error.detail).toBe("slot_in_use");
  expect(json.error.message).toMatch(/occurrences reference/i);
});

test("SLOT_DELETE: deleting an unreferenced slot succeeds with 200", async () => {
  const versionId = await createVersion("2026-01-01");
  const slotId = await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  // No occurrences generated — slot should be deletable.
  const { s, c } = await login();
  const { DELETE } = await import("@/app/api/admin/schedule-slots/[id]/route.ts");
  const res = await DELETE(
    await makeRequest(
      `/api/admin/schedule-slots/${slotId}?academyId=${ACADEMY_A_ID}`,
      { method: "DELETE", ...auth(s, c) },
    ),
    { params: Promise.resolve({ id: slotId }) },
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean };
  expect(json.ok).toBe(true);
});

// ====================================================================
// 4. Slot deletion from superseded version
// ====================================================================

test("SLOT_DELETE: deleting a slot from a superseded version returns 409", async () => {
  const v1Id = await createVersion("2026-01-01");
  const slotId = await createSlot(v1Id, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  // Supersede v1 by creating v2.
  await createVersion("2026-03-01");

  const { s, c } = await login();
  const { DELETE } = await import("@/app/api/admin/schedule-slots/[id]/route.ts");
  const res = await DELETE(
    await makeRequest(
      `/api/admin/schedule-slots/${slotId}?academyId=${ACADEMY_A_ID}`,
      { method: "DELETE", ...auth(s, c) },
    ),
    { params: Promise.resolve({ id: slotId }) },
  );
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: { code: string; detail?: string } };
  expect(json.error.code).toBe("CONFLICT");
  expect(json.error.detail).toBe("slot_in_superseded_version");
});

// ====================================================================
// 5. Audit trail
// ====================================================================

test("AUDIT: schedule_version.create records superseded version id in before", async () => {
  const v1Id = await createVersion("2026-01-01");
  const v2Id = await createVersion("2026-03-01");

  // Find the audit event for v2 creation.
  const auditResult = await db.query<{
    target_id: string;
    before: { supersededVersionId: string } | null;
    after: { effectiveFrom: string; status: string };
  }>(
    `SELECT target_id, before, after FROM audit_events
      WHERE action = 'schedule_version.create' AND target_id = $1
      LIMIT 1;`,
    [v2Id],
  );
  expect(auditResult.rows.length).toBe(1);
  const row = auditResult.rows[0] as typeof auditResult.rows extends Array<infer T> ? T : never;
  const audit = row as unknown as {
    target_id: string;
    before: { supersededVersionId: string; supersededEffectiveFrom: string } | null;
    after: { effectiveFrom: string; status: string };
  };
  expect(audit.before).not.toBeNull();
  expect(audit.before!.supersededVersionId).toBe(v1Id);
  expect(audit.before!.supersededEffectiveFrom).toBe("2026-01-01");
  expect(audit.after.effectiveFrom).toBe("2026-03-01");
  expect(audit.after.status).toBe("active");
});

test("AUDIT: schedule_slot.delete records slot details in before", async () => {
  const versionId = await createVersion("2026-01-01");
  const slotId = await createSlot(versionId, {
    weekday: 3,
    startTime: "17:00",
    endTime: "18:30",
    capacityOverride: 8,
  });

  const { s, c } = await login();
  const { DELETE } = await import("@/app/api/admin/schedule-slots/[id]/route.ts");
  const res = await DELETE(
    await makeRequest(
      `/api/admin/schedule-slots/${slotId}?academyId=${ACADEMY_A_ID}`,
      { method: "DELETE", ...auth(s, c) },
    ),
    { params: Promise.resolve({ id: slotId }) },
  );
  expect(res.status).toBe(200);

  const auditResult = await db.query<{
    before: Record<string, unknown> | null;
  }>(
    `SELECT before FROM audit_events
      WHERE action = 'schedule_slot.delete' AND target_id = $1
      LIMIT 1;`,
    [slotId],
  );
  expect(auditResult.rows.length).toBe(1);
  const before = (auditResult.rows[0] as { before: Record<string, unknown> | null }).before;
  expect(before).not.toBeNull();
  expect(before!.weekday).toBe(3);
  expect(before!.startTime).toBe("17:00");
  expect(before!.endTime).toBe("18:30");
  expect(before!.capacityOverride).toBe(8);
  expect(before!.scheduleVersionId).toBe(versionId);
});

test("AUDIT: occurrences.generate records generated count and horizon in after", async () => {
  const versionId = await createVersion("2026-01-01");
  await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  await generateOccurrences({ weeksAhead: 2, fromDate: "2026-01-04" });

  const auditResult = await db.query<{
    after: Record<string, unknown> | null;
  }>(
    `SELECT after FROM audit_events
      WHERE action = 'occurrences.generate' AND academy_id = $1
      ORDER BY occurred_at DESC LIMIT 1;`,
    [ACADEMY_A_ID],
  );
  expect(auditResult.rows.length).toBe(1);
  const after = (auditResult.rows[0] as { after: Record<string, unknown> | null }).after;
  expect(after).not.toBeNull();
  expect(after!.generated).toBe(2); // 2 Tuesdays in 2 weeks (Jan 6, Jan 13).
  expect(after!.weeksAhead).toBe(2);
  expect(after!.fromDate).toBe("2026-01-04");
  expect(after!.horizonStartUtc).toBeTruthy();
  expect(after!.horizonEndUtc).toBeTruthy();
});

// ====================================================================
// 6. Historical preservation under regeneration
// ====================================================================

test("PRESERVE: generating under a new version does NOT rewrite existing occurrences", async () => {
  const v1Id = await createVersion("2026-01-01");
  await createSlot(v1Id, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  await generateOccurrences({ weeksAhead: 2, fromDate: "2026-01-04" });

  // Snapshot the original occurrences' (id, schedule_version_id).
  const before = await db.query<{ id: string; sv: string; occ_date: Date; start_at: Date }>(
    `SELECT id, schedule_version_id AS sv, occurrence_date AS occ_date, start_at
       FROM training_occurrences WHERE class_id = $1;`,
    [classId],
  );
  const beforeRows = before.rows as { id: string; sv: string; occ_date: Date; start_at: Date }[];
  expect(beforeRows.length).toBe(2);

  // Create v2 (supersedes v1) with the same Tuesday 15:00 slot.
  const v2Id = await createVersion("2026-03-01");
  await createSlot(v2Id, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  // Generate occurrences under v2 from a date after v2's effective_from.
  await generateOccurrences({ weeksAhead: 1, fromDate: "2026-03-03" });

  // The original occurrences MUST still reference v1 (immutable snapshot).
  const after = await db.query<{ id: string; sv: string; occ_date: Date; start_at: Date }>(
    `SELECT id, schedule_version_id AS sv, occurrence_date AS occ_date, start_at
       FROM training_occurrences WHERE class_id = $1;`,
    [classId],
  );
  const afterRows = after.rows as { id: string; sv: string; occ_date: Date; start_at: Date }[];

  for (const beforeRow of beforeRows) {
    const afterRow = afterRows.find((r) => r.id === beforeRow.id);
    expect(afterRow).toBeDefined();
    expect(afterRow!.sv).toBe(v1Id); // Still v1.
    expect(afterRow!.occ_date.getTime()).toBe(beforeRow.occ_date.getTime());
    expect(afterRow!.start_at.getTime()).toBe(beforeRow.start_at.getTime());
  }

  // The new occurrences (under v2) reference v2.
  const v2Occurrences = afterRows.filter((r) => r.sv === v2Id);
  expect(v2Occurrences.length).toBeGreaterThan(0);
});

// ====================================================================
// 7. Generation boundaries (inclusive start, exclusive end)
// ====================================================================

test("BOUNDARY: weeksAhead=1 produces exactly 7 days (Sun..Sat)", async () => {
  const versionId = await createVersion("2026-01-01");
  // Two slots: Tuesday and Sunday. The Sunday slot tests the boundary
  // (Sun Jan 4 is included; Sun Jan 11 must NOT be included with
  // weeksAhead=1).
  await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  await createSlot(versionId, { weekday: 0, startTime: "10:00", endTime: "11:00" });

  const result = await generateOccurrences({ weeksAhead: 1, fromDate: "2026-01-04" });
  // Sun Jan 4 + Tue Jan 6 + Sat... no, only Tue and Sun slots.
  // Days in [Jan 4, Jan 11): Sun Jan 4 (sun), Tue Jan 6 (tue).
  // = 2 occurrences.
  expect(result.generated).toBe(2);

  // Verify directly: count occurrences with occurrence_date in [Jan 4, Jan 11).
  const occResult = await db.query<{ d: string }>(
    `SELECT to_char(occurrence_date, 'YYYY-MM-DD') AS d
       FROM training_occurrences WHERE class_id = $1
       ORDER BY occurrence_date;`,
    [classId],
  );
  const dates = (occResult.rows as { d: string }[]).map((r) => r.d);
  expect(dates).toEqual(["2026-01-04", "2026-01-06"]);
});

test("BOUNDARY: weeksAhead=2 produces exactly 14 days (Sun..Sat x2)", async () => {
  const versionId = await createVersion("2026-01-01");
  await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  await createSlot(versionId, { weekday: 0, startTime: "10:00", endTime: "11:00" });

  const result = await generateOccurrences({ weeksAhead: 2, fromDate: "2026-01-04" });
  // Sundays: Jan 4, Jan 11. Tuesdays: Jan 6, Jan 13. = 4 occurrences.
  // (Note: Jan 18 Sunday is NOT included — exclusive end.)
  expect(result.generated).toBe(4);
});

// ====================================================================
// 8. Idempotent replay
// ====================================================================

test("IDEMPOTENT: running the same generation twice produces no new rows", async () => {
  const versionId = await createVersion("2026-01-01");
  await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });

  const r1 = await generateOccurrences({ weeksAhead: 2, fromDate: "2026-01-04" });
  expect(r1.generated).toBe(2); // Tue Jan 6, Tue Jan 13.
  expect(r1.idempotent).toBe(false);

  const r2 = await generateOccurrences({ weeksAhead: 2, fromDate: "2026-01-04" });
  expect(r2.generated).toBe(0);
  expect(r2.idempotent).toBe(true);

  const countResult = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM training_occurrences WHERE class_id = $1;`,
    [classId],
  );
  expect((countResult.rows[0] as { c: number }).c).toBe(2);
});

// ====================================================================
// 9. Capacity snapshot (occurrence.capacity is preserved across class edits)
// ====================================================================

test("CAPACITY: occurrence.capacity is a snapshot — class capacity change does NOT affect existing occurrences", async () => {
  const versionId = await createVersion("2026-01-01");
  await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });
  await generateOccurrences({ weeksAhead: 1, fromDate: "2026-01-04" });

  // Snapshot the occurrence capacity (should be 12, the class default).
  const before = await db.query<{ cap: number }>(
    `SELECT capacity AS cap FROM training_occurrences WHERE class_id = $1 LIMIT 1;`,
    [classId],
  );
  expect((before.rows[0] as { cap: number }).cap).toBe(12);

  // Reduce class capacity to 5.
  const { s, c } = await login();
  const { PUT } = await import("@/app/api/admin/classes/[id]/route.ts");
  const putRes = await PUT(
    await makeRequest(
      `/api/admin/classes/${classId}?academyId=${ACADEMY_A_ID}`,
      { method: "PUT", ...auth(s, c), body: { capacity: 5 } },
    ),
    { params: Promise.resolve({ id: classId }) },
  );
  expect(putRes.status).toBe(200);

  // Existing occurrences' capacity MUST be unchanged (snapshot).
  const after = await db.query<{ cap: number }>(
    `SELECT capacity AS cap FROM training_occurrences WHERE class_id = $1 LIMIT 1;`,
    [classId],
  );
  expect((after.rows[0] as { cap: number }).cap).toBe(12);
});

// ====================================================================
// 10. Cross-academy isolation (slot deletion)
// ====================================================================

test("CROSS_ACADEMY: slot deletion from another academy returns 404", async () => {
  // Create academy B + class in B + slot in B.
  const ACADEMY_B_ID = "b0000000-0000-0000-0000-000000000002";
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`,
    [ACADEMY_B_ID],
  );
  const classBId = randomUUID();
  await db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'ClassB', 10, true);`,
    [classBId, ACADEMY_B_ID],
  );
  // Create a version + slot in academy B via direct DB insert.
  const vBId = randomUUID();
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`,
    [vBId, classBId],
  );
  const slotBId = randomUUID();
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`,
    [slotBId, vBId],
  );

  // Admin from academy A attempts to delete academy B's slot via academy A's
  // academyId in the query (which is what the principal is authorized for).
  const { s, c } = await login();
  const { DELETE } = await import("@/app/api/admin/schedule-slots/[id]/route.ts");
  const res = await DELETE(
    await makeRequest(
      `/api/admin/schedule-slots/${slotBId}?academyId=${ACADEMY_A_ID}`,
      { method: "DELETE", ...auth(s, c) },
    ),
    { params: Promise.resolve({ id: slotBId }) },
  );
  // Must NOT delete — academy isolation.
  expect([403, 404]).toContain(res.status);
  // Verify the slot is still in the DB.
  const check = await db.query<{ id: string }>(`SELECT id FROM schedule_slots WHERE id = $1;`, [slotBId]);
  expect((check.rows[0] as { id: string } | undefined)?.id).toBe(slotBId);
});

// ====================================================================
// 11. Unauthenticated / unauthorized
// ====================================================================

test("AUTH: slot deletion without session returns 401", async () => {
  const versionId = await createVersion("2026-01-01");
  const slotId = await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });

  const { DELETE } = await import("@/app/api/admin/schedule-slots/[id]/route.ts");
  const res = await DELETE(
    await makeRequest(
      `/api/admin/schedule-slots/${slotId}?academyId=${ACADEMY_A_ID}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: slotId }) },
  );
  expect(res.status).toBe(401);
});

test("AUTH: slot deletion without CSRF returns 403", async () => {
  const versionId = await createVersion("2026-01-01");
  const slotId = await createSlot(versionId, { weekday: 2, startTime: "15:00", endTime: "16:00" });

  const { s } = await login();
  const { DELETE } = await import("@/app/api/admin/schedule-slots/[id]/route.ts");
  // Session cookie present but no CSRF token header.
  const res = await DELETE(
    await makeRequest(
      `/api/admin/schedule-slots/${slotId}?academyId=${ACADEMY_A_ID}`,
      { method: "DELETE", cookies: { [sessionCookieName()]: s } },
    ),
    { params: Promise.resolve({ id: slotId }) },
  );
  expect(res.status).toBe(403);
});

// ====================================================================
// 12. Schedule-version "no active version" generation failure
// ====================================================================

test("GEN_NO_VERSION: generating without an active version returns 409", async () => {
  // No schedule version created for this class — generation must fail.
  const { s, c } = await login();
  const { POST } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  const res = await POST(
    await makeRequest(
      `/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`,
      { method: "POST", ...auth(s, c), body: { weeksAhead: 4 } },
    ),
    { params: Promise.resolve({ id: classId }) },
  );
  expect(res.status).toBe(409);
});
