/**
 * Auth integration tests — role + academy boundaries + rate limiting.
 *
 * Tests that:
 *   - requireRole throws FORBIDDEN when the principal lacks the role.
 *   - requireAcademyMembership throws FORBIDDEN for cross-academy access.
 *   - A principal with role=admin in academy A cannot act as admin in
 *     academy B (cross-academy isolation).
 *   - A parent cannot act as a coach or admin.
 *   - Rate limiting kicks in after too many attempts per email.
 *   - Rate limiting kicks in after too many attempts per IP.
 *   - Direct API access without a session is rejected (401).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  setupTestDb,
  teardownTestDb,
  createTestUser,
  makeRequest,
  ACADEMY_A_ID,
  ACADEMY_B_ID,
  type TestUser,
} from "./_auth-helpers";
import type { DbClient } from "@/lib/db";
import {
  requirePrincipal,
  requireRole,
  requireRoleAnywhere,
  requireAcademyMembership,
  requireNotMustChangePassword,
  type Principal,
} from "@/lib/auth/principal";
import { AppError } from "@/lib/errors";
import { sessionCookieName } from "@/lib/auth/session";
import { csrfCookieName, CSRF_HEADER } from "@/lib/auth/csrf";

let db: DbClient;
let adminA: TestUser;
let coachA: TestUser;
let parentA: TestUser;
let adminB: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  adminA = await createTestUser(db, {
    email: "admin-a@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
  });
  coachA = await createTestUser(db, {
    email: "coach-a@example.com",
    password: "password123",
    role: "coach",
    academyId: ACADEMY_A_ID,
  });
  parentA = await createTestUser(db, {
    email: "parent-a@example.com",
    password: "password123",
    role: "parent",
    academyId: ACADEMY_A_ID,
  });
  adminB = await createTestUser(db, {
    email: "admin-b@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_B_ID,
  });
});

afterEach(async () => {
  await teardownTestDb();
});

// Helper: log in and return cookies.
async function loginAndGetCookies(email: string, password: string): Promise<{ sessionToken: string; csrfToken: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const sessionMatch = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie);
  const csrfMatch = new RegExp(`${csrfCookieName()}=([^;]+)`).exec(setCookie);
  expect(sessionMatch).toBeTruthy();
  expect(csrfMatch).toBeTruthy();
  return { sessionToken: sessionMatch![1], csrfToken: csrfMatch![1] };
}

// Helper: build a Principal from a test user (for unit-testing the helpers
// directly without going through the API).
async function buildPrincipal(user: TestUser): Promise<Principal> {
  const { GET } = await import("@/app/api/auth/session/route");
  const { sessionToken } = await loginAndGetCookies(user.email, user.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { principal: { userId: string; memberships: { academyId: string; role: string }[] } };
  // Reconstruct a Principal from the sanitized response. We need the full
  // Principal shape; we'll re-fetch via extractPrincipal.
  const { extractPrincipal } = await import("@/lib/auth/principal");
  const extracted = await extractPrincipal(req, db);
  expect(extracted).not.toBeNull();
  return extracted!.principal;
}

// --- requirePrincipal -----------------------------------------------------

test("requirePrincipal throws UNAUTHORIZED for null", () => {
  expect(() => requirePrincipal(null)).toThrow();
  try {
    requirePrincipal(null);
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("UNAUTHORIZED");
  }
});

// --- requireRole ----------------------------------------------------------

test("requireRole allows when principal has the role in the academy", async () => {
  const p = await buildPrincipal(adminA);
  expect(() => requireRole(p, "admin", ACADEMY_A_ID)).not.toThrow();
});

test("requireRole throws FORBIDDEN when principal lacks the role", async () => {
  const p = await buildPrincipal(coachA);
  try {
    requireRole(p, "admin", ACADEMY_A_ID);
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("requireRole throws FORBIDDEN when role is in a different academy (cross-academy)", async () => {
  const p = await buildPrincipal(adminA); // admin in ACADEMY_A
  try {
    requireRole(p, "admin", ACADEMY_B_ID); // trying to act as admin in B
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("requireRole anywhere allows role in ANY academy (explicit global ops)", async () => {
  const p = await buildPrincipal(adminA);
  expect(() => requireRoleAnywhere(p, "admin")).not.toThrow();
});

test("requireRole anywhere throws FORBIDDEN when principal lacks the role", async () => {
  const p = await buildPrincipal(coachA);
  try {
    requireRoleAnywhere(p, "admin");
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("parent role cannot act as coach", async () => {
  const p = await buildPrincipal(parentA);
  try {
    requireRole(p, "coach", ACADEMY_A_ID);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("coach role cannot act as admin", async () => {
  const p = await buildPrincipal(coachA);
  try {
    requireRole(p, "admin", ACADEMY_A_ID);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

// --- requireAcademyMembership ---------------------------------------------

test("requireAcademyMembership allows when principal has membership in academy", async () => {
  const p = await buildPrincipal(adminA);
  expect(() => requireAcademyMembership(p, ACADEMY_A_ID)).not.toThrow();
});

test("requireAcademyMembership throws FORBIDDEN for cross-academy access", async () => {
  const p = await buildPrincipal(adminA); // membership only in A
  try {
    requireAcademyMembership(p, ACADEMY_B_ID); // accessing B's data
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("admin in academy B cannot access academy A's data (symmetric cross-academy block)", async () => {
  const p = await buildPrincipal(adminB); // membership only in B
  try {
    requireAcademyMembership(p, ACADEMY_A_ID); // accessing A's data
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

// --- requireNotMustChangePassword -----------------------------------------

test("requireNotMustChangePassword passes when must_change_password=false", async () => {
  const p = await buildPrincipal(adminA);
  expect(p.mustChangePassword).toBe(false);
  expect(() => requireNotMustChangePassword(p)).not.toThrow();
});

test("requireNotMustChangePassword throws MUST_CHANGE_PASSWORD when true", async () => {
  const provisioned = await createTestUser(db, {
    email: "provisioned@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
    mustChangePassword: true,
  });
  const p = await buildPrincipal(provisioned);
  expect(p.mustChangePassword).toBe(true);
  try {
    requireNotMustChangePassword(p);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("MUST_CHANGE_PASSWORD");
  }
});

// --- Rate limiting (DB-backed) --------------------------------------------

test("per-email rate limit: 6th attempt within 15 minutes is rejected with 429", async () => {
  // The threshold is 5 per email per 15 minutes. The 6th should be 429.
  for (let i = 0; i < 5; i++) {
    const { res } = await (async () => {
      const { POST } = await import("@/app/api/auth/login/route");
      const req = await makeRequest("/api/auth/login", {
        method: "POST",
        body: { email: adminA.email, password: "wrong-password-8" },
        headers: { "X-Real-IP": "1.2.3.10" },
      });
      return { res: await POST(req) };
    })();
    // First 5 attempts are 401 (wrong password).
    expect(res.status).toBe(401);
  }
  // The 6th should be 429 (per-email rate limit exceeded).
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: adminA.email, password: "wrong-password-8" },
    headers: { "X-Real-IP": "1.2.3.10" },
  });
  const res = await POST(req);
  expect(res.status).toBe(429);
});

test("per-IP rate limit: 21st attempt within 15 minutes is rejected with 429", async () => {
  // The threshold is 20 per IP per 15 minutes. We'll try 20 different emails
  // from the same IP, then the 21st should be 429.
  for (let i = 0; i < 20; i++) {
    await (async () => {
      const { POST } = await import("@/app/api/auth/login/route");
      const req = await makeRequest("/api/auth/login", {
        method: "POST",
        body: { email: `user${i}@example.com`, password: "wrong-password-8" },
        headers: { "X-Real-IP": "9.9.9.9" },
      });
      const res = await POST(req);
      // All 20 are 401 (email not found, wrong password).
      expect(res.status).toBe(401);
    })();
  }
  // The 21st attempt from the same IP should be 429.
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: "user20@example.com", password: "wrong-password-8" },
    headers: { "X-Real-IP": "9.9.9.9" },
  });
  const res = await POST(req);
  expect(res.status).toBe(429);
});

// --- Direct API access without authentication ----------------------------

test("GET /api/auth/session without a cookie returns 401 (not 500)", async () => {
  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session");
  const res = await GET(req);
  expect(res.status).toBe(401);
});

test("GET /api/auth/csrf without a session returns 401", async () => {
  const { GET } = await import("@/app/api/auth/csrf/route");
  const req = await makeRequest("/api/auth/csrf");
  const res = await GET(req);
  expect(res.status).toBe(401);
});

test("GET /api/auth/session with a forged token hash (not in DB) returns 401", async () => {
  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: "totally-fake-token-not-in-db" },
  });
  const res = await GET(req);
  expect(res.status).toBe(401);
});

test("session cookie containing the right hash format but for a revoked session returns 401", async () => {
  // Login, then logout, then try to use the old session cookie.
  const { sessionToken, csrfToken } = await loginAndGetCookies(adminA.email, adminA.password);
  const { POST: logoutPost } = await import("@/app/api/auth/logout/route");
  const logoutReq = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  await logoutPost(logoutReq);

  // Now try to use the old (revoked) session.
  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  expect(res.status).toBe(401);
});
