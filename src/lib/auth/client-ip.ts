/**
 * Shared client-IP extraction for rate limiting.
 *
 * Trust model (deployment-specific, EXPLICIT — never trust a header
 * merely because it contains a syntactically valid IP address):
 *
 * 1. Netlify (serverless functions, no Caddy in front):
 *    `x-nf-client-connection-ip` is the ONLY trusted header. Netlify's
 *    platform sets it on the request before it reaches the Next.js
 *    function, and the platform overwrites any client-supplied value
 *    (the client cannot influence it). Source: Netlify Answers
 *    (answers.netlify.com) recommends `x-nf-client-connection-ip` as
 *    the most reliable client-IP header on Netlify.
 *
 *    `X-Real-IP` is NOT trusted on Netlify. Netlify publishes no
 *    guarantee that it overwrites `X-Real-IP`, so a client MAY be able
 *    to set it. Trusting it would let an attacker rotate the
 *    rate-limit bucket by sending a different `X-Real-IP` on each
 *    request. When `x-nf-client-connection-ip` is missing or invalid
 *    on Netlify, `getClientIp()` returns `null` — the caller applies
 *    the documented global fallback (see registration.ts).
 *
 * 2. Self-hosted behind Caddy (the deployment documented by Caddyfile):
 *    `x-nf-client-connection-ip` is checked first (it will be absent —
 *    no Netlify). `X-Real-IP` is then trusted because Caddy's
 *    `header_up X-Real-IP {remote_host}` (see Caddyfile) OVERWRITES
 *    any client-supplied value. An attacker connecting to Caddy
 *    cannot influence the `X-Real-IP` value that reaches the app.
 *
 *    This path is also used by the local dev gateway (the sandbox
 *    Caddy on port 81), which is configured identically.
 *
 * 3. Direct dev / no proxy (no NETLIFY, no Caddy):
 *    Neither header is set → returns `null` → the caller applies the
 *    documented global fallback (see registration.ts). This is a known
 *    dev-only condition; production is always on Netlify or behind
 *    Caddy. The global fallback bounds abuse even in this case.
 *
 * `X-Forwarded-For` is NEVER trusted on any deployment:
 *   - On Netlify, the platform MAY append to it rather than overwrite,
 *     so the first hop could be attacker-controlled.
 *   - An attacker can set `X-Forwarded-For: fake-ip` to try to bypass
 *     rate limiting. Because this code never inspects `X-Forwarded-For`,
 *     that header cannot select the rate-limit bucket.
 *
 * When no trusted IP is available:
 *   - Returns `null`.
 *   - The caller (e.g., `submitRegistration`) does NOT put all
 *     unidentified clients into one shared per-IP bucket. Instead it
 *     applies a small, independent GLOBAL cap (see registration.ts).
 *     This bounds abuse without rejecting legitimate users outright
 *     and without letting an attacker lock out real per-IP users by
 *     flooding a shared "unknown" bucket.
 *
 * Server-only. Never import from client code.
 */

import { isIP } from "node:net";
import type { NextRequest } from "next/server";

/**
 * Detect Netlify deployment. Netlify automatically sets `NETLIFY=true`
 * in the build/runtime environment (Netlify configuration variables).
 * This is portable: off Netlify, the variable is undefined and the
 * Caddy deployment path is used.
 */
function isNetlifyDeployment(): boolean {
  return process.env.NETLIFY === "true";
}

/**
 * Headers trusted on a Netlify deployment (in priority order).
 * Only `x-nf-client-connection-ip` — the platform-set header.
 */
const NETLIFY_TRUSTED_HEADERS = [
  "x-nf-client-connection-ip",
] as const;

/**
 * Headers trusted on a self-hosted Caddy deployment (in priority order).
 * `x-nf-client-connection-ip` is checked first (harmless on Caddy — it
 * won't be present). `X-Real-IP` is trusted because Caddy overwrites it
 * via `header_up X-Real-IP {remote_host}` (see Caddyfile).
 */
const CADDY_TRUSTED_HEADERS = [
  "x-nf-client-connection-ip", // absent on Caddy — checked first for symmetry
  "x-real-ip",
] as const;

/**
 * Extract a trustworthy client IP from the request, using the
 * deployment-specific trust boundary.
 *
 * On Netlify: only `x-nf-client-connection-ip` is trusted; `X-Real-IP`
 * is ignored (Netlify provides no overwrite guarantee for it).
 * Off Netlify: `x-nf-client-connection-ip` is checked first, then
 * `X-Real-IP` (Caddy gateway-set).
 *
 * Validates the IP format via Node.js `isIP()`. Returns `null` when
 * no trusted, valid IP is available — the caller applies a documented
 * fallback.
 *
 * NEVER trusts `X-Forwarded-For` on any deployment.
 */
export function getClientIp(request: NextRequest): string | null {
  const trustedHeaders = isNetlifyDeployment()
    ? NETLIFY_TRUSTED_HEADERS
    : CADDY_TRUSTED_HEADERS;

  for (const header of trustedHeaders) {
    const raw = request.headers.get(header);
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Validate IP format. isIP returns 4 (IPv4), 6 (IPv6), or 0 (invalid).
    // Rejects: arbitrary strings, comma-separated chains, non-IP values.
    if (isIP(trimmed) > 0) {
      return trimmed;
    }
  }
  // No trusted + valid IP available. Caller applies the documented
  // global fallback (see registration.ts).
  return null;
}

/**
 * Test-only helper: explicitly read the deployment detection. Used by
 * tests that need to assert behavior conditional on the deployment.
 * Not used by production code (which goes through `getClientIp`).
 */
export function __currentDeployment(): "netlify" | "caddy" {
  return isNetlifyDeployment() ? "netlify" : "caddy";
}
