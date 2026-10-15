/**
 * Auth integration tests — login + logout + session flows.
 *
 * Tests the ACTUAL route handlers (POST /api/auth/login, POST /api/auth/logout,
 * GET /api/auth/session, POST /api/auth/change-password) by importing the
 * exported route functions and calling them with real NextRequest objects.
 *
 * All tests run against in-memory PgLite (Bun runtime). NOT real PostgreSQL
 * server — see Phase 1 worklog for limitations.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  setupTestDb,
  teardownTestDb,
  createTestUser,
  makeRequest,
  ACADEMY_A_ID,
  type TestUser,
} from "./_auth-helpers";
import type { DbClient } from "@/lib/db";
import { hashSessionToken, sessionCookieName } from "@/lib/auth/session";
import { env } from "@/lib/env";

let db: DbClient;
let adminUser: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  adminUser = await createTestUser(db, {
    email: "admin@example.com",
    password: "password123",
    role: "admin",
  });
});

afterEach(async () => {
  await teardownTestDb();
});

// Helper: call the login route and return the response + parsed JSON.
async function callLogin(email: string, password: string) {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  const res = await POST(req);
  const json = (await res.json()) as {
    principal?: { email: string; mustChangePassword: boolean; memberships: unknown[] };
    error?: { code: string; message: string; detail?: string };
  };
  return { res, json };
}

test("login succeeds with correct credentials and sets session + CSRF cookies", async () => {
  const { res, json } = await callLogin(adminUser.email, adminUser.password);
  expect(res.status).toBe(200);
  expect(json.principal?.email).toBe(adminUser.email);
  expect(json.principal?.mustChangePassword).toBe(false);
  expect(json.principal?.memberships).toHaveLength(1);

  // The session cookie should be set (HttpOnly).
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toContain(`${sessionCookieName()}=`);
  expect(setCookie).toContain("HttpOnly");
  // Next.js serializes SameSite=Lax as "SameSite=lax" (lowercase).
  expect(setCookie.toLowerCase()).toContain("samesite=lax");
  expect(setCookie).toContain("Path=/");

  // The CSRF cookie should also be set (NOT HttpOnly).
  expect(setCookie).toContain(env.CSRF_COOKIE_NAME);
});

test("login fails with wrong password — generic 401 message, no user enumeration", async () => {
  const { res, json } = await callLogin(adminUser.email, "wrong-password-xyz");
  expect(res.status).toBe(401);
  expect(json.error?.message).toBe("Invalid email or password");
  // The error must NOT reveal whether the email exists.
  expect(json.error?.message).not.toContain("not found");
  expect(json.error?.message).not.toContain("does not exist");
});

test("login fails for non-existent email — same generic 401 message", async () => {
  const { res, json } = await callLogin("nobody@example.com", "any-password-12");
  expect(res.status).toBe(401);
  expect(json.error?.message).toBe("Invalid email or password");
});

test("login fails for inactive user — generic 401", async () => {
  const inactiveUser = await createTestUser(db, {
    email: "inactive@example.com",
    password: "password123",
    role: "admin",
    status: "inactive",
  });
  const { res, json } = await callLogin(inactiveUser.email, inactiveUser.password);
  expect(res.status).toBe(401);
  expect(json.error?.message).toBe("Invalid email or password");
});

test("login fails for suspended user — generic 401", async () => {
  const suspendedUser = await createTestUser(db, {
    email: "suspended@example.com",
    password: "password123",
    role: "admin",
    status: "suspended",
  });
  const { res, json } = await callLogin(suspendedUser.email, suspendedUser.password);
  expect(res.status).toBe(401);
  expect(json.error?.message).toBe("Invalid email or password");
});

test("login rejects malformed email with 422", async () => {
  const { res } = await callLogin("not-an-email", "password123");
  expect(res.status).toBe(422);
});

test("login rejects too-short password with 422", async () => {
  const { res } = await callLogin(adminUser.email, "short");
  expect(res.status).toBe(422);
});

test("GET /api/auth/session returns 401 without a session cookie", async () => {
  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session");
  const res = await GET(req);
  expect(res.status).toBe(401);
});

test("GET /api/auth/session returns the principal WITH a valid session cookie", async () => {
  // Login to get the session cookie.
  const { res: loginRes } = await callLogin(adminUser.email, adminUser.password);
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  // Extract the session token from the Set-Cookie header.
  const sessionMatch = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie);
  expect(sessionMatch).toBeTruthy();
  const sessionToken = sessionMatch![1];

  // Call /api/auth/session with the cookie.
  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { principal?: { email: string } };
  expect(json.principal?.email).toBe(adminUser.email);
});

test("GET /api/auth/session returns 401 with an expired session", async () => {
  // Manually create an expired session row.
  const tokenHash = hashSessionToken("expired-test-token");
  const expiresAt = new Date(Date.now() - 1000); // expired 1s ago
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4);`,
    [crypto.randomUUID(), adminUser.id, tokenHash, expiresAt],
  );

  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: "expired-test-token" },
  });
  const res = await GET(req);
  expect(res.status).toBe(401);
});

test("logout revokes the session — subsequent /session returns 401", async () => {
  // Login.
  const { res: loginRes } = await callLogin(adminUser.email, adminUser.password);
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  const sessionMatch = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie);
  const sessionToken = sessionMatch![1];
  const csrfMatch = new RegExp(`${env.CSRF_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  const csrfToken = csrfMatch![1];

  // Logout (with valid CSRF).
  const { POST: logoutPost } = await import("@/app/api/auth/logout/route");
  const logoutReq = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: sessionToken,
      [env.CSRF_COOKIE_NAME]: csrfToken,
    },
    headers: { "X-CSRF-Token": csrfToken },
  });
  const logoutRes = await logoutPost(logoutReq);
  expect(logoutRes.status).toBe(200);

  // The session should now be revoked.
  const sessionsResult = await db.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM sessions WHERE token_hash = $1;`,
    [hashSessionToken(sessionToken)],
  );
  expect(sessionsResult.rows[0]?.revoked_at).toBeTruthy();

  // Subsequent /session with the same (now-revoked) cookie returns 401.
  const { GET } = await import("@/app/api/auth/session/route");
  const sessionReq = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const sessionRes = await GET(sessionReq);
  expect(sessionRes.status).toBe(401);
});

test("logout is idempotent without a session — returns 200, clears cookies", async () => {
  const { POST } = await import("@/app/api/auth/logout/route");
  const req = await makeRequest("/api/auth/logout", { method: "POST" });
  const res = await POST(req);
  expect(res.status).toBe(200);
  // The Set-Cookie header should clear the cookies.
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`${sessionCookieName()}=;`);
});

test("login records a successful attempt in login_attempts table", async () => {
  await callLogin(adminUser.email, adminUser.password);
  const result = await db.query<{ succeeded: boolean }>(
    `SELECT succeeded FROM login_attempts WHERE identifier = $1 ORDER BY attempted_at DESC LIMIT 1;`,
    [adminUser.email],
  );
  expect(result.rows[0]?.succeeded).toBe(true);
});

test("login records a failed attempt in login_attempts table", async () => {
  await callLogin(adminUser.email, "wrong-password");
  const result = await db.query<{ succeeded: boolean }>(
    `SELECT succeeded FROM login_attempts WHERE identifier = $1 ORDER BY attempted_at DESC LIMIT 1;`,
    [adminUser.email],
  );
  expect(result.rows[0]?.succeeded).toBe(false);
});

test("account locks after 5 failed attempts — locked_until is set", async () => {
  // 5 failed attempts.
  for (let i = 0; i < 5; i++) {
    await callLogin(adminUser.email, "wrong-password");
  }
  const result = await db.query<{ failed_login_count: number; locked_until: Date | null }>(
    `SELECT failed_login_count, locked_until FROM users WHERE email = $1;`,
    [adminUser.email],
  );
  expect(result.rows[0]?.failed_login_count).toBe(5);
  expect(result.rows[0]?.locked_until).toBeTruthy();
});

test("locked account returns 429 (rate-limited) on subsequent login", async () => {
  // 5 failed attempts triggers BOTH the per-email rate limiter (count >= 5)
  // AND the account lock (failed_login_count >= 5, locked_until set).
  // On the 6th attempt, the rate limiter fires first (it runs before the
  // user lookup). Both responses are valid 429 rate-limit responses.
  for (let i = 0; i < 5; i++) {
    await callLogin(adminUser.email, "wrong-password");
  }
  const { res, json } = await callLogin(adminUser.email, adminUser.password);
  expect(res.status).toBe(429);
  // The message is either "Too many login attempts for this account"
  // (per-email rate limiter) or "Account locked" (per-user account lock).
  // Both are valid; the rate limiter takes precedence when count >= 5.
  const msg = json.error?.message ?? "";
  expect(
    msg.includes("Too many login attempts") || msg.includes("Account locked"),
    `expected rate-limit message, got: ${msg}`,
  ).toBe(true);
  expect(res.headers.get("Retry-After")).toBeTruthy();
});

test("login resets failed_login_count on successful login", async () => {
  // 3 failed attempts (below the 5-attempt lock threshold).
  for (let i = 0; i < 3; i++) {
    await callLogin(adminUser.email, "wrong-password");
  }
  // Successful login.
  await callLogin(adminUser.email, adminUser.password);
  const result = await db.query<{ failed_login_count: number }>(
    `SELECT failed_login_count FROM users WHERE email = $1;`,
    [adminUser.email],
  );
  expect(result.rows[0]?.failed_login_count).toBe(0);
});

test("login updates last_login_at on success", async () => {
  const before = await db.query<{ last_login_at: Date | null }>(
    `SELECT last_login_at FROM users WHERE email = $1;`,
    [adminUser.email],
  );
  expect(before.rows[0]?.last_login_at).toBeNull();

  await callLogin(adminUser.email, adminUser.password);

  const after = await db.query<{ last_login_at: Date | null }>(
    `SELECT last_login_at FROM users WHERE email = $1;`,
    [adminUser.email],
  );
  expect(after.rows[0]?.last_login_at).toBeTruthy();
});

// Silence unused-import warnings.
void ACADEMY_A_ID;
void env;
