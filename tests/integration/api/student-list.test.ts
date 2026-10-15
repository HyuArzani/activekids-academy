/**
 * API integration tests: Student list (Stage 7A — reuses the existing
 * GET /api/admin/students endpoint). Verifies the contract the UI depends on.
 *
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
let studentA1: string;
let studentA2: string;
let studentB1: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });

  studentA1 = randomUUID();
  studentA2 = randomUUID();
  studentB1 = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth, gender, notes) VALUES ($1, $2, 'Andi Wijaya', '2015-03-15', 'male', 'Goalkeeper');`, [studentA1, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Budi Santoso');`, [studentA2, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Other Academy Student');`, [studentB1, ACADEMY_B_ID]);
});

afterEach(async () => { await teardownTestDb(); });

async function login(email: string, pw: string): Promise<{ s: string; c: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(await makeRequest("/api/auth/login", { method: "POST", body: { email, password: pw } }));
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  return { s: new RegExp(`${sessionCookieName()}=([^;]+)`).exec(sc)![1]!, c: new RegExp(`${csrfCookieName()}=([^;]+)`).exec(sc)![1]! };
}

test("GET students returns academy-scoped list (200)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/route");
  const res = await GET(await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { students: { id: string; full_name: string }[] };
  expect(json.students.length).toBe(2);
  expect(json.students.some((st) => st.full_name === "Andi Wijaya")).toBe(true);
  expect(json.students.some((st) => st.full_name === "Budi Santoso")).toBe(true);
  // Cross-academy student excluded.
  expect(json.students.some((st) => st.id === studentB1)).toBe(false);
});

test("GET students returns all fields the UI displays", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/route");
  const res = await GET(await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const json = (await res.json()) as { students: { id: string; full_name: string; date_of_birth: string | null; gender: string | null; notes: string | null; archived_at: string | null }[] };
  const andi = json.students.find((st) => st.full_name === "Andi Wijaya");
  expect(andi).toBeDefined();
  expect(andi!.date_of_birth).toBeTruthy();
  expect(andi!.gender).toBe("male");
  expect(andi!.notes).toBe("Goalkeeper");
  expect(andi!.archived_at).toBeNull();
});

test("GET students empty state — academy with no students", async () => {
  // Delete academy A's students.
  await db.query(`DELETE FROM students WHERE academy_id = $1;`, [ACADEMY_A_ID]);
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/route");
  const res = await GET(await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { students: unknown[] };
  expect(json.students.length).toBe(0);
});

test("GET students rejects coach (403)", async () => {
  const { s } = await login(coachA.email, coachA.password);
  const { GET } = await import("@/app/api/admin/students/route");
  const res = await GET(await makeRequest(`/api/admin/students?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});

test("GET students rejects missing academyId (422)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/route");
  const res = await GET(await makeRequest(`/api/admin/students`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(422);
});

test("GET students rejects non-member academy (403)", async () => {
  const { s } = await login(adminA.email, adminA.password);
  const { GET } = await import("@/app/api/admin/students/route");
  // adminA is a member of A only — requesting B is forbidden.
  const res = await GET(await makeRequest(`/api/admin/students?academyId=${ACADEMY_B_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(403);
});
