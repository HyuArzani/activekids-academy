/**
 * Tests for the shared client-IP extraction helper (Phase A5).
 *
 * Verifies:
 * - Valid IPv4 and IPv6 addresses are accepted from trusted headers.
 * - Missing trusted headers return null.
 * - Invalid IP values return null.
 * - Spoofed X-Forwarded-For cannot override trusted headers.
 * - Comma-separated forwarding chains are rejected.
 * - Correct precedence: x-nf-client-connection-ip > X-Real-IP.
 * - X-Forwarded-For is NEVER trusted.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getClientIp, __currentDeployment } from "@/lib/auth/client-ip";

/** Build a minimal NextRequest-like object with headers. */
function makeReq(headers: Record<string, string>): { headers: { get: (name: string) => string | null } } {
  // Normalize header keys to lowercase for case-insensitive lookup.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    headers: {
      get: (name: string) => lower[name.toLowerCase()] ?? null,
    },
  };
}

// === Valid IPv4 from X-Real-IP (Caddy) ===========================

test("getClientIp: valid IPv4 from X-Real-IP returns the IP", () => {
  const req = makeReq({ "x-real-ip": "203.0.113.42" });
  expect(getClientIp(req as never)).toBe("203.0.113.42");
});

// === Valid IPv6 from X-Real-IP ===================================

test("getClientIp: valid IPv6 from X-Real-IP returns the IP", () => {
  const req = makeReq({ "x-real-ip": "2001:db8::1" });
  expect(getClientIp(req as never)).toBe("2001:db8::1");
});

// === Valid IPv4 from x-nf-client-connection-ip (Netlify) =========

test("getClientIp: valid IPv4 from x-nf-client-connection-ip returns the IP", () => {
  const req = makeReq({ "x-nf-client-connection-ip": "198.51.100.7" });
  expect(getClientIp(req as never)).toBe("198.51.100.7");
});

// === Valid IPv6 from x-nf-client-connection-ip ===================

test("getClientIp: valid IPv6 from x-nf-client-connection-ip returns the IP", () => {
  const req = makeReq({ "x-nf-client-connection-ip": "2001:db8::abcd" });
  expect(getClientIp(req as never)).toBe("2001:db8::abcd");
});

// === Precedence: x-nf-client-connection-ip > X-Real-IP ==========

test("getClientIp: x-nf-client-connection-ip takes precedence over X-Real-IP", () => {
  const req = makeReq({
    "x-nf-client-connection-ip": "198.51.100.1",
    "x-real-ip": "203.0.113.2",
  });
  expect(getClientIp(req as never)).toBe("198.51.100.1");
});

// === Missing trusted headers → null ==============================

test("getClientIp: no trusted headers returns null", () => {
  const req = makeReq({});
  expect(getClientIp(req as never)).toBe(null);
});

test("getClientIp: only X-Forwarded-For present returns null (not trusted)", () => {
  const req = makeReq({ "x-forwarded-for": "203.0.113.99" });
  expect(getClientIp(req as never)).toBe(null);
});

// === Invalid IP values → null ====================================

test("getClientIp: non-IP string in X-Real-IP returns null", () => {
  const req = makeReq({ "x-real-ip": "not-an-ip" });
  expect(getClientIp(req as never)).toBe(null);
});

test("getClientIp: empty string in X-Real-IP returns null", () => {
  const req = makeReq({ "x-real-ip": "" });
  expect(getClientIp(req as never)).toBe(null);
});

test("getClientIp: whitespace-only X-Real-IP returns null", () => {
  const req = makeReq({ "x-real-ip": "   " });
  expect(getClientIp(req as never)).toBe(null);
});

// === Spoofed X-Forwarded-For cannot override trusted headers =====

test("getClientIp: spoofed X-Forwarded-For cannot override X-Real-IP", () => {
  const req = makeReq({
    "x-real-ip": "203.0.113.42",
    "x-forwarded-for": "10.0.0.1",
  });
  // Must return the trusted X-Real-IP, NOT the spoofed X-Forwarded-For.
  expect(getClientIp(req as never)).toBe("203.0.113.42");
});

test("getClientIp: spoofed X-Forwarded-For cannot override x-nf-client-connection-ip", () => {
  const req = makeReq({
    "x-nf-client-connection-ip": "198.51.100.5",
    "x-forwarded-for": "10.0.0.1",
  });
  expect(getClientIp(req as never)).toBe("198.51.100.5");
});

// === Comma-separated chains are rejected =========================

test("getClientIp: comma-separated chain in X-Real-IP returns null", () => {
  const req = makeReq({ "x-real-ip": "203.0.113.1, 10.0.0.1" });
  // isIP("203.0.113.1, 10.0.0.1") returns 0 (not a valid IP).
  expect(getClientIp(req as never)).toBe(null);
});

test("getClientIp: comma-separated chain in x-nf-client-connection-ip returns null", () => {
  const req = makeReq({ "x-nf-client-connection-ip": "198.51.100.1, 10.0.0.1" });
  expect(getClientIp(req as never)).toBe(null);
});

// === X-Forwarded-For is NEVER trusted ============================

test("getClientIp: X-Forwarded-For alone is not trusted (returns null)", () => {
  const req = makeReq({ "x-forwarded-for": "203.0.113.50" });
  expect(getClientIp(req as never)).toBe(null);
});

test("getClientIp: X-Forwarded-For with valid IP but no trusted header returns null", () => {
  const req = makeReq({ "x-forwarded-for": "203.0.113.50, 10.0.0.1" });
  expect(getClientIp(req as never)).toBe(null);
});

// === Trusted header with invalid value falls through to next header ==

test("getClientIp: invalid X-Real-IP falls through to x-nf-client-connection-ip", () => {
  const req = makeReq({
    "x-real-ip": "garbage",
    "x-nf-client-connection-ip": "198.51.100.3",
  });
  // X-Real-IP is invalid → fall through to x-nf-client-connection-ip.
  // But x-nf-client-connection-ip is checked FIRST (higher priority),
  // so if it's present and valid, it's returned regardless of X-Real-IP.
  expect(getClientIp(req as never)).toBe("198.51.100.3");
});

test("getClientIp: invalid x-nf-client-connection-ip falls through to X-Real-IP", () => {
  const req = makeReq({
    "x-nf-client-connection-ip": "garbage",
    "x-real-ip": "203.0.113.77",
  });
  // x-nf-client-connection-ip is invalid → fall through to X-Real-IP.
  expect(getClientIp(req as never)).toBe("203.0.113.77");
});

test("getClientIp: both headers invalid returns null", () => {
  const req = makeReq({
    "x-nf-client-connection-ip": "garbage1",
    "x-real-ip": "garbage2",
  });
  expect(getClientIp(req as never)).toBe(null);
});

// ===========================================================================
// Phase B3.4.1 — Netlify deployment (process.env.NETLIFY === "true").
// X-Real-IP is NOT trusted on Netlify — Netlify provides no overwrite
// guarantee for it. Only x-nf-client-connection-ip is trusted.
// ===========================================================================

describe("getClientIp on Netlify (NETLIFY=true)", () => {
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

  test("deployment detection reports 'netlify'", () => {
    expect(__currentDeployment()).toBe("netlify");
  });

  test("x-nf-client-connection-ip is trusted on Netlify", () => {
    const req = makeReq({ "x-nf-client-connection-ip": "198.51.100.7" });
    expect(getClientIp(req as never)).toBe("198.51.100.7");
  });

  // KEY: X-Real-IP is NOT trusted on Netlify. This is the central
  // hardening in Phase B3.4.1. An attacker setting X-Real-IP on
  // Netlify cannot get it into the rate-limit bucket.
  test("X-Real-IP alone is NOT trusted on Netlify (returns null)", () => {
    const req = makeReq({ "x-real-ip": "203.0.113.42" });
    expect(getClientIp(req as never)).toBe(null);
  });

  test("X-Real-IP cannot override x-nf-client-connection-ip on Netlify", () => {
    const req = makeReq({
      "x-nf-client-connection-ip": "198.51.100.1",
      "x-real-ip": "203.0.113.2",
    });
    expect(getClientIp(req as never)).toBe("198.51.100.1");
  });

  test("malformed x-nf-client-connection-ip on Netlify → null (X-Real-IP not consulted)", () => {
    const req = makeReq({
      "x-nf-client-connection-ip": "garbage",
      "x-real-ip": "203.0.113.99", // would be a valid IP, but NOT trusted on Netlify
    });
    expect(getClientIp(req as never)).toBe(null);
  });

  test("X-Forwarded-For is never trusted on Netlify", () => {
    const req = makeReq({ "x-forwarded-for": "203.0.113.50" });
    expect(getClientIp(req as never)).toBe(null);
  });

  test("no headers on Netlify → null", () => {
    const req = makeReq({});
    expect(getClientIp(req as never)).toBe(null);
  });
});

// ===========================================================================
// Phase B3.4.1 — Default deployment (off-Netlify / Caddy self-hosted).
// X-Real-IP IS trusted here because Caddy's `header_up X-Real-IP
// {remote_host}` overwrites any client-supplied value (see Caddyfile).
// ===========================================================================

describe("getClientIp on default deployment (off-Netlify)", () => {
  beforeEach(() => {
    // Explicitly ensure NETLIFY is unset (default deployment).
    delete process.env.NETLIFY;
  });

  test("deployment detection reports 'caddy'", () => {
    expect(__currentDeployment()).toBe("caddy");
  });

  test("X-Real-IP is trusted on the default (Caddy) deployment", () => {
    const req = makeReq({ "x-real-ip": "203.0.113.42" });
    expect(getClientIp(req as never)).toBe("203.0.113.42");
  });
});
