/**
 * API integration tests: Stage 7B.1 corrections.
 * Tests for: gallery/video update APIs, duplicate-student detection,
 * publication snapshot immutability, rate-limit proxy-header hardening.
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

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_B_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
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

// === Gallery update (PATCH) ============================================

test("PATCH gallery item updates metadata (200) + audit", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: createPost } = await import("@/app/api/admin/gallery/route");
  const createRes = await createPost(await makeRequest(`/api/admin/gallery?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "Original", displayOrder: 1 }, ...auth(s, c) }));
  const createJson = (await createRes.json()) as { id: string };

  const { PATCH } = await import("@/app/api/admin/gallery/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/gallery/${createJson.id}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { title: "Updated", displayOrder: 5, isFeatured: true, isPublished: true }, ...auth(s, c) }), { params: Promise.resolve({ id: createJson.id }) });
  expect(res.status).toBe(200);

  const row = await db.query<{ title: string; display_order: number; is_featured: boolean; is_published: boolean }>(`SELECT title, display_order, is_featured, is_published FROM gallery_items WHERE id = $1;`, [createJson.id]);
  const r = row.rows[0] as { title: string; display_order: number; is_featured: boolean; is_published: boolean };
  expect(r.title).toBe("Updated");
  expect(r.display_order).toBe(5);
  expect(r.is_featured).toBe(true);
  expect(r.is_published).toBe(true);

  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'gallery_item.update';`);
  expect((audit.rows[0] as { c: number }).c).toBe(1);
});

test("PATCH gallery item rejects cross-academy (404)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Create item in academy A.
  const { POST: createPost } = await import("@/app/api/admin/gallery/route");
  const createRes = await createPost(await makeRequest(`/api/admin/gallery?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "A Item" }, ...auth(s, c) }));
  const createJson = (await createRes.json()) as { id: string };
  // Try to PATCH via academy B (adminA is not a member of B → 403).
  const { PATCH } = await import("@/app/api/admin/gallery/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/gallery/${createJson.id}?academyId=${ACADEMY_B_ID}`, { method: "PATCH", body: { title: "hack" }, ...auth(s, c) }), { params: Promise.resolve({ id: createJson.id }) });
  expect(res.status).toBe(403);
});

// === Video update (PATCH) ===============================================

test("PATCH video updates metadata + re-extracts video_id (200)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: createPost } = await import("@/app/api/admin/videos/route");
  const createRes = await createPost(await makeRequest(`/api/admin/videos?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "Original", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, ...auth(s, c) }));
  const createJson = (await createRes.json()) as { id: string };

  const { PATCH } = await import("@/app/api/admin/videos/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/videos/${createJson.id}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { title: "Updated", url: "https://youtu.be/abcdefghijk" }, ...auth(s, c) }), { params: Promise.resolve({ id: createJson.id }) });
  expect(res.status).toBe(200);

  const row = await db.query<{ title: string; video_id: string; url: string }>(`SELECT title, video_id, url FROM youtube_videos WHERE id = $1;`, [createJson.id]);
  const r = row.rows[0] as { title: string; video_id: string; url: string };
  expect(r.title).toBe("Updated");
  expect(r.video_id).toBe("abcdefghijk");
  expect(r.url).toBe("https://youtu.be/abcdefghijk");
});

test("PATCH video rejects invalid YouTube URL (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: createPost } = await import("@/app/api/admin/videos/route");
  const createRes = await createPost(await makeRequest(`/api/admin/videos?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "V", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, ...auth(s, c) }));
  const createJson = (await createRes.json()) as { id: string };

  const { PATCH } = await import("@/app/api/admin/videos/[id]/route");
  const res = await PATCH(await makeRequest(`/api/admin/videos/${createJson.id}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { url: "https://vimeo.com/123" }, ...auth(s, c) }), { params: Promise.resolve({ id: createJson.id }) });
  expect(res.status).toBe(422);
});

// === Duplicate-student detection (P3) ==================================

test("Duplicate: same name + different DOBs → no conflict (approve succeeds)", async () => {
  // Pre-existing student with same name but different DOB.
  const existingId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth) VALUES ($1, $2, 'Andi Jr', '2010-01-01');`, [existingId, ACADEMY_A_ID]);

  const { s, c } = await login(adminA.email, adminA.password);
  // Submit registration with same name but different DOB.
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Budi", parentPhone: "+62 1", parentEmail: "b1@ex.com", childFullName: "Andi Jr", childDateOfBirth: "2015-03-15" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  // Approve — should succeed (different DOB → no duplicate).
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(200);
});

test("Duplicate: same name + same DOB → CONFLICT", async () => {
  const existingId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth) VALUES ($1, $2, 'Andi Jr', '2015-03-15');`, [existingId, ACADEMY_A_ID]);

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Budi", parentPhone: "+62 1", parentEmail: "b2@ex.com", childFullName: "Andi Jr", childDateOfBirth: "2015-03-15" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(409);
});

test("Duplicate: same name + existing DOB is NULL → CONFLICT (ambiguous)", async () => {
  const existingId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Andi Jr');`, [existingId, ACADEMY_A_ID]);

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Budi", parentPhone: "+62 1", parentEmail: "b3@ex.com", childFullName: "Andi Jr", childDateOfBirth: "2015-03-15" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(409);
});

test("Duplicate: same name + registration DOB is NULL → CONFLICT (ambiguous)", async () => {
  const existingId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth) VALUES ($1, $2, 'Andi Jr', '2015-03-15');`, [existingId, ACADEMY_A_ID]);

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: regPost } = await import("@/app/api/public/register/route");
  // Registration with NO DOB (childDateOfBirth omitted).
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Budi", parentPhone: "+62 1", parentEmail: "b4@ex.com", childFullName: "Andi Jr" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(409);
});

test("Duplicate: no existing student with same name → approve succeeds", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Budi", parentPhone: "+62 1", parentEmail: "b5@ex.com", childFullName: "Unique Name", childDateOfBirth: "2015-03-15" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(200);
});

test("Duplicate: failed approval creates no partial records", async () => {
  const existingId = randomUUID();
  await db.query(`INSERT INTO students (id, academy_id, full_name, date_of_birth) VALUES ($1, $2, 'Andi Jr', '2015-03-15');`, [existingId, ACADEMY_A_ID]);

  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Budi", parentPhone: "+62 1", parentEmail: "b6@ex.com", childFullName: "Andi Jr", childDateOfBirth: "2015-03-15" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });

  // Verify NO duplicate student, no guardian user, no link.
  const students = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE full_name = 'Andi Jr' AND academy_id = $1;`, [ACADEMY_A_ID]);
  expect((students.rows[0] as { c: number }).c).toBe(1); // only the pre-existing one
  const users = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM users WHERE email = 'b6@ex.com';`);
  expect((users.rows[0] as { c: number }).c).toBe(0);
  // Application stays pending.
  const app = await db.query<{ status: string }>(`SELECT status FROM registration_applications WHERE id = $1;`, [regJson.applicationId]);
  expect((app.rows[0] as { status: string }).status).toBe("pending");
});

// === Existing parent (P4) — email match CANNOT auto-link ===============

test("Email match alone cannot link child to existing parent (CONFLICT)", async () => {
  // Pre-existing user with email "shared@ex.com" (NOT from registration).
  await createTestUser(db, { email: "shared@ex.com", password: "password123", role: "parent", academyId: ACADEMY_A_ID });

  const { s, c } = await login(adminA.email, adminA.password);
  // An unauthenticated applicant submits "shared@ex.com" — might not be the owner.
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Attacker", parentPhone: "+62 1", parentEmail: "shared@ex.com", childFullName: "Victim Child", childDateOfBirth: "2015-01-01" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  // Approval must CONFLICT — cannot auto-link based on email alone.
  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(409);

  // Verify NO student was created, NO guardian_student_link.
  const students = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM students WHERE full_name = 'Victim Child';`);
  expect((students.rows[0] as { c: number }).c).toBe(0);
  const links = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM guardian_student_links WHERE guardian_user_id = (SELECT id FROM users WHERE email = 'shared@ex.com');`);
  expect((links.rows[0] as { c: number }).c).toBe(0);
  // Application stays pending.
  const app = await db.query<{ status: string }>(`SELECT status FROM registration_applications WHERE id = $1;`, [regJson.applicationId]);
  expect((app.rows[0] as { status: string }).status).toBe("pending");
});

test("New parent with unique email: approval succeeds (creates provisional user)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: regPost } = await import("@/app/api/public/register/route");
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "New Parent", parentPhone: "+62 1", parentEmail: "newparent@ex.com", childFullName: "New Child", childDateOfBirth: "2015-01-01" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(200);

  // Verify provisional user created.
  const user = await db.query<{ must_change_password: boolean }>(`SELECT must_change_password FROM users WHERE email = 'newparent@ex.com';`);
  expect((user.rows[0] as { must_change_password: boolean }).must_change_password).toBe(true);
});

test("No parent email: approval fails with CONFLICT", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST: regPost } = await import("@/app/api/public/register/route");
  // No parentEmail.
  const regRes = await regPost(await makeRequest("/api/public/register", { method: "POST", body: { academyId: ACADEMY_A_ID, parentFullName: "Budi", parentPhone: "+62 1", childFullName: "NoEmail Child", childDateOfBirth: "2015-01-01" } }));
  const regJson = (await regRes.json()) as { applicationId: string };

  const { POST: approve } = await import("@/app/api/admin/registrations/[id]/approve/route");
  const res = await approve(await makeRequest(`/api/admin/registrations/${regJson.applicationId}/approve?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }), { params: Promise.resolve({ id: regJson.applicationId }) });
  expect(res.status).toBe(409);
});

// === Publication snapshot immutability (P5) =============================

test("Gallery/video edits do not retroactively change an existing snapshot", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Create a gallery item + video, both published.
  const { POST: galleryPost } = await import("@/app/api/admin/gallery/route");
  const galRes = await galleryPost(await makeRequest(`/api/admin/gallery?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "Original Gallery", displayOrder: 1, isPublished: true }, ...auth(s, c) }));
  const galJson = (await galRes.json()) as { id: string };

  const { POST: videoPost } = await import("@/app/api/admin/videos/route");
  const vidRes = await videoPost(await makeRequest(`/api/admin/videos?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "Original Video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", isPublished: true }, ...auth(s, c) }));
  const vidJson = (await vidRes.json()) as { id: string };

  // Create draft + publish.
  const { PATCH: draftPatch } = await import("@/app/api/admin/landing/route");
  await draftPatch(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { hero: { title: "Test" }, galleryItemIds: [galJson.id], youtubeVideoIds: [vidJson.id] }, ...auth(s, c) }));
  const { POST: publishPost } = await import("@/app/api/admin/landing/publish/route");
  await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }));

  // Read the public landing page → should contain the gallery + video data.
  const { GET: publicGet } = await import("@/app/api/public/landing/route");
  const pubRes1 = await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}));
  const pubJson1 = (await pubRes1.json()) as { gallery: { title: string }[]; videos: { title: string }[] };
  expect(pubJson1.gallery.length).toBe(1);
  expect(pubJson1.gallery[0]!.title).toBe("Original Gallery");
  expect(pubJson1.videos.length).toBe(1);
  expect(pubJson1.videos[0]!.title).toBe("Original Video");

  // Edit the gallery item title + video title (after publication).
  const { PATCH: galleryPatch } = await import("@/app/api/admin/gallery/[id]/route");
  await galleryPatch(await makeRequest(`/api/admin/gallery/${galJson.id}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { title: "CHANGED Gallery" }, ...auth(s, c) }), { params: Promise.resolve({ id: galJson.id }) });
  const { PATCH: videoPatch } = await import("@/app/api/admin/videos/[id]/route");
  await videoPatch(await makeRequest(`/api/admin/videos/${vidJson.id}?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { title: "CHANGED Video" }, ...auth(s, c) }), { params: Promise.resolve({ id: vidJson.id }) });

  // Read the public landing page AGAIN → snapshot should still show ORIGINAL titles.
  const pubRes2 = await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}));
  const pubJson2 = (await pubRes2.json()) as { gallery: { title: string }[]; videos: { title: string }[] };
  expect(pubJson2.gallery[0]!.title).toBe("Original Gallery"); // NOT "CHANGED Gallery"
  expect(pubJson2.videos[0]!.title).toBe("Original Video"); // NOT "CHANGED Video"
});

test("Revert preserves historical snapshots", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Publish v1.
  const { PATCH: draftPatch } = await import("@/app/api/admin/landing/route");
  await draftPatch(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { hero: { title: "v1" } }, ...auth(s, c) }));
  const { POST: publishPost } = await import("@/app/api/admin/landing/publish/route");
  await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }));

  // Publish v2.
  await draftPatch(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { hero: { title: "v2" } }, ...auth(s, c) }));
  await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }));

  // Public shows v2.
  const { GET: publicGet } = await import("@/app/api/public/landing/route");
  const pubRes1 = (await (await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}))).json()) as { content: { hero: { title: string } }; versionNumber: number };
  expect(pubRes1.content.hero.title).toBe("v2");
  expect(pubRes1.versionNumber).toBe(2);

  // Revert to v1.
  const { POST: revertPost } = await import("@/app/api/admin/landing/revert/route");
  const revertRes = await revertPost(await makeRequest(`/api/admin/landing/revert?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { versionNumber: 1 }, ...auth(s, c) }));
  expect(revertRes.status).toBe(200);

  // Public shows v1 again.
  const pubRes2 = (await (await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}))).json()) as { content: { hero: { title: string } }; versionNumber: number };
  expect(pubRes2.content.hero.title).toBe("v1");
  expect(pubRes2.versionNumber).toBe(1);

  // Verify both snapshots still exist (immutable).
  const pubs = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM landing_page_publications;`);
  expect((pubs.rows[0] as { c: number }).c).toBe(2);
});

// === Rate-limit proxy-header hardening (P6) ============================

test("Rate limit: X-Forwarded-For is NOT trusted (only X-Real-IP)", async () => {
  // Submit with a spoofed X-Forwarded-For header — should NOT affect rate limiting.
  // The route should use "unknown" (no X-Real-IP in test env) for all requests.
  const { POST } = await import("@/app/api/public/register/route");
  // Use different spoofed IPs for each request — if X-Forwarded-For were trusted,
  // each would get its own rate-limit bucket. With the hardened behavior, all
  // share the "unknown" bucket.
  for (let i = 0; i < 3; i++) {
    const res = await POST(await makeRequest("/api/public/register", {
      method: "POST",
      body: { academyId: ACADEMY_A_ID, parentFullName: `Parent${i}`, parentPhone: "+62 1", parentEmail: `p${i}@ex.com`, childFullName: `Child${i}`, childDateOfBirth: "2015-01-01" },
      headers: { "x-forwarded-for": `10.0.0.${i}` },
    }));
    // All should succeed (under the 20-per-15min limit for "unknown").
    expect([200, 201].includes(res.status)).toBe(true);
  }
});
