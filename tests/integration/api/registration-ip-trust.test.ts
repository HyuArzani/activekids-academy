/**
 * Phase B3.4.1 — Registration IP trust boundary integration tests.
 *
 * Verifies the actual registration route's IP resolution + fallback
 * policy through the full request → getClientIp → rate-limit pipeline.
 * Tests use the real route handler with the deployment-aware
 * getClientIp() helper (NETLIFY env toggles the trust boundary).
 *
 * Trust model verified (Phase B3.4.1 — see src/lib/auth/client-ip.ts):
 *
 *   DEFAULT (off-Netlify / Caddy self-hosted / dev gateway):
 *     1. x-nf-client-connection-ip → trusted (won't be present).
 *     2. X-Real-IP → trusted (Caddy overwrites it via header_up).
 *     3. X-Forwarded-For → NEVER trusted.
 *     4. Missing trusted headers → null → GLOBAL fallback bucket
 *        (reg:__no_trusted_ip__) with a small independent cap.
 *
 *   NETLIFY (process.env.NETLIFY === "true"):
 *     1. x-nf-client-connection-ip → trusted (platform-set).
 *     2. X-Real-IP → NOT trusted (Netlify provides no overwrite
 *        guarantee; a client may be able to set it). Ignored entirely.
 *     3. X-Forwarded-For → NEVER trusted.
 *     4. Missing x-nf-client-connection-ip → null → GLOBAL fallback.
 *
 * Fallback policy (Phase B3.4.1 — see registration.ts + rateLimit.ts):
 *   When getClientIp() returns null, the request is rate-limited under
 *   a single, independent global bucket (reg:__no_trusted_ip__) with
 *   a small cap (10 per 15 min — smaller than the per-IP cap of 5).
 *   This bounds abuse without rejecting legitimate users and without
 *   letting an attacker lock out real per-IP users by flooding a
 *   shared per-IP "unknown" bucket. See Phase B3.4.1 report for the
 *   trade-off analysis.
 *
 * These are INTEGRATION tests (route handler + DB). They DO NOT
 * verify the platform guarantee that Netlify overwrites
 * x-nf-client-connection-ip — that requires deployment verification.
 * For unit-level getClientIp tests, see tests/unit/client-ip.test.ts.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  setupTestDb,
  teardownTestDb,
  makeRequest,
  ACADEMY_A_ID,
} from "../_auth-helpers";
import { REGISTRATION_NO_TRUSTED_IP_BUCKET } from "@/lib/auth/rateLimit";
import type { DbClient } from "@/lib/db";

let db: DbClient;

beforeEach(async () => {
  db = await setupTestDb();
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'A', 'a', 'Asia/Jakarta', true);`,
    [ACADEMY_A_ID],
  );
});

afterEach(async () => {
  await teardownTestDb();
});

const REG_BODY = {
  academyId: ACADEMY_A_ID,
  parentFullName: "IP Test Parent",
  parentPhone: "+62 123",
  parentEmail: undefined,
  childFullName: "IP Test Child",
  childDateOfBirth: "2015-01-01",
};

function makeRegBody(i: number) {
  return {
    ...REG_BODY,
    parentEmail: `ip-test-${i}-${randomUUID().slice(0, 8)}@example.com`,
    childFullName: `IP Child ${i}`,
  };
}

/** Count login_attempts rows for a given identifier (rate-limit bucket). */
async function countBucket(identifier: string): Promise<number> {
  const r = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier = $1;`,
    [identifier],
  );
  return (r.rows[0] as { c: number } | undefined)?.c ?? 0;
}

/** Count all login_attempts rows (any bucket). */
async function countAllBuckets(): Promise<number> {
  const r = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM login_attempts;`,
  );
  return (r.rows[0] as { c: number } | undefined)?.c ?? 0;
}

// ===========================================================================
// DEFAULT deployment (off-Netlify / Caddy self-hosted / dev gateway).
// X-Real-IP is trusted here because Caddy overwrites it via header_up.
// ===========================================================================

describe("Default deployment (off-Netlify / Caddy)", () => {
  // === 1. x-nf-client-connection-ip is used for rate-limit bucket ===

  test("Registration with x-nf-client-connection-ip uses that IP for rate-limit bucket", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(1),
        headers: { "x-nf-client-connection-ip": "198.51.100.10" },
      }),
    );
    expect(res.status).toBe(201);
    expect(await countBucket("reg:198.51.100.10")).toBe(1);
  });

  // === 2. x-nf-client-connection-ip takes precedence over X-Real-IP ===

  test("Registration with both x-nf and X-Real-IP uses x-nf IP (precedence)", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(2),
        headers: {
          "x-nf-client-connection-ip": "198.51.100.20",
          "x-real-ip": "203.0.113.99", // must be ignored (x-nf wins)
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(await countBucket("reg:198.51.100.20")).toBe(1);
    expect(await countBucket("reg:203.0.113.99")).toBe(0);
  });

  // === 3. Spoofed X-Forwarded-For cannot override trusted IP ===

  test("Spoofed X-Forwarded-For cannot override x-nf-client-connection-ip", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(3),
        headers: {
          "x-nf-client-connection-ip": "198.51.100.30",
          "x-forwarded-for": "10.0.0.1", // spoofed — must be ignored
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(await countBucket("reg:198.51.100.30")).toBe(1);
    expect(await countBucket("reg:10.0.0.1")).toBe(0);
  });

  test("Spoofed X-Forwarded-For cannot override X-Real-IP (off-Netlify)", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(4),
        headers: {
          "x-real-ip": "203.0.113.40",
          "x-forwarded-for": "10.0.0.2", // spoofed — must be ignored
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(await countBucket("reg:203.0.113.40")).toBe(1);
    expect(await countBucket("reg:10.0.0.2")).toBe(0);
  });

  // === 4. X-Forwarded-For alone → no per-IP record; lands in global bucket ===

  test("Registration with only X-Forwarded-For → no per-IP bucket, lands in global fallback", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(5),
        headers: { "x-forwarded-for": "203.0.113.50" },
      }),
    );
    expect(res.status).toBe(201);
    // XFF is not trusted → no per-IP record for the spoofed value.
    expect(await countBucket("reg:203.0.113.50")).toBe(0);
    // The request lands in the global fallback bucket (documented policy).
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(1);
  });

  // === 5. Missing trusted IP metadata → global fallback bucket ===

  test("Registration with no IP headers → global fallback bucket gets the record", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(6),
      }),
    );
    expect(res.status).toBe(201);
    // Documented fallback: the global bucket absorbs the request.
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(1);
    // No per-IP bucket was created.
    expect(await countAllBuckets()).toBe(1);
  });

  // === 6. Malformed IP in trusted header → falls through to fallback ===

  test("Registration with malformed x-nf-client-connection-ip → global fallback bucket", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(7),
        headers: { "x-nf-client-connection-ip": "not-an-ip" },
      }),
    );
    expect(res.status).toBe(201);
    // Malformed IP → null → global fallback bucket.
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(1);
  });

  test("Registration with malformed X-Real-IP → global fallback bucket", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(8),
        headers: { "x-real-ip": "garbage" },
      }),
    );
    expect(res.status).toBe(201);
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(1);
  });

  // === 7. Repeated requests from same trusted IP share rate-limit bucket ===

  test("Repeated requests from same x-nf IP share rate-limit bucket", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const ip = "198.51.100.70";
    for (let i = 0; i < 3; i++) {
      await POST(
        await makeRequest("/api/public/register", {
          method: "POST",
          body: makeRegBody(100 + i),
          headers: { "x-nf-client-connection-ip": ip },
        }),
      );
    }
    expect(await countBucket(`reg:${ip}`)).toBe(3);
  });

  // === 8. Different IPs create separate rate-limit buckets ===

  test("Different trusted IPs create separate rate-limit buckets", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(200),
        headers: { "x-nf-client-connection-ip": "198.51.100.80" },
      }),
    );
    await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(201),
        headers: { "x-nf-client-connection-ip": "198.51.100.81" },
      }),
    );
    expect(await countBucket("reg:198.51.100.80")).toBe(1);
    expect(await countBucket("reg:198.51.100.81")).toBe(1);
  });

  // === 9. Changing X-Forwarded-For does not create new buckets ===

  test("Changing X-Forwarded-For does not create per-IP buckets (all land in global fallback)", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    // Submit with different XFF values — all should be ignored (no
    // trusted IP) and land in the SAME global fallback bucket.
    await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(300),
        headers: { "x-forwarded-for": "1.1.1.1" },
      }),
    );
    await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(301),
        headers: { "x-forwarded-for": "2.2.2.2" },
      }),
    );
    // No per-IP buckets created from spoofed XFF values.
    expect(await countBucket("reg:1.1.1.1")).toBe(0);
    expect(await countBucket("reg:2.2.2.2")).toBe(0);
    // Both requests landed in the same global fallback bucket.
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(2);
  });

  // === 10. Existing registration behavior remains intact (happy path) ===

  test("Registration with trusted IP: 201, application created, rate-limit recorded", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const body = makeRegBody(999);
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body,
        headers: { "x-nf-client-connection-ip": "198.51.100.99" },
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { applicationId: string; replayed: boolean };
    expect(json.replayed).toBe(false);
    expect(json.applicationId).toMatch(/^[0-9a-f-]{36}$/i);
    // Application persisted.
    const apps = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM registration_applications WHERE parent_email = $1;`,
      [body.parentEmail],
    );
    expect((apps.rows[0] as { c: number }).c).toBe(1);
    // Rate-limit recorded under the trusted IP.
    expect(await countBucket("reg:198.51.100.99")).toBe(1);
  });

  // === 11. Global fallback cap is enforced (cannot evade by changing headers) ===

  test("Global fallback: cannot evade cap by changing arbitrary headers", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    // Send REG_NO_TRUSTED_IP_MAX_ATTEMPTS requests with DIFFERENT
    // arbitrary header values each time. Because no trusted IP is
    // present, ALL land in the same global fallback bucket. The cap
    // must eventually trigger — the attacker cannot evade by varying
    // headers.
    // NOTE: REG_NO_TRUSTED_IP_MAX_ATTEMPTS = 10 (see rateLimit.ts).
    // After 10 successful attempts, the 11th is rejected (429).
    const arbitraryHeaders = [
      { "x-forwarded-for": "1.1.1.1" },
      { "x-forwarded-for": "2.2.2.2" },
      { "x-forwarded-for": "3.3.3.3", "user-agent": "bot-1" },
      { "x-custom-header": "a" },
      { "x-custom-header": "b" },
      { "x-forwarded-for": "4.4.4.4", "x-real-ip": "spoofed-1" }, // x-real-ip ignored on Netlify; on default it'd be trusted. Here we want to bypass — see below.
      {},
      { "x-forwarded-for": "5.5.5.5" },
      { "user-agent": "different" },
      { "x-arbitrary": "value-1" },
      { "x-arbitrary": "value-2" }, // 11th — should be rejected
    ];
    // We need to ensure NO trusted IP is present for any of these.
    // Note: the entry with x-real-ip would actually be trusted on the
    // default deployment. We replace it with an XFF-only entry below
    // to keep the test focused on the global fallback path.
    const safeHeaders = arbitraryHeaders.filter(
      (h) => !("x-real-ip" in h) && !("x-nf-client-connection-ip" in h),
    );
    // Pad to 11 entries with XFF-only variations.
    while (safeHeaders.length < 11) {
      safeHeaders.push({ "x-forwarded-for": `9.9.9.${safeHeaders.length}` });
    }
    let lastStatus = 0;
    for (let i = 0; i < safeHeaders.length; i++) {
      const res = await POST(
        await makeRequest("/api/public/register", {
          method: "POST",
          body: makeRegBody(500 + i),
          headers: safeHeaders[i],
        }),
      );
      lastStatus = res.status;
    }
    // The 11th request must be rejected with 429 (rate-limited).
    // The first 10 succeed (201); the 11th exceeds the cap.
    expect(lastStatus).toBe(429);
    // All 11 attempts landed in the global fallback bucket (none
    // evaded into a per-IP bucket).
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(11);
    // No per-IP buckets were created by the varied XFF values.
    const perIp = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier <> $1;`,
      [`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`],
    );
    expect((perIp.rows[0] as { c: number }).c).toBe(0);
  });
});

// ===========================================================================
// NETLIFY deployment (process.env.NETLIFY === "true").
// X-Real-IP is NOT trusted here — Netlify provides no overwrite guarantee.
// ===========================================================================

describe("Netlify deployment (NETLIFY=true)", () => {
  let originalNetlify: string | undefined;

  beforeEach(() => {
    originalNetlify = process.env.NETLIFY;
    process.env.NETLIFY = "true";
  });

  afterEach(() => {
    if (originalNetlify === undefined) {
      delete process.env.NETLIFY;
    } else {
      process.env.NETLIFY = originalNetlify;
    }
  });

  // === N1. Trusted Netlify IP takes precedence ===

  test("On Netlify: x-nf-client-connection-ip takes precedence over X-Real-IP", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(1001),
        headers: {
          "x-nf-client-connection-ip": "198.51.100.110",
          "x-real-ip": "203.0.113.200", // ignored on Netlify
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(await countBucket("reg:198.51.100.110")).toBe(1);
    // X-Real-IP is NOT trusted on Netlify → no per-IP record for it.
    expect(await countBucket("reg:203.0.113.200")).toBe(0);
  });

  // === N2. Untrusted X-Real-IP cannot bypass the limiter on Netlify ===

  test("On Netlify: X-Real-IP alone does NOT create a per-IP rate-limit bucket", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(1002),
        headers: { "x-real-ip": "203.0.113.210" }, // attacker-controlled on Netlify
      }),
    );
    expect(res.status).toBe(201);
    // X-Real-IP is NOT trusted on Netlify → no per-IP record for it.
    expect(await countBucket("reg:203.0.113.210")).toBe(0);
    // The request lands in the global fallback bucket (no trusted IP).
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(1);
  });

  test("On Netlify: rotating X-Real-IP values cannot evade the global fallback cap", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    // An attacker rotates X-Real-IP on every request, hoping each
    // gets its own per-IP bucket. On Netlify, X-Real-IP is ignored,
    // so ALL requests land in the global fallback bucket. The cap
    // must trigger after REG_NO_TRUSTED_IP_MAX_ATTEMPTS.
    // NOTE: REG_NO_TRUSTED_IP_MAX_ATTEMPTS = 10. The 11th is rejected.
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await POST(
        await makeRequest("/api/public/register", {
          method: "POST",
          body: makeRegBody(1100 + i),
          headers: { "x-real-ip": `203.0.113.${i + 1}` },
        }),
      );
      lastStatus = res.status;
    }
    // 11th request rejected with 429.
    expect(lastStatus).toBe(429);
    // All 11 attempts landed in the same global fallback bucket.
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(11);
    // No per-IP buckets were created from the rotated X-Real-IP values.
    const perIp = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM login_attempts WHERE identifier <> $1;`,
      [`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`],
    );
    expect((perIp.rows[0] as { c: number }).c).toBe(0);
  });

  // === N3. X-Forwarded-For cannot choose the bucket on Netlify ===

  test("On Netlify: X-Forwarded-For cannot choose the rate-limit bucket", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(1003),
        headers: {
          "x-nf-client-connection-ip": "198.51.100.120",
          "x-forwarded-for": "10.0.0.99", // spoofed — must be ignored
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(await countBucket("reg:198.51.100.120")).toBe(1);
    expect(await countBucket("reg:10.0.0.99")).toBe(0);
  });

  // === N4. Missing trusted IP metadata on Netlify → global fallback ===

  test("On Netlify: missing x-nf-client-connection-ip → global fallback bucket (not rejected)", async () => {
    const { POST } = await import("@/app/api/public/register/route");
    // No headers at all — simulates a (rare) Netlify request where
    // the platform failed to set x-nf-client-connection-ip.
    const res = await POST(
      await makeRequest("/api/public/register", {
        method: "POST",
        body: makeRegBody(1004),
      }),
    );
    expect(res.status).toBe(201);
    // Documented fallback: global bucket absorbs the request (the
    // request is NOT rejected — see Phase B3.4.1 trade-off analysis).
    expect(await countBucket(`reg:${REGISTRATION_NO_TRUSTED_IP_BUCKET}`)).toBe(1);
  });
});
