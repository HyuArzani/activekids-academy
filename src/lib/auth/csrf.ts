/**
 * CSRF protection (stateless, HMAC-tied double-submit).
 *
 * Design:
 *   - On login, the server derives `csrf_token = HMAC-SHA256(session_token,
 *     CSRF_SECRET)` and sets it in a NON-HttpOnly cookie (so client JS can
 *     read it) with SameSite=Lax.
 *   - For state-changing requests (POST/PUT/PATCH/DELETE), the client reads
 *     the CSRF cookie and submits the same value in an `X-CSRF-Token` header.
 *   - The server recomputes the HMAC from the session cookie (the raw token)
 *     and compares it to BOTH the CSRF cookie AND the X-CSRF-Token header.
 *     All three must match.
 *
 * Why this is secure:
 *   1. An attacker submitting a cross-site POST cannot read the victim's
 *      CSRF cookie (Same-origin policy). Without the cookie value, the
 *      header won't match.
 *   2. SameSite=Lax on the CSRF cookie provides additional defense: the
 *      cookie is not sent on cross-site POST requests, so the header check
 *      fails.
 *   3. CSRF cookie fixation is prevented by the HMAC tie: an attacker
 *      cannot set the victim's CSRF cookie to a known value and submit it,
 *      because the HMAC requires the CSRF_SECRET (server-only) and the
 *      victim's session token (in the HttpOnly cookie, unreadable).
 *
 * Why stateless (no DB storage):
 *   - The CSRF token is derived from the session token, so it rotates on
 *     every login. No DB column needed.
 *   - The server already loads the session on protected requests; the CSRF
 *     check adds zero DB cost.
 *
 * Server-only. Never import from client code. The CSRF_SECRET is read from
 * env and never logged.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { Err } from "@/lib/errors";

/** Derive the CSRF token from a session token using HMAC-SHA256. */
export function deriveCsrfToken(sessionToken: string): string {
  if (!sessionToken) {
    throw Err.config("Cannot derive CSRF token from empty session token");
  }
  const hmac = createHmac("sha256", env.CSRF_SECRET);
  hmac.update(sessionToken);
  return hmac.digest("base64url");
}

/** Cookie attributes for the CSRF cookie. NOT HttpOnly (client JS reads it). */
export function csrfCookieAttributes(maxAgeSeconds: number) {
  const secure = env.NODE_ENV === "production";
  return {
    httpOnly: false,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Cookie name for the CSRF token. */
export function csrfCookieName(): string {
  return env.CSRF_COOKIE_NAME;
}

/** Header name for the submitted CSRF token. */
export const CSRF_HEADER = "x-csrf-token";

/**
 * Verify a CSRF request. The session token is the raw value from the
 * session cookie. The csrfCookieValue is from the CSRF cookie. The
 * csrfHeaderValue is from the X-CSRF-Token header. All three must be
 * consistent: the derived HMAC of the session token must equal BOTH the
 * CSRF cookie AND the header.
 *
 * Returns true if valid, false otherwise. Never throws.
 */
export function verifyCsrf(
  sessionToken: string,
  csrfCookieValue: string | undefined,
  csrfHeaderValue: string | undefined,
): boolean {
  if (!sessionToken || !csrfCookieValue || !csrfHeaderValue) return false;
  const expected = deriveCsrfToken(sessionToken);
  return (
    constantTimeEqualStr(expected, csrfCookieValue) &&
    constantTimeEqualStr(expected, csrfHeaderValue)
  );
}

function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
