/**
 * Auth integration tests — forced password change.
 *
 * Tests that:
 *   - A provisioned account with must_change_password=true can log in
 *     (the login flow succeeds).
 *   - The principal returned by /session reflects must_change_password=true.
 *   - The change-password endpoint clears must_change_password.
 *   - After changing the password, /session returns mustChangePassword=false.
 *   - The change-password endpoint requires the correct current password.
 *   - The new password must differ from the current password.
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
import { csrfCookieName } from "@/lib/auth/csrf";

let db: DbClient;
let provisionedUser: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  provisionedUser = await createTestUser(db, {
    email: "newadmin@example.com",
    password: "initial-password-123",
    role: "admin",
    mustChangePassword: true,
  });
});

afterEach(async () => {
  await teardownTestDb();
});

async function loginAndGetCookies(): Promise<{ sessionToken: string; csrfToken: string }> {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: provisionedUser.email, password: provisionedUser.password },
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

test("provisioned user with must_change_password=true can log in", async () => {
  const { POST } = await import("@/app/api/auth/login/route");
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: {
      email: provisionedUser.email,
      password: provisionedUser.password,
    },
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { principal?: { mustChangePassword: boolean } };
  expect(json.principal?.mustChangePassword).toBe(true);
});

test("/session reflects mustChangePassword=true for provisioned user", async () => {
  const { sessionToken } = await loginAndGetCookies();
  const { GET } = await import("@/app/api/auth/session/route");
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const res = await GET(req);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { principal?: { mustChangePassword: boolean } };
  expect(json.principal?.mustChangePassword).toBe(true);
});

test("change-password clears must_change_password", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/change-password/route");
  const req = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: provisionedUser.password,
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { "X-CSRF-Token": csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { principal?: { mustChangePassword: boolean } };
  expect(json.principal?.mustChangePassword).toBe(false);
});

test("change-password requires correct current password", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/change-password/route");
  const req = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: "wrong-current-password",
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { "X-CSRF-Token": csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(401);
});

test("change-password rejects new password equal to current", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/change-password/route");
  const req = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: provisionedUser.password,
      newPassword: provisionedUser.password, // same as current
    },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { "X-CSRF-Token": csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(422);
});

test("change-password rejects too-short new password", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST } = await import("@/app/api/auth/change-password/route");
  const req = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: provisionedUser.password,
      newPassword: "short",
    },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { "X-CSRF-Token": csrfToken },
  });
  const res = await POST(req);
  expect(res.status).toBe(422);
});

test("change-password requires authentication", async () => {
  const { POST } = await import("@/app/api/auth/change-password/route");
  const req = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: "anything",
      newPassword: "new-password-123",
    },
  });
  const res = await POST(req);
  expect(res.status).toBe(401);
});

test("after change-password, the new password works for login", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  // Change password.
  const { POST: changePost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: provisionedUser.password,
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { "X-CSRF-Token": csrfToken },
  });
  await changePost(changeReq);

  // The CURRENT session should still work (we keep it valid — the user
  // just changed their password legitimately). OTHER sessions for this
  // user are revoked (tested in auth-sessions.test.ts).
  const { GET } = await import("@/app/api/auth/session/route");
  const sessionReq = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: sessionToken },
  });
  const sessionRes = await GET(sessionReq);
  expect(sessionRes.status).toBe(200);

  // The new password should work for login.
  const { POST: loginPost } = await import("@/app/api/auth/login/route");
  const loginReq = await makeRequest("/api/auth/login", {
    method: "POST",
    body: {
      email: provisionedUser.email,
      password: "new-different-password-456",
    },
  });
  const loginRes = await loginPost(loginReq);
  expect(loginRes.status).toBe(200);
});

test("the old password fails after change-password", async () => {
  const { sessionToken, csrfToken } = await loginAndGetCookies();
  const { POST: changePost } = await import("@/app/api/auth/change-password/route");
  const changeReq = await makeRequest("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: provisionedUser.password,
      newPassword: "new-different-password-456",
    },
    cookies: {
      [sessionCookieName()]: sessionToken,
      [csrfCookieName()]: csrfToken,
    },
    headers: { "X-CSRF-Token": csrfToken },
  });
  await changePost(changeReq);

  // The old password should now fail.
  const { POST: loginPost } = await import("@/app/api/auth/login/route");
  const loginReq = await makeRequest("/api/auth/login", {
    method: "POST",
    body: {
      email: provisionedUser.email,
      password: provisionedUser.password,
    },
  });
  const loginRes = await loginPost(loginReq);
  expect(loginRes.status).toBe(401);
});
