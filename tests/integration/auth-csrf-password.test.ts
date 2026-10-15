/**
 * CSRF enforcement tests for the change-password endpoint.
 *
 * Tests that:
 *   - Change-password WITHOUT a CSRF token is rejected with 403.
 *   - Change-password with a MISMATCHED CSRF header is rejected with 403.
 *   - Change-password with CSRF cookie but NO header is rejected with 403.
 *   - Change-password with CSRF header but NO cookie is rejected with 403.
 *   - Change-password with a VALID CSRF token (cookie + header match)
 *     succeeds (200).
 *   - The session-revocation behavior is preserved after a successful
 *     CSRF-protected password change.
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
  type TestUser,
} from "./_auth-helpers";
import type { DbClient } from "@/lib/db";
import { sessionCookieName } from "@/lib/auth/session";
import { csrfCookieName, CSRF_HEADER } from "@/lib/auth/csrf";

let db: DbClient;
let user: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db, {
    email: "csrf-pw@example.com",
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

async function callChangePassword(
  sessionToken: string,
  csrfCookieValue: string | undefined,
  csrfHeaderValue: string | undefined,
  currentPassword = user.password,
  newPassword = "new-different-password-456",
) {
  const { POST } = await import("@/app/api/auth/change-password/route");
  const cookies: Record<string, string> = { [sessionCookieName()]: sessionToken };
  if (csrfCookieValue !== undefined) {
    cookies[csrfCookieName()] = csrfCookieValue;
  }
  const headers: Record<string, string> = {};
  if (csrfHeaderValue !== undefined) {
    headers[CSRF_HEADER] = csrfHeaderValue;
  }
  const req = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword },
    cookies,
    headers,
  });
  return POST(req);
}

test("change-password WITHOUT CSRF token is rejected with 403", async () => {
  const { sessionToken } = await loginAndGetCookies();
  // No CSRF cookie, no X-CSRF-Token header.
  const res = await callChangePassword(sessionToken, undefined, undefined);
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error?: { code: string } };
  expect(json.error?.code).toBe("CSRF_INVALID");
});

test("change-password with MISMATCHED CSRF header is rejected with 403", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  // CSRF cookie is correct, but header is a different value.
  const res = await callChangePassword(
    sessionToken,
    csrfToken,
    "wrong-csrf-header-value",
  );
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error?: { code: string } };
  expect(json.error?.code).toBe("CSRF_INVALID");
});

test("change-password with CSRF cookie but NO header is rejected with 403", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  // CSRF cookie present, but no X-CSRF-Token header.
  const res = await callChangePassword(sessionToken, csrfToken, undefined);
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error?: { code: string } };
  expect(json.error?.code).toBe("CSRF_INVALID");
});

test("change-password with CSRF header but NO cookie is rejected with 403", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  // X-CSRF-Token header present, but no CSRF cookie.
  const res = await callChangePassword(sessionToken, undefined, csrfToken);
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error?: { code: string } };
  expect(json.error?.code).toBe("CSRF_INVALID");
});

test("change-password with VALID CSRF token succeeds (200)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const res = await callChangePassword(
    sessionToken,
    csrfToken,
    csrfToken,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { principal?: { mustChangePassword: boolean } };
  expect(json.principal?.mustChangePassword).toBe(false);
});

test("change-password with valid CSRF still revokes other sessions", async () => {
  // Two sessions.
  const session1 = await loginAndGetCookies();
  const session2 = await loginAndGetCookies();

  // Change password from session2 with valid CSRF.
  const res = await callChangePassword(
    session2.sessionToken,
    session2.csrfToken,
    session2.csrfToken,
  );
  expect(res.status).toBe(200);

  // Session 2 (current) still valid; session 1 (other) revoked.
  const { GET } = await import("@/app/api/auth/session/route");
  const req1 = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: session1.sessionToken },
  });
  const res1 = await GET(req1);
  expect(res1.status).toBe(401); // revoked

  const req2 = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: session2.sessionToken },
  });
  const res2 = await GET(req2);
  expect(res2.status).toBe(200); // still valid
});

test("change-password with wrong current password + valid CSRF returns 401 (not 403)", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  // Valid CSRF, but wrong current password.
  const res = await callChangePassword(
    sessionToken,
    csrfToken,
    csrfToken,
    "wrong-current-password",
    "new-different-password-456",
  );
  expect(res.status).toBe(401); // current password incorrect (NOT 403 CSRF)
});

test("change-password without session returns 401 (before CSRF check)", async () => {
  // No session cookie at all — should return 401, not 403.
  const { POST } = await import("@/app/api/auth/change-password/route");
  const req = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword: "anything", newPassword: "new-password-123" },
  });
  const res = await POST(req);
  expect(res.status).toBe(401);
});
