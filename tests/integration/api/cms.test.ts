/**
 * API integration tests: CMS (Stage 7B).
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
import { extractYoutubeVideoId } from "@/lib/domain/cms";

let db: DbClient;
let adminA: TestUser;
let coachA: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'B', 'b', 'Asia/Jakarta', true);`, [ACADEMY_A_ID.startsWith("a") ? ACADEMY_B_ID : ACADEMY_A_ID]);
  adminA = await createTestUser(db, { email: "admin-a@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });
  coachA = await createTestUser(db, { email: "coach-a@example.com", password: "password123", role: "coach", academyId: ACADEMY_A_ID });
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

const CONTENT = {
  hero: { title: "Futsal Academy", subtitle: "Train with the best", ctaText: "Register now" },
  about: { title: "About us", body: "We are a futsal academy." },
  programs: [{ name: "Beginner", description: "For new players" }],
};

// === Public landing page ================================================

test("Public API returns only published content", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  // Create draft.
  const { PATCH } = await import("@/app/api/admin/landing/route");
  await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: CONTENT, ...auth(s, c) }));

  // Public API before publish → 404 (draft not published).
  const { GET: publicGet } = await import("@/app/api/public/landing/route");
  const res1 = await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}));
  expect(res1.status).toBe(404);

  // Publish.
  const { POST: publishPost } = await import("@/app/api/admin/landing/publish/route");
  await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }));

  // Public API after publish → 200 with content.
  const res2 = await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}));
  expect(res2.status).toBe(200);
  const json = (await res2.json()) as { content: { hero: { title: string } }; academyName: string; versionNumber: number };
  expect(json.content.hero.title).toBe("Futsal Academy");
  expect(json.academyName).toBe("A");
  expect(json.versionNumber).toBe(1);
});

test("Draft content is never returned by the public API", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/landing/route");
  await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: CONTENT, ...auth(s, c) }));

  // Update the draft (don't publish).
  await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { ...CONTENT, hero: { ...CONTENT.hero, title: "CHANGED DRAFT" } }, ...auth(s, c) }));

  const { GET: publicGet } = await import("@/app/api/public/landing/route");
  const res = await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}));
  expect(res.status).toBe(404); // still no published content
});

test("Admin can retrieve draft content", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/landing/route");
  await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: CONTENT, ...auth(s, c) }));

  const { GET } = await import("@/app/api/admin/landing/route");
  const res = await GET(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { landingPage: { draftContent: { hero: { title: string } } } };
  expect(json.landingPage.draftContent.hero.title).toBe("Futsal Academy");
});

test("Non-admin access denied (403)", async () => {
  const { s, c } = await login(coachA.email, coachA.password);
  const { PATCH } = await import("@/app/api/admin/landing/route");
  const res = await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: CONTENT, ...auth(s, c) }));
  expect(res.status).toBe(403);
});

test("Cross-academy access denied", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/landing/route");
  const res = await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_B_ID}`, { method: "PATCH", body: CONTENT, ...auth(s, c) }));
  expect(res.status).toBe(403); // adminA is not a member of B
});

test("Publication creates history + audit records", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/landing/route");
  await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: CONTENT, ...auth(s, c) }));

  const { POST: publishPost } = await import("@/app/api/admin/landing/publish/route");
  const res1 = await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { publishNote: "First publish" }, ...auth(s, c) }));
  expect(res1.status).toBe(201);
  const json1 = (await res1.json()) as { versionNumber: number; publicationId: string };
  expect(json1.versionNumber).toBe(1);

  // Update + publish again.
  await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: { ...CONTENT, hero: { ...CONTENT.hero, title: "Updated" } }, ...auth(s, c) }));
  const res2 = await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { publishNote: "Second publish" }, ...auth(s, c) }));
  const json2 = (await res2.json()) as { versionNumber: number };
  expect(json2.versionNumber).toBe(2);

  // Verify publication history.
  const { GET: pubGet } = await import("@/app/api/admin/landing/publications/route");
  const histRes = await pubGet(await makeRequest(`/api/admin/landing/publications?academyId=${ACADEMY_A_ID}`, { cookies: { [sessionCookieName()]: s } }));
  const histJson = (await histRes.json()) as { publications: { versionNumber: number; publishNote: string | null }[] };
  expect(histJson.publications.length).toBe(2);
  expect(histJson.publications[0]!.versionNumber).toBe(2);
  expect(histJson.publications[1]!.versionNumber).toBe(1);

  // Verify audit.
  const audit = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_events WHERE action = 'landing_page.publish' AND academy_id = $1;`, [ACADEMY_A_ID]);
  expect((audit.rows[0] as { c: number }).c).toBe(2);
});

test("Failed publication does not partially update published content", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { PATCH } = await import("@/app/api/admin/landing/route");
  await PATCH(await makeRequest(`/api/admin/landing?academyId=${ACADEMY_A_ID}`, { method: "PATCH", body: CONTENT, ...auth(s, c) }));

  // Publish v1 successfully.
  const { POST: publishPost } = await import("@/app/api/admin/landing/publish/route");
  await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }));

  // Corrupt the draft content directly (invalid shape that fails Zod).
  await db.query(`UPDATE landing_pages SET draft_content = '{"hero": "not-an-object"}'::jsonb WHERE academy_id = $1;`, [ACADEMY_A_ID]);

  // Publish v2 should fail (content shape validation).
  const res = await publishPost(await makeRequest(`/api/admin/landing/publish?academyId=${ACADEMY_A_ID}`, { method: "POST", body: {}, ...auth(s, c) }));
  expect(res.status).toBe(500); // validation failure → AppError

  // Verify the published content is still v1.
  const { GET: publicGet } = await import("@/app/api/public/landing/route");
  const pubRes = await publicGet(await makeRequest(`/api/public/landing?academyId=${ACADEMY_A_ID}`, {}));
  const pubJson = (await pubRes.json()) as { versionNumber: number; content: { hero: { title: string } } };
  expect(pubJson.versionNumber).toBe(1); // still v1
  expect(pubJson.content.hero.title).toBe("Futsal Academy"); // original content
});

// === YouTube URL validation =============================================

test("extractYoutubeVideoId: valid URLs", () => {
  expect(extractYoutubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractYoutubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractYoutubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("extractYoutubeVideoId: invalid URLs return null", () => {
  expect(extractYoutubeVideoId("https://vimeo.com/12345")).toBeNull();
  expect(extractYoutubeVideoId("https://youtube.com/watch?v=short")).toBeNull(); // < 11 chars
  expect(extractYoutubeVideoId("https://youtube.com/watch?v=thisistoolong123")).toBeNull(); // > 11 chars
  expect(extractYoutubeVideoId("not a url")).toBeNull();
  expect(extractYoutubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
});

test("POST video rejects invalid YouTube URL (422)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/videos/route");
  const res = await POST(await makeRequest(`/api/admin/videos?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "Highlight", url: "https://vimeo.com/123" }, ...auth(s, c) }));
  expect(res.status).toBe(422);
});

test("POST video creates with valid URL + extracts video_id (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/videos/route");
  const res = await POST(await makeRequest(`/api/admin/videos?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "Highlight", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, ...auth(s, c) }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string; videoId: string };
  expect(json.videoId).toBe("dQw4w9WgXcQ");
  // Verify DB.
  const row = await db.query<{ video_id: string }>(`SELECT video_id FROM youtube_videos WHERE id = $1;`, [json.id]);
  expect((row.rows[0] as { video_id: string }).video_id).toBe("dQw4w9WgXcQ");
});

test("POST video rejects duplicate (academy + video_id) (409)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/videos/route");
  await POST(await makeRequest(`/api/admin/videos?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "V1", url: "https://youtu.be/dQw4w9WgXcQ" }, ...auth(s, c) }));
  const res = await POST(await makeRequest(`/api/admin/videos?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "V2", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, ...auth(s, c) }));
  expect(res.status).toBe(409);
});

// === Gallery ============================================================

test("POST gallery creates (201)", async () => {
  const { s, c } = await login(adminA.email, adminA.password);
  const { POST } = await import("@/app/api/admin/gallery/route");
  const res = await POST(await makeRequest(`/api/admin/gallery?academyId=${ACADEMY_A_ID}`, { method: "POST", body: { title: "Team photo", displayOrder: 1, isPublished: true }, ...auth(s, c) }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string };
  const row = await db.query<{ title: string; media_key: string | null; is_published: boolean }>(`SELECT title, media_key, is_published FROM gallery_items WHERE id = $1;`, [json.id]);
  const r = row.rows[0] as { title: string; media_key: string | null; is_published: boolean };
  expect(r.title).toBe("Team photo");
  expect(r.media_key).toBeNull(); // no upload in this stage
  expect(r.is_published).toBe(true);
});
