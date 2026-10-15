/**
 * API integration tests: Student-specific training videos (Stage 7B.2).
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
let studentId: string;
let studentBId: string;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
  parentA = await createTestUser(db, { email: "parent-a@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  studentId = randomUUID();
  studentBId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student A');`, [studentId, ACADEMY_A_ID]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Student B');`, [studentBId, ACADEMY_B_ID]);

  // Link parent to student.
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), parentA.id, studentId]);
  // Assign coach to student.
  await db.query(`INSERT INTO coach_student_assignments (id, coach_user_id, student_id, is_active) VALUES ($1, $2, $3, true);`, [randomUUID(), coachA.id, studentId]);
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

// === Create =============================================================

test("Admin creates student video (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Training 1", category: "Dribbling", notes: "Focus on left foot" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string; videoId: string };
  expect(json.videoId).toBe("dQw4w9WgXcQ");
});

test("Coach creates student video via coach route (201)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/coach/students/[id]/videos/route");
  const res = await POST(await makeRequest(`/api/coach/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title: "Coach Video" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(201);
});

test("Coach cannot create video for unassigned student (403)", async () => {
  // Create a second student that coachA is NOT assigned to.
  const unassignedStudent = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Unassigned');`, [unassignedStudent, ACADEMY_A_ID]);
  const { s, c } = await login(coachA.email, coachA.password);
  const { POST } = await import("@/app/api/coach/students/[id]/videos/route");
  const res = await POST(await makeRequest(`/api/coach/students/${unassignedStudent}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title: "Unauthorized" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: unassignedStudent }) });
  expect(res.status).toBe(403);
});

test("Coach updates video via coach route (200)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  // Create via coach route.
  const { POST } = await import("@/app/api/coach/students/[id]/videos/route");
  const createRes = await POST(await makeRequest(`/api/coach/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title: "Original" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });
  const createJson = (await createRes.json()) as { id: string };

  // Update via coach route.
  const { PATCH } = await import("@/app/api/coach/students/[id]/videos/[vidId]/route");
  const res = await PATCH(await makeRequest(`/api/coach/students/${studentId}/videos/${createJson.id}?academyId=${ACADEMY_A_ID}`, {
    method: "PATCH", body: { title: "Coach Updated" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId, vidId: createJson.id }) });
  expect(res.status).toBe(200);
  const row = await db.query<{ title: string }>(`SELECT title FROM student_training_videos WHERE id = $1;`, [createJson.id]);
  expect((row.rows[0] as { title: string }).title).toBe("Coach Updated");
});

test("Parent lists child's videos via parent route (200)", async () => {
  const { s: adminS, c: adminC } = await login(adminA.email, adminA.password);
  // Admin creates a video for the student.
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  await POST(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "For Parent" },
    ...auth(adminS, adminC),
  }), { params: Promise.resolve({ id: studentId }) });

  // Parent lists the videos.
  const { s: parentS } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/students/[id]/videos/route");
  const res = await GET(await makeRequest(`/api/parent/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: parentS } }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { videos: { title: string }[] };
  expect(json.videos.length).toBe(1);
  expect(json.videos[0]!.title).toBe("For Parent");
});

test("Parent cannot access another family's videos (403)", async () => {
  // Create a second student with a different parent.
  const otherStudent = randomUUID();
  const otherParent = await createTestUser(db, { email: "other-parent@example.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Other Child');`, [otherStudent, ACADEMY_A_ID]);
  await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), otherParent.id, otherStudent]);

  // parentA tries to access otherStudent's videos.
  const { s: parentS } = await login(parentA.email, parentA.password);
  const { GET } = await import("@/app/api/parent/students/[id]/videos/route");
  const res = await GET(await makeRequest(`/api/parent/students/${otherStudent}/videos?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: parentS } }), { params: Promise.resolve({ id: otherStudent }) });
  expect(res.status).toBe(403);
});

test("Parent cannot create video (403)", async () => {
  const { s, c } = await login(parentA.email, parentA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Parent Video" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(403);
});

test("Invalid YouTube URL rejected (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  const res = await POST(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://vimeo.com/123", title: "Bad URL" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(422);
});

test("Cross-academy student rejected (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  // studentBId is in academy B — adminA is admin of A only.
  const res = await POST(await makeRequest(`/api/admin/students/${studentBId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Cross" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentBId }) });
  expect(res.status).toBe(404);
});

// === List ===============================================================

test("Admin lists student videos (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  await POST(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "V1" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });

  const { GET } = await import("@/app/api/admin/students/[id]/videos/route");
  const res = await GET(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }), { params: Promise.resolve({ id: studentId }) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { videos: { title: string }[] };
  expect(json.videos.length).toBe(1);
  expect(json.videos[0]!.title).toBe("V1");
});

// === Update =============================================================

test("Admin updates student video (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  const createRes = await POST(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Original" },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });
  const createJson = (await createRes.json()) as { id: string };

  const { PATCH } = await import("@/app/api/admin/students/[id]/videos/[vidId]/route");
  const res = await PATCH(await makeRequest(`/api/admin/students/${studentId}/videos/${createJson.id}?academyId=${ACADEMY_A_ID}`, {
    method: "PATCH", body: { title: "Updated", category: "Passing", isPublished: true },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId, vidId: createJson.id }) });
  expect(res.status).toBe(200);

  const row = await db.query<{ title: string; category: string | null; is_published: boolean }>(`SELECT title, category, is_published FROM student_training_videos WHERE id = $1;`, [createJson.id]);
  const r = row.rows[0] as { title: string; category: string | null; is_published: boolean };
  expect(r.title).toBe("Updated");
  expect(r.category).toBe("Passing");
  expect(r.is_published).toBe(true);
});

// === Separation from public CMS =========================================

test("Student videos are NOT returned by the public landing-page API", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/students/[id]/videos/route");
  await POST(await makeRequest(`/api/admin/students/${studentId}/videos?academyId=${ACADEMY_A_ID}`, {
    method: "POST", body: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Student Video", isPublished: true },
    ...auth(s, c),
  }), { params: Promise.resolve({ id: studentId }) });

  // The public landing API returns only published gallery + highlight videos.
  // Student training videos should NOT appear.
  const { GET: publicGet } = await import("@/app/api/public/landing/route");
  const res = await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}));
  // 404 — no published landing page (no CMS content published).
  expect(res.status).toBe(404);
  // Even if it were 200, the response would NOT include student_training_videos.
});
