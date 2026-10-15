/**
 * Auth integration tests — CSRF protection.
 *
 * Tests that:
 *   - The CSRF cookie is set on login (NOT HttpOnly, so client JS can read).
 *   - The CSRF cookie value is the HMAC of the session token.
 *   - Logout WITHOUT a CSRF token is rejected with 403 (CSRF_INVALID).
 *   - Logout WITH a mismatched CSRF token is rejected with 403.
 *   - Logout WITH a valid CSRF token (cookie + header match) succeeds.
 *   - The CSRF token is rotation-safe (changes on new login).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  setupTestDb,
  teardownTestDb,
  createTestUser,
  makeRequest,
  type TestUser,
} from "./_auth-helpers";
import type { DbClient } from "@/lib/db";
import { sessionCookieName } from "@/lib/auth/session";
import { csrfCookieName, deriveCsrfToken, CSRF_HEADER } from "@/lib/auth/csrf";

let db: DbClient;
let user: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db, {
    email: "csrf-test@example.com",
    password: "password123",
    role: "admin",
  });
});

afterEach(async () => {
  await teardownTestDb();
});

async function loginAndGetCookies(): Promise<{ sessionToken: string; csrfToken: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: user.password },
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const sessionMatch = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie);
  const csrfMatch = new RegExp(`${csrfCookieName()}=([^;]+)`).exec(setCookie);
  expect(sessionMatch).toBeTruthy();
  expect(csrfMatch).toBeTruthy();
  return {
    sessionToken: sessionMatch![1],
    csrfToken: csrfMatch![1],
  };
}

test("login sets both session (HttpOnly) and CSRF (NOT HttpOnly) cookies", async () => {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: user.password },
  });
  const res = await POST(req);
  const setCookie = res.headers.get("set-cookie") ?? "";
  // Multiple Set-Cookie directives are comma-joined in the header. Each
  // should have its own attributes.
  expect(setCookie).toContain(`${sessionCookieName()}=`);
  expect(setCookie).toContain(`${csrfCookieName()}=`);
  // The session cookie must be HttpOnly; the CSRF cookie must NOT be.
  // We check by splitting on the cookie boundaries.
  const cookies = setCookie.split(/,\s*(?=[a-zA-Z_-]+=)/); // split on cookie starts
  const sessionCookie = cookies.find((c) => c.startsWith(`${sessionCookieName()}=`));
  const csrfCookie = cookies.find((c) => c.startsWith(`${csrfCookieName()}=`));
  expect(sessionCookie).toBeDefined();
  expect(csrfCookie).toBeDefined();
  expect(sessionCookie!).toContain("HttpOnly");
  expect(csrfCookie!).not.toContain("HttpOnly");
});

test("CSRF cookie value = HMAC(session token, CSRF_SECRET)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const expected = deriveCsrfToken(sessionToken);
  expect(csrfToken).toBe(expected);
});

test("logout without CSRF token is rejected with 403", async () => {
  const { sessionToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/logout/route");
  const req = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: { [sessionCookieName()]: sessionToken },
    // No X-CSRF-Token header, no CSRF cookie.
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error?: { code: string } };
  expect(json.error?.code).toBe("CSRF_INVALID");
});

test("logout with mismatched CSRF header is rejected with 403", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/logout/route");
  const req = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: "wrong-csrf-token-value" },
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
});

test("logout with valid CSRF token (cookie + header match) succeeds", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/logout/route");
  const req = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
});

test("CSRF token is rotation-safe — different per login session", async () => {
  const { csrfToken: csrf1 } = await loginAndGetCookies();
  const { csrfToken: csrf2 } = await loginAndGetCookies();
  expect(csrf1).not.toBe(csrf2);
});

test("CSRF verification fails when only the header is present (no cookie)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/logout/route");
  const req = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: { [sessionCookieName()]: sessionToken },
    // No CSRF cookie, but header is set.
    headers: { [CSRF_HEADER]: csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
});

test("CSRF verification fails when only the cookie is present (no header)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/logout/route");
  const req = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    // No X-CSRF-Token header.
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
});
