/**
 * Session token + cookie helpers.
 *
 * Design:
 *   - The session token is 32 bytes of `crypto.randomBytes` base64url-encoded
 *     (43 chars, URL-safe, no padding). This is the value sent to the client
 *     in an HttpOnly cookie.
 *   - Only the SHA-256 hash of the token is stored in the `sessions` table
 *     (`token_hash` column). Lookup: `hash(provided_token) = stored_hash`.
 *     A DB breach therefore does NOT expose live sessions.
 *   - Session fixation is prevented by rotating the token on every login
 *     (a new row is inserted with a fresh token_hash).
 *   - Sliding expiry: the `expires_at` is checked on every request. If the
 *     session is within a "refresh window" of expiry, a new session is
 *     issued (new token, new cookie). Absolute max age is enforced via
 *     `created_at` (≤ 7d from creation).
 *   - Revocation: `revoked_at` is set on logout. The row remains for audit.
 *
 * Cookie attributes:
 *   - HttpOnly: yes (JS cannot read the token)
 *   - Secure: yes in production (HTTPS only); no in dev (HTTP localhost)
 *   - SameSite: Lax (cookie is sent on same-site requests; protects against
 *     CSRF on top-level navigations while allowing the login redirect)
 *   - Path: /
 *   - Max-Age: SESSION_LIFETIME_SECONDS
 *
 * Server-only. Never import from client code.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Generate a fresh opaque session token (43-char base64url, 256 bits). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Hash a session token for storage/lookup (SHA-256 hex). */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Compare two token hashes in constant time to avoid timing attacks.
 * Returns true if they are equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Cookie attributes for the session cookie, given the current environment. */
export function sessionCookieAttributes(maxAgeSeconds: number) {
  const secure = env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Cookie name for the session token. */
export function sessionCookieName(): string {
  return env.SESSION_COOKIE_NAME;
}
