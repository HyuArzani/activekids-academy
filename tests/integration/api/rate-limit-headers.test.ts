/**
 * Unit + integration tests for the public registration rate-limiting
 * IP extraction, trust policy, concurrency safety, and retry behavior
 * (Stages 7B.4–7B.6).
 *
 * Tests verify:
 *   - Only X-Real-IP (set by Caddy gateway) is trusted (off-Netlify path).
 *   - X-Forwarded-For is NOT trusted.
 *   - When no trustworthy IP is available, the request lands in a small,
 *     independent GLOBAL fallback bucket (reg:__no_trusted_ip__) —
 *     rate limiting is NOT skipped (Phase B3.4.1 hardening).
 *   - Non-IP values in X-Real-IP are rejected by isIP().
 *   - The atomic check-and-record prevents concurrency races.
 *   - Registration attempts use 'reg:' prefix (don't affect login limits).
 *   - Exceeding the limit (5 per 15 min) blocks subsequent requests.
 *   - Idempotent retries don't double-count.
 *   - Login rate limiting is NOT affected by registration attempts.
 *
 * NOTE: The local getClientIp reimplementation below is a legacy stub
 * from Stage 7B.4–7B.6 that only checks X-Real-IP (off-Netlify path).
 * The production helper (src/lib/auth/client-ip.ts) is deployment-aware
 * and is tested directly in tests/unit/client-ip.test.ts and via the
 * full route in tests/integration/api/registration-ip-trust.test.ts.
 */

import { test, expect } from "bun:test";
import { makeRequest, ACADEMY_A_ID, setupTestDb, teardownTestDb } from "../_auth-helpers";
import type { DbClient } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

// Re-implement getClientIp for unit testing (mirrors the route's logic).
function getClientIp(headers: Record<string, string | null>): string | null {
  const real = headers["x-real-ip"];
  if (real && real.trim() !== "") {
    const trimmed = real.trim();
    if (isIP(trimmed) > 0) return trimmed;
  }
  return null;
}

async function setupFixture(): Promise<DbClient> {
  const db = await setupTestDb();
  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`, [ACADEMY_A_ID]);
  return db;
}

// === 1. Missing IP headers ===

test("No IP headers → null (rate limiting skipped)", () => {
  expect(getClientIp({})).toBeNull();
});

// === 2. Malformed IP values ===

test("Malformed X-Real-IP (non-IP string) → null", () => {
  expect(getClientIp({ "x-real-ip": "not-an-ip" })).toBeNull();
});

test("Malformed X-Real-IP (out-of-range octet) → null", () => {
  expect(getClientIp({ "x-real-ip": "999.0.0.1" })).toBeNull();
});

// === 3. Spoofed X-Real-IP ===

test("Spoofed X-Real-IP with valid IP format → used (gateway overwrites in prod)", () => {
  expect(getClientIp({ "x-real-ip": "203.0.113.1" })).toBe("203.0.113.1");
});

test("Spoofed X-Real-IP with invalid format → null", () => {
  expect(getClientIp({ "x-real-ip": "attacker-string" })).toBeNull();
});

// === 4. Spoofed X-Forwarded-For ===

test("Spoofed X-Forwarded-For is NOT trusted (no X-Real-IP)", () => {
  expect(getClientIp({ "x-forwarded-for": "10.0.0.1" })).toBeNull();
});

test("Spoofed X-Forwarded-For with X-Real-IP present → X-Real-IP wins", () => {
  expect(getClientIp({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1" })).toBe("198.51.100.1");
});

// === 5. Multiple comma-separated forwarded addresses ===

test("Multi-value X-Forwarded-For → NOT trusted (null)", () => {
  expect(getClientIp({ "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3" })).toBeNull();
});

// === 6. Empty or whitespace-only header values ===

test("Empty X-Real-IP → null", () => {
  expect(getClientIp({ "x-real-ip": "" })).toBeNull();
});

test("Whitespace-only X-Real-IP → null", () => {
  expect(getClientIp({ "x-real-ip": "   " })).toBeNull();
});

// === 7. Changing headers to bypass rate limits ===

test("Changing X-Forwarded-For does not create new rate-limit buckets", () => {
  expect(getClientIp({ "x-forwarded-for": "1.1.1.1" })).toBeNull();
  expect(getClientIp({ "x-forwarded-for": "2.2.2.2" })).toBeNull();
});

// === 8. No verified IP source ===

test("No verified IP source → null (rate limiting skipped)", () => {
  expect(getClientIp({})).toBeNull();
  expect(getClientIp({ "x-forwarded-for": "anything" })).toBeNull();
});

// === 9. Legitimate requests through trusted-proxy ===

test("Legitimate X-Real-IP (IPv4) → trusted", () => {
  expect(getClientIp({ "x-real-ip": "203.0.113.42" })).toBe("203.0.113.42");
});

test("Legitimate X-Real-IP (IPv6) → trusted", () => {
  expect(getClientIp({ "x-real-ip": "::1" })).toBe("::1");
  expect(getClientIp({ "x-real-ip": "2001:db8::1" })).toBe("2001:db8::1");
});

test("Edge: 0.0.0.0 is valid IPv4 → trusted", () => {
  expect(getClientIp({ "x-real-ip": "0.0.0.0" })).toBe("0.0.0.0");
});

test("Edge: 255.255.255.255 is valid IPv4 → trusted", () => {
  expect(getClientIp({ "x-real-ip": "255.255.255.255" })).toBe("255.255.255.255");
});

// === 10. Registration idempotency + rate-limit behavior ===

test("Registration with X-Real-IP records a 'reg:'-prefixed login_attempts row", async () => {
  const db = await setupFixture();
  try {
    const { POST } = await import("@/app/api/public/register/route");
    await POST(await makeRequest("/api/public/register", {
      method: "POST",
      body: { academyId: ACADEMY_A_ID, parentFullName: "Test", parentPhone: "+62 1", parentEmail: "rl1@example.com", childFullName: "Child 1", childDateOfBirth: "2015-01-01" },
      headers: { "x-real-ip": "203.0.113.50" },
    }));
    const attempts = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = 'reg:203.0.113.50' AND identifier_type = 'ip';`);
    expect((attempts.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await teardownTestDb();
  }
});

test("Registration WITHOUT a trusted IP lands in the global fallback bucket (Phase B3.4.1)", async () => {
  const db = await setupFixture();
  try {
    const { POST } = await import("@/app/api/public/register/route");
    await POST(await makeRequest("/api/public/register", {
      method: "POST",
      body: { academyId: ACADEMY_A_ID, parentFullName: "Test", parentPhone: "+62 1", parentEmail: "rl2@example.com", childFullName: "Child 2", childDateOfBirth: "2015-01-01" },
    }));
    // No trusted IP → the request lands in the global fallback bucket
    // (reg:__no_trusted_ip__). Rate limiting is NOT skipped — see
    // Phase B3.4.1. The bucket is independent of any per-IP bucket.
    const fallbackAttempts = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = 'reg:__no_trusted_ip__';`,
    );
    expect((fallbackAttempts.rows[0] as { c: number }).c).toBe(1);
    // No per-IP bucket was created (no trusted IP was available).
    const perIpAttempts = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier <> 'reg:__no_trusted_ip__';`,
    );
    expect((perIpAttempts.rows[0] as { c: number }).c).toBe(0);
  } finally {
    await teardownTestDb();
  }
});

test("Registration attempts do NOT count toward login IP rate limits", async () => {
  const db = await setupFixture();
  try {
    const { POST } = await import("@/app/api/public/register/route");
    for (let i = 0; i < 5; i++) {
      await POST(await makeRequest("/api/public/register", {
        method: "POST",
        body: { academyId: ACADEMY_A_ID, parentFullName: `P${i}`, parentPhone: "+62 1", parentEmail: `rl${i}@ex.com`, childFullName: `C${i}`, childDateOfBirth: "2015-01-01" },
        headers: { "x-real-ip": "203.0.113.60" },
      }));
    }
    // 'reg:' rows exist, but raw-IP login rows do NOT.
    const regAttempts = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = 'reg:203.0.113.60';`);
    expect((regAttempts.rows[0] as { c: number }).c).toBe(5);
    const loginAttempts = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = '203.0.113.60';`);
    expect((loginAttempts.rows[0] as { c: number }).c).toBe(0);
  } finally {
    await teardownTestDb();
  }
});

test("Requests around the 5-attempt threshold: 5 succeed, 6th blocked", async () => {
  const db = await setupFixture();
  try {
    const { POST } = await import("@/app/api/public/register/route");
    for (let i = 0; i < 5; i++) {
      const res = await POST(await makeRequest("/api/public/register", {
        method: "POST",
        body: { academyId: ACADEMY_A_ID, parentFullName: `P${i}`, parentPhone: "+62 1", parentEmail: `th${i}@ex.com`, childFullName: `C${i}`, childDateOfBirth: "2015-01-01" },
        headers: { "x-real-ip": "203.0.113.70" },
      }));
      expect([200, 201].includes(res.status)).toBe(true);
    }
    // 6th → rate-limited (429).
    const res = await POST(await makeRequest("/api/public/register", {
      method: "POST",
      body: { academyId: ACADEMY_A_ID, parentFullName: "P6", parentPhone: "+62 1", parentEmail: "th6@ex.com", childFullName: "C6", childDateOfBirth: "2015-01-01" },
      headers: { "x-real-ip": "203.0.113.70" },
    }));
    expect(res.status).toBe(429);
  } finally {
    await teardownTestDb();
  }
});

test("Idempotent retry does NOT double-count rate-limit attempts", async () => {
  const db = await setupFixture();
  try {
    const { POST } = await import("@/app/api/public/register/route");
    const key = `idemp-${randomUUID()}`;
    const body = { academyId: ACADEMY_A_ID, parentFullName: "Idemp", parentPhone: "+62 1", parentEmail: "idemp@ex.com", childFullName: "Idemp Child", childDateOfBirth: "2015-01-01", idempotencyKey: key };
    const res1 = await POST(await makeRequest("/api/public/register", { method: "POST", body, headers: { "x-real-ip": "203.0.113.80" } }));
    expect(res1.status).toBe(201);
    const res2 = await POST(await makeRequest("/api/public/register", { method: "POST", body, headers: { "x-real-ip": "203.0.113.80" } }));
    expect(res2.status).toBe(200); // replayed
    const attempts = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = 'reg:203.0.113.80';`);
    expect((attempts.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await teardownTestDb();
  }
});

test("Concurrent requests from same IP: at most 5 succeed", async () => {
  const db = await setupFixture();
  try {
    const { POST } = await import("@/app/api/public/register/route");
    const requests = Array.from({ length: 6 }, async (_, i) =>
      POST(await makeRequest("/api/public/register", {
        method: "POST",
        body: { academyId: ACADEMY_A_ID, parentFullName: `Conc${i}`, parentPhone: "+62 1", parentEmail: `conc${i}@ex.com`, childFullName: `ConcChild${i}`, childDateOfBirth: "2015-01-01" },
        headers: { "x-real-ip": "203.0.113.90" },
      })),
    );
    const results = await Promise.allSettled(requests);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
    const succeeded = statuses.filter((s) => [200, 201].includes(s)).length;
    // At most 5 succeed (the limit). Under PgLite (single-process),
    // true multi-connection concurrency is NOT exercised — the SERIALIZABLE
    // tx ensures atomicity by inspection, but real PostgreSQL concurrency
    // remains unverified.
    expect(succeeded).toBeLessThanOrEqual(5);
  } finally {
    await teardownTestDb();
  }
});

// === Login rate limiting regression ===

test("Login rate limiting is NOT affected by registration attempts (regression)", async () => {
  const db = await setupFixture();
  try {
    const { createTestUser } = await import("../_auth-helpers");
    const admin = await createTestUser(db, { email: "admin-rl@example.com", password: "password123", role: "admin", academyId: ACADEMY_A_ID });

    // Submit 5 registration attempts from IP 203.0.113.100.
    const { POST: regPost } = await import("@/app/api/public/register/route");
    for (let i = 0; i < 5; i++) {
      await regPost(await makeRequest("/api/public/register", {
        method: "POST",
        body: { academyId: ACADEMY_A_ID, parentFullName: `P${i}`, parentPhone: "+62 1", parentEmail: `login-rl${i}@ex.com`, childFullName: `C${i}`, childDateOfBirth: "2015-01-01" },
        headers: { "x-real-ip": "203.0.113.100" },
      }));
    }

    // Login from the SAME IP should still work (login uses raw IP,
    // not 'reg:IP' — separate buckets).
    const { POST: loginPost } = await import("@/app/api/auth/login/route");
    const loginRes = await loginPost(await makeRequest("/api/auth/login", {
      method: "POST",
      body: { email: admin.email, password: admin.password },
      headers: { "x-real-ip": "203.0.113.100" },
    }));
    expect(loginRes.status).toBe(200); // login succeeds — not rate-limited

    // Verify the raw-IP login_attempts has 1 row (the login), NOT 6 (5 reg + 1 login).
    const loginAttempts = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = '203.0.113.100' AND identifier_type = 'ip';`);
    expect((loginAttempts.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await teardownTestDb();
  }
});

// === Idempotency key-reuse with different body: no rate-limit consumption ===

test("Key-reuse-different-body CONFLICTs BEFORE rate-limit check (no login_attempts row)", async () => {
  const db = await setupFixture();
  try {
    const { POST } = await import("@/app/api/public/register/route");
    const key = `reuse-${randomUUID()}`;
    // First request — succeeds.
    const res1 = await POST(await makeRequest("/api/public/register", {
      method: "POST",
      body: { academyId: ACADEMY_A_ID, parentFullName: "Original", parentPhone: "+62 1", parentEmail: "reuse1@ex.com", childFullName: "Original Child", childDateOfBirth: "2015-01-01", idempotencyKey: key },
      headers: { "x-real-ip": "203.0.113.110" },
    }));
    expect(res1.status).toBe(201);

    // Second request — same key, DIFFERENT body (different email).
    const res2 = await POST(await makeRequest("/api/public/register", {
      method: "POST",
      body: { academyId: ACADEMY_A_ID, parentFullName: "Different", parentPhone: "+62 1", parentEmail: "reuse2@ex.com", childFullName: "Different Child", childDateOfBirth: "2015-01-01", idempotencyKey: key },
      headers: { "x-real-ip": "203.0.113.110" },
    }));
    expect(res2.status).toBe(409); // CONFLICT — idempotency_key_reuse

    // Verify only 1 login_attempts row (from the first request only).
    // The second request's CONFLICT happened BEFORE the rate-limit check.
    const attempts = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = 'reg:203.0.113.110';`);
    expect((attempts.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await teardownTestDb();
  }
});
