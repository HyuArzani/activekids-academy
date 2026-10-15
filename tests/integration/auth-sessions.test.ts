/**
 * Concurrent-session + password-change session-revocation tests.
 *
 * Tests that:
 *   - Two simultaneous sessions for the same user are BOTH valid.
 *   - Logging out from one session does NOT invalidate the other.
 *   - Password change revokes OTHER sessions (security precaution) but
 *     keeps the CURRENT session valid.
 *   - Password change revocation is scoped to the current user — other
 *     users' sessions are NEVER touched.
 *   - The transactional password-change + revocation rolls back if any
 *     step fails (not directly testable without injecting failures, but
 *     the success path proves the transaction commits correctly).
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
    email: "multi@example.com",
    password: "password123",
    role: "admin",
  });
});

afterEach(async () => {
  await teardownTestDb();
});

/** Log in and extract the session + CSRF tokens from the Set-Cookie header. */
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

/** Check if a session is valid by calling GET /api/auth/session. */
async function sessionIsValid(sessionToken: string): Promise<boolean> {
  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  return res.status === 200;
}

// --- Concurrent sessions --------------------------------------------------

test("two simultaneous sessions for the same user are BOTH valid", async () => {
  const session1 = await loginAndGetCookies();
  const session2 = await loginAndGetCookies();
  // Both sessions should be valid.
  expect(await sessionIsValid(session1.sessionToken)).toBe(true);
  expect(await sessionIsValid(session2.sessionToken)).toBe(true);
  // The session IDs should be different (each login creates a new row).
  expect(session1.sessionToken).not.toBe(session2.sessionToken);
});

test("logging out from session 1 does NOT invalidate session 2", async () => {
  const session1 = await loginAndGetCookies();
  const session2 = await loginAndGetCookies();
  // Both valid initially.
  expect(await sessionIsValid(session1.sessionToken)).toBe(true);
  expect(await sessionIsValid(session2.sessionToken)).toBe(true);

  // Log out from session 1 (with CSRF).
  const { POST: logoutPost } = await import("@/app/api/auth/logout/route");
  const logoutReq = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: session1.sessionToken,
      [csrfCookieName()]: session1.csrfToken,
    },
    headers: { [CSRF_HEADER]: session1.csrfToken },
  });
  const logoutRes = await logoutPost(logoutReq);
  expect(logoutRes.status).toBe(200);

  // Session 1 should be revoked.
  expect(await sessionIsValid(session1.sessionToken)).toBe(false);
  // Session 2 should STILL be valid.
  expect(await sessionIsValid(session2.sessionToken)).toBe(true);
});

test("logging out from session 2 does NOT invalidate session 1", async () => {
  const session1 = await loginAndGetCookies();
  const session2 = await loginAndGetCookies();

  // Log out from session 2 (with CSRF).
  const { POST: logoutPost } = await import("@/app/api/auth/logout/route");
  const logoutReq = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: session2.sessionToken,
      [csrfCookieName()]: session2.csrfToken,
    },
    headers: { [CSRF_HEADER]: session2.csrfToken },
  });
  await logoutPost(logoutReq);

  // Session 2 revoked, session 1 still valid.
  expect(await sessionIsValid(session2.sessionToken)).toBe(false);
  expect(await sessionIsValid(session1.sessionToken)).toBe(true);
});

test("three concurrent sessions are all valid independently", async () => {
  const s1 = await loginAndGetCookies();
  const s2 = await loginAndGetCookies();
  const s3 = await loginAndGetCookies();
  expect(await sessionIsValid(s1.sessionToken)).toBe(true);
  expect(await sessionIsValid(s2.sessionToken)).toBe(true);
  expect(await sessionIsValid(s3.sessionToken)).toBe(true);

  // Log out from s2 — s1 and s3 should still work.
  const { POST: logoutPost } = await import("@/app/api/auth/logout/route");
  const logoutReq = await makeRequest("/api/auth/logout", {
    method: "POST",
    cookies: {
      [sessionCookieName()]: s2.sessionToken,
      [csrfCookieName()]: s2.csrfToken,
    },
    headers: { [CSRF_HEADER]: s2.csrfToken },
  });
  await logoutPost(logoutReq);
  expect(await sessionIsValid(s1.sessionToken)).toBe(true);
  expect(await sessionIsValid(s2.sessionToken)).toBe(false);
  expect(await sessionIsValid(s3.sessionToken)).toBe(true);
});

// --- Password change + session revocation --------------------------------

test("password change revokes OTHER sessions but keeps the current session valid", async () => {
  // Create two sessions.
  const session1 = await loginAndGetCookies(); // will be the "other" session
  const session2 = await loginAndGetCookies(); // will make the change-password request

  // Both valid.
  expect(await sessionIsValid(session1.sessionToken)).toBe(true);
  expect(await sessionIsValid(session2.sessionToken)).toBe(true);

  // Change password from session 2.
  const { POST: changePwPost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: user.password,
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: session2.sessionToken,
      [csrfCookieName()]: session2.csrfToken,
    },
    headers: { [CSRF_HEADER]: session2.csrfToken },
  });
  const changeRes = await changePwPost(changeReq);
  expect(changeRes.status).toBe(200);

  // Session 2 (current) should STILL be valid.
  expect(await sessionIsValid(session2.sessionToken)).toBe(true);
  // Session 1 (other) should be REVOKED.
  expect(await sessionIsValid(session1.sessionToken)).toBe(false);
});

test("password change does NOT revoke other USERS' sessions", async () => {
  // Create a second user.
  const user2 = await createTestUser(db, {
    email: "other@example.com",
    password: "password456",
    role: "admin",
  });

  // Log in as both users.
  const session1User1 = await loginAndGetCookies();
  // Log in as user2.
  const { POST: loginPost } = await import("@/app/api/auth/login/route");
  const loginReq2 = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: user2.email, password: user2.password },
  });
  const loginRes2 = await loginPost(loginReq2);
  expect(loginRes2.status).toBe(200);
  const setCookie2 = loginRes2.headers.get("set-cookie") ?? "";
  const session2Match = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie2);
  const csrf2Match = new RegExp(`${csrfCookieName()}=([^;]+)`).exec(setCookie2);
  const session2Token = session2Match![1];
  const csrf2Token = csrf2Match![1];

  // Both users' sessions valid.
  expect(await sessionIsValid(session1User1.sessionToken)).toBe(true);
  expect(await sessionIsValid(session2Token)).toBe(true);

  // Change password for user1 (from user1's session).
  const { POST: changePwPost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: user.password,
      newPassword: "new-different-password-789",
    },
    cookies: {
      [sessionCookieName()]: session1User1.sessionToken,
      [csrfCookieName()]: session1User1.csrfToken,
    },
    headers: { [CSRF_HEADER]: session1User1.csrfToken },
  });
  const changeRes = await changePwPost(changeReq);
  expect(changeRes.status).toBe(200);

  // user1's current session still valid.
  expect(await sessionIsValid(session1User1.sessionToken)).toBe(true);
  // user2's session is UNAFFECTED (not revoked).
  expect(await sessionIsValid(session2Token)).toBe(true);
});

test("after password change, the old password fails for new logins", async () => {
  const session = await loginAndGetCookies();
  const { POST: changePwPost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: user.password,
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: session.sessionToken,
      [csrfCookieName()]: session.csrfToken,
    },
    headers: { [CSRF_HEADER]: session.csrfToken },
  });
  await changePwPost(changeReq);

  // Old password should fail for a new login.
  const { POST: loginPost } = await import("@/app/api/auth/login/route");
  const loginReq = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: user.password },
  });
  const loginRes = await loginPost(loginReq);
  expect(loginRes.status).toBe(401);
});

test("after password change, the new password works for new logins", async () => {
  const session = await loginAndGetCookies();
  const { POST: changePwPost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: user.password,
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: session.sessionToken,
      [csrfCookieName()]: session.csrfToken,
    },
    headers: { [CSRF_HEADER]: session.csrfToken },
  });
  await changePwPost(changeReq);

  // New password should work for a new login.
  const { POST: loginPost } = await import("@/app/api/auth/login/route");
  const loginReq = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: "new-different-password-456" },
  });
  const loginRes = await loginPost(loginReq);
  expect(loginRes.status).toBe(200);
});

test("the current session remains valid after changing password (no forced logout)", async () => {
  const session = await loginAndGetCookies();
  expect(await sessionIsValid(session.sessionToken)).toBe(true);

  const { POST: changePwPost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: user.password,
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: session.sessionToken,
      [csrfCookieName()]: session.csrfToken,
    },
    headers: { [CSRF_HEADER]: session.csrfToken },
  });
  const changeRes = await changePwPost(changeReq);
  expect(changeRes.status).toBe(200);

  // The current session should STILL be valid immediately after.
  expect(await sessionIsValid(session.sessionToken)).toBe(true);
});

test("password change with wrong current password does NOT revoke any sessions", async () => {
  const session1 = await loginAndGetCookies();
  const session2 = await loginAndGetCookies();

  // Try to change password with WRONG current password.
  const { POST: changePwPost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: "wrong-current-password",
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: session2.sessionToken,
      [csrfCookieName()]: session2.csrfToken,
    },
    headers: { [CSRF_HEADER]: session2.csrfToken },
  });
  const changeRes = await changePwPost(changeReq);
  expect(changeRes.status).toBe(401); // current password incorrect

  // Neither session should be revoked (the transaction should have rolled
  // back, or more precisely, the password verification failed before the
  // transaction started).
  expect(await sessionIsValid(session1.sessionToken)).toBe(true);
  expect(await sessionIsValid(session2.sessionToken)).toBe(true);
});
