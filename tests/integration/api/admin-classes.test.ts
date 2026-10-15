/**
 * API integration tests: Admin class CRUD + schedule version + slot + occurrence generation.
 *
 * Tests the actual route handlers against in-memory PgLite.
 * NOT real PostgreSQL — concurrency behavior is NOT verified here.
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
let classId: string;
let classBId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  adminB = await createTestUser(db, { email: "admin-b@example.com", password: "password123", role: "admin", academyId: ACADEMY_B_ID });
  classId = randomUUID();
  classBId = randomUUID();
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class A', 12);`, [classId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Class B', 10);`, [classBId, ACADEMY_B_ID]);
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
function auth(s: string, c: string) { return { cookies: { [sessionCookieName()]: s, [csrfCookieName()]: c }, headers: { [CSRF_HEADER]: c } }; }
function noAuth(s: string) { return { cookies: { [sessionCookieName()]: s } }; }

// === Class CRUD =========================================================

test("Create class returns 201", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/classes/route");
  const res = await POST(await makeRequest(`/api/admin/classes?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { name: "New Class" } }), { params: Promise.resolve({}) });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string; name: string };
  expect(json.name).toBe("New Class");
});

test("List classes returns 200 with academy-scoped data", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/classes/route");
  const res = await GET(await makeRequest(`/api/admin/classes?academyId=${ACADEMY_A_ID}`, noAuth(s)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { classes: { name: string }[] };
  expect(json.classes.length).toBe(1);
  expect(json.classes[0]!.name).toBe("Class A");
});

test("Get class detail returns 200", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/classes/[id]/route.ts");
  const res = await GET(await makeRequest(`/api/admin/classes/${classId}?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { name: string };
  expect(json.name).toBe("Class A");
});

test("Update class returns 200", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PUT } = await import("@/app/api/admin/classes/[id]/route.ts");
  const res = await PUT(await makeRequest(`/api/admin/classes/${classId}?academyId=${ACADEMY_A_ID}`, { method: "PUT", ...auth(s, c), body: { name: "Updated Class" } }), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { name: string };
  expect(json.name).toBe("Updated Class");
});

test("Cross-academy class access returns 404", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/classes/[id]/route.ts");
  const res = await GET(await makeRequest(`/api/admin/classes/${classBId}?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ id: classBId }) });
  expect(res.status).toBe(404);
});

// === Schedule Versions ==================================================

test("Create schedule version returns 201", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const res = await POST(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { status: string };
  expect(json.status).toBe("active");
});

test("List schedule versions returns 200", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  await POST(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  const { GET } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const res = await GET(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { versions: { status: string }[] };
  expect(json.versions.length).toBe(1);
  expect(json.versions[0]!.status).toBe("active");
});

test("Creating a new version supersedes the previous active one", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const ctx = { params: Promise.resolve({ id: classId }) };
  await POST(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), ctx);
  await POST(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-03-01" } }), ctx);
  const { GET } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const res = await GET(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, noAuth(s)), ctx);
  const json = (await res.json()) as { versions: { status: string; effectiveTo: string | null }[] };
  expect(json.versions.length).toBe(2);
  const active = json.versions.find((v) => v.status === "active");
  const superseded = json.versions.find((v) => v.status === "superseded");
  expect(active).toBeDefined();
  expect(superseded).toBeDefined();
  expect(superseded!.effectiveTo).not.toBe(null);
});

// === Schedule Slots =====================================================

test("Create slot returns 201", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: verPost } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const verRes = await verPost(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  const ver = (await verRes.json()) as { id: string };
  const { POST: slotPost } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  const res = await slotPost(await makeRequest(`/api/admin/schedule-versions/${ver.id}/slots?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weekday: 2, startTime: "15:00", endTime: "16:00" } }), { params: Promise.resolve({ id: ver.id }) });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { weekday: number; startTime: string };
  expect(json.weekday).toBe(2);
  expect(json.startTime).toBe("15:00");
});

test("Slot validation: end time must be after start time", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: verPost } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const verRes = await verPost(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  const ver = (await verRes.json()) as { id: string };
  const { POST: slotPost } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  const res = await slotPost(await makeRequest(`/api/admin/schedule-versions/${ver.id}/slots?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weekday: 2, startTime: "16:00", endTime: "15:00" } }), { params: Promise.resolve({ id: ver.id }) });
  expect(res.status).toBe(422);
});

test("List slots returns 200", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: verPost } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const verRes = await verPost(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  const ver = (await verRes.json()) as { id: string };
  const { POST: slotPost } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  await slotPost(await makeRequest(`/api/admin/schedule-versions/${ver.id}/slots?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weekday: 6, startTime: "09:00", endTime: "10:00" } }), { params: Promise.resolve({ id: ver.id }) });
  const { GET: slotGet } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  const res = await slotGet(await makeRequest(`/api/admin/schedule-versions/${ver.id}/slots?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ id: ver.id }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { slots: { weekday: number }[] };
  expect(json.slots.length).toBe(1);
  expect(json.slots[0]!.weekday).toBe(6);
});

// === Occurrence Generation ==============================================

test("Generate occurrences returns 200 with count", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: verPost } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const verRes = await verPost(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  const ver = (await verRes.json()) as { id: string };
  const { POST: slotPost } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  await slotPost(await makeRequest(`/api/admin/schedule-versions/${ver.id}/slots?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weekday: 2, startTime: "15:00", endTime: "16:00" } }), { params: Promise.resolve({ id: ver.id }) });
  const { POST: genPost } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  const res = await genPost(await makeRequest(`/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weeksAhead: 4 } }), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { generated: number; idempotent: boolean };
  expect(json.generated).toBeGreaterThan(0);
  expect(json.idempotent).toBe(false);
});

test("Idempotent generation: running twice creates no new occurrences", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: verPost } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const verRes = await verPost(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  const ver = (await verRes.json()) as { id: string };
  const { POST: slotPost } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  await slotPost(await makeRequest(`/api/admin/schedule-versions/${ver.id}/slots?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weekday: 2, startTime: "15:00", endTime: "16:00" } }), { params: Promise.resolve({ id: ver.id }) });
  const { POST: genPost } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  const ctx = { params: Promise.resolve({ id: classId }) };
  await genPost(await makeRequest(`/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weeksAhead: 4 } }), ctx);
  const res2 = await genPost(await makeRequest(`/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weeksAhead: 4 } }), ctx);
  const json2 = (await res2.json()) as { generated: number; idempotent: boolean };
  expect(json2.generated).toBe(0);
  expect(json2.idempotent).toBe(true);
});

test("Generate without active version returns 409", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: genPost } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  const res = await genPost(await makeRequest(`/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weeksAhead: 4 } }), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(409);
});

test("Generate with excessive weeks (>52) returns 422", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: genPost } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  const res = await genPost(await makeRequest(`/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weeksAhead: 100 } }), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(422);
});

test("List occurrences returns 200", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: verPost } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const verRes = await verPost(await makeRequest(`/api/admin/classes/${classId}/schedule-versions?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { effectiveFrom: "2026-01-01" } }), { params: Promise.resolve({ id: classId }) });
  const ver = (await verRes.json()) as { id: string };
  const { POST: slotPost } = await import("@/app/api/admin/schedule-versions/[id]/slots/route.ts");
  await slotPost(await makeRequest(`/api/admin/schedule-versions/${ver.id}/slots?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weekday: 2, startTime: "15:00", endTime: "16:00" } }), { params: Promise.resolve({ id: ver.id }) });
  const { POST: genPost } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  await genPost(await makeRequest(`/api/admin/classes/${classId}/generate-occurrences?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weeksAhead: 4 } }), { params: Promise.resolve({ id: classId }) });
  const { GET: occGet } = await import("@/app/api/admin/classes/[id]/occurrences/route.ts");
  const res = await occGet(await makeRequest(`/api/admin/classes/${classId}/occurrences?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ id: classId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { occurrences: { id: string }[] };
  expect(json.occurrences.length).toBeGreaterThan(0);
});

// === Cross-academy isolation ===========================================

test("Schedule version cross-academy returns 404", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/classes/[id]/schedule-versions/route.ts");
  const res = await GET(await makeRequest(`/api/admin/classes/${classBId}/schedule-versions?academyId=${ACADEMY_A_ID}`, noAuth(s)), { params: Promise.resolve({ id: classBId }) });
  expect(res.status).toBe(404);
});

test("Generate occurrences cross-academy returns 404 or 403", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: genPost } = await import("@/app/api/admin/classes/[id]/generate-occurrences/route.ts");
  const res = await genPost(await makeRequest(`/api/admin/classes/${classBId}/generate-occurrences?academyId=${ACADEMY_A_ID}`, { method: "POST", ...auth(s, c), body: { weeksAhead: 4 } }), { params: Promise.resolve({ id: classBId }) });
  expect([403, 404]).toContain(res.status);
});
