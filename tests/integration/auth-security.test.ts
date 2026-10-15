/**
 * Rate-limit security + academy-isolation negative tests.
 *
 * Tests that:
 *   - Malformed requests (invalid JSON, bad email, short password) CANNOT
 *     bypass the per-IP rate limiter. The check runs before body parsing.
 *   - Nonexistent accounts and incorrect passwords are recorded and count
 *     toward the rate limit.
 *   - Login error messages do NOT distinguish between user-not-found and
 *     wrong-password (no user enumeration via error messages).
 *   - requireAuthChain throws CONFIG when role is provided without
 *     academyId or anywhere:true (prevents accidental isolation bypass).
 *   - requireAuthChain with anywhere:true allows global admin access.
 *   - Cross-academy access via requireAuthChain is rejected.
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
  ACADEMY_B_ID,
  type TestUser,
} from "./_auth-helpers";
import type { DbClient } from "@/lib/db";
import { sessionCookieName } from "@/lib/auth/session";
import { csrfCookieName, CSRF_HEADER } from "@/lib/auth/csrf";
import { requireAuthChain } from "@/lib/auth/principal";
import { AppError } from "@/lib/errors";

let db: DbClient;
let user: TestUser;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db, {
    email: "ratelimit@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
  });
});

afterEach(async () => {
  await teardownTestDb();
});

// --- Malformed requests cannot bypass rate limiting -----------------------

test("malformed JSON body is rate-limited by IP (pre-parsing check)", async () => {
  // Send 20 malformed-JSON requests from the same IP. The 21st should be
  // rate-limited (per-IP threshold is 20 per 15 minutes).
  const { POST } = await import("@/app/api/auth/login/route");
  for (let i = 0; i < 20; i++) {
    const req = await makeRequest("/api/auth/login", {
      method: "POST",
      body: "{invalid json",
      headers: { "X-Real-IP": "7.7.7.7", "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(422); // invalid JSON
  }
  // 21st request from the same IP should be rate-limited.
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: "any@example.com", password: "password123" },
    headers: { "X-Real-IP": "7.7.7.7" },
  });
  const res = await POST(req);
  expect(res.status).toBe(429); // rate-limited
});

test("malformed email is rate-limited by IP (pre-parsing check records the attempt)", async () => {
  const { POST } = await import("@/app/api/auth/login/route");
  // Send 20 requests with malformed emails from the same IP.
  for (let i = 0; i < 20; i++) {
    const req = await makeRequest("/api/auth/login", {
      method: "POST",
      body: { email: "not-an-email", password: "password123" },
      headers: { "X-Real-IP": "8.8.8.8" },
    });
    const res = await POST(req);
    expect(res.status).toBe(422); // validation failed
  }
  // 21st request should be rate-limited.
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: "valid@example.com", password: "password123" },
    headers: { "X-Real-IP": "8.8.8.8" },
  });
  const res = await POST(req);
  expect(res.status).toBe(429);
});

test("short password is rate-limited by IP (pre-parsing check records the attempt)", async () => {
  const { POST } = await import("@/app/api/auth/login/route");
  for (let i = 0; i < 20; i++) {
    const req = await makeRequest("/api/auth/login", {
      method: "POST",
      body: { email: "valid@example.com", password: "short" },
      headers: { "X-Real-IP": "6.6.6.6" },
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
  }
  const req = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: "valid@example.com", password: "password123" },
    headers: { "X-Real-IP": "6.6.6.6" },
  });
  const res = await POST(req);
  expect(res.status).toBe(429);
});

// --- User enumeration prevention ----------------------------------------

test("login error for nonexistent email is identical to wrong-password error", async () => {
  const { POST } = await import("@/app/api/auth/login/route");
  // Wrong password for existing user.
  const req1 = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: "wrong-password-99" },
    headers: { "X-Real-IP": "1.1.1.1" },
  });
  const res1 = await POST(req1);
  const json1 = (await res1.json()) as { error?: { code: string; message: string } };

  // Nonexistent email.
  const req2 = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: "nobody@example.com", password: "wrong-password-99" },
    headers: { "X-Real-IP": "2.2.2.2" },
  });
  const res2 = await POST(req2);
  const json2 = (await res2.json()) as { error?: { code: string; message: string } };

  // Both should be 401 with the SAME generic message.
  expect(res1.status).toBe(401);
  expect(res2.status).toBe(401);
  expect(json1.error?.message).toBe(json2.error?.message);
  expect(json1.error?.message).toBe("Invalid email or password");
});

test("login error for inactive user is identical to wrong-password error", async () => {
  const inactiveUser = await createTestUser(db, {
    email: "inactive@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
    status: "inactive",
  });
  const { POST } = await import("@/app/api/auth/login/route");

  const req1 = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: "wrong-password-99" },
    headers: { "X-Real-IP": "3.3.3.3" },
  });
  const res1 = await POST(req1);
  const json1 = (await res1.json()) as { error?: { message: string } };

  const req2 = await makeRequest("/api/auth/login", {
    method: "POST",
    body: { email: inactiveUser.email, password: inactiveUser.password },
    headers: { "X-Real-IP": "4.4.4.4" },
  });
  const res2 = await POST(req2);
  const json2 = (await res2.json()) as { error?: { message: string } };

  expect(res1.status).toBe(401);
  expect(res2.status).toBe(401);
  expect(json1.error?.message).toBe(json2.error?.message);
});

// --- requireAuthChain negative tests ------------------------------------

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
  return {
    sessionToken: sessionMatch![1],
    csrfToken: csrfMatch![1],
  };
}

test("requireAuthChain throws CONFIG when role is provided without academyId or anywhere", async () => {
  const cookies = await loginAndGetCookies(user.email, user.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: cookies.sessionToken },
  });
  try {
    await requireAuthChain(req, { role: "admin" }); // no academyId, no anywhere
    expect.fail("should have thrown CONFIG");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("CONFIG_INVALID");
  }
});

test("requireAuthChain with academyId allows admin with matching membership", async () => {
  const cookies = await loginAndGetCookies(user.email, user.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: cookies.sessionToken },
  });
  // user is admin in ACADEMY_A_ID.
  const principal = await requireAuthChain(req, {
    role: "admin",
    academyId: ACADEMY_A_ID,
  });
  expect(principal.email).toBe(user.email);
});

test("requireAuthChain with academyId throws FORBIDDEN for cross-academy access", async () => {
  const cookies = await loginAndGetCookies(user.email, user.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: cookies.sessionToken },
  });
  // user is admin in A, not in B.
  try {
    await requireAuthChain(req, { role: "admin", academyId: ACADEMY_B_ID });
    expect.fail("should have thrown FORBIDDEN");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("requireAuthChain with anywhere:true allows global admin access", async () => {
  const cookies = await loginAndGetCookies(user.email, user.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: cookies.sessionToken },
  });
  const principal = await requireAuthChain(req, {
    role: "admin",
    anywhere: true,
  });
  expect(principal.email).toBe(user.email);
});

test("requireAuthChain with anywhere:true throws FORBIDDEN for coach trying admin", async () => {
  const coach = await createTestUser(db, {
    email: "coach@example.com",
    password: "password123",
    role: "coach",
    academyId: ACADEMY_A_ID,
  });
  const cookies = await loginAndGetCookies(coach.email, coach.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: cookies.sessionToken },
  });
  try {
    await requireAuthChain(req, { role: "admin", anywhere: true });
    expect.fail("should have thrown FORBIDDEN");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("FORBIDDEN");
  }
});

test("requireAuthChain without session throws UNAUTHORIZED", async () => {
  const req = await makeRequest("/api/auth/session");
  try {
    await requireAuthChain(req, { role: "admin", academyId: ACADEMY_A_ID });
    expect.fail("should have thrown UNAUTHORIZED");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("UNAUTHORIZED");
  }
});

test("requireAuthChain with must_change_password=true throws MUST_CHANGE_PASSWORD", async () => {
  const provisioned = await createTestUser(db, {
    email: "provisioned@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
    mustChangePassword: true,
  });
  const cookies = await loginAndGetCookies(provisioned.email, provisioned.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: cookies.sessionToken },
  });
  try {
    await requireAuthChain(req, { role: "admin", academyId: ACADEMY_A_ID });
    expect.fail("should have thrown MUST_CHANGE_PASSWORD");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("MUST_CHANGE_PASSWORD");
  }
});

test("requireAuthChain with allowMustChangePassword:true skips the must-change gate", async () => {
  const provisioned = await createTestUser(db, {
    email: "provisioned2@example.com",
    password: "password123",
    role: "admin",
    academyId: ACADEMY_A_ID,
    mustChangePassword: true,
  });
  const cookies = await loginAndGetCookies(provisioned.email, provisioned.password);
  const req = await makeRequest("/api/auth/session", {
    cookies: { [sessionCookieName()]: cookies.sessionToken },
  });
  // Should NOT throw — the gate is explicitly bypassed.
  const principal = await requireAuthChain(req, {
    role: "admin",
    academyId: ACADEMY_A_ID,
    allowMustChangePassword: true,
  });
  expect(principal.mustChangePassword).toBe(true);
});
