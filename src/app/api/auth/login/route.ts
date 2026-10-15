/**
 * POST /api/auth/login
 *
 * Body: { email, password }
 * Sets: session cookie (HttpOnly) + CSRF cookie (NOT HttpOnly)
 * Returns: { principal: sanitizedPrincipal } — never includes the session
 * token or password hash.
 *
 * Security:
 *   - Generic failure message ("Invalid email or password") to prevent
 *     user enumeration (no distinguishable errors for not-found vs
 *     wrong-password vs inactive).
 *   - Timing equalization: a dummy Argon2id verify runs on user-not-found
 *     so response time is indistinguishable from a wrong-password attempt.
 *   - Rate-limited per-email AND per-IP (DB-backed, shared across instances).
 *     The per-IP check runs BEFORE body parsing so malformed requests
 *     cannot bypass rate limiting.
 *   - Session token is opaque; only the SHA-256 hash is stored.
 *   - CSRF token is HMAC-derived from the session token (stateless).
 *   - Concurrent sessions explicitly allowed: each login creates a new,
 *     independent session. Existing sessions are NOT revoked on login.
 *
 * IP extraction:
 *   Uses the shared `getClientIp()` helper (src/lib/auth/client-ip.ts).
 *   Checks `x-nf-client-connection-ip` (Netlify) then `X-Real-IP` (Caddy).
 *   Does NOT trust `X-Forwarded-For` (attacker-controllable on Netlify).
 *   When no trusted IP is available, IP-based rate limiting is SKIPPED
 *   (not replaced with a shared "unknown" bucket — that's a DoS vector).
 *   Email-based rate limiting in `login()` still applies for valid emails.
 *
 * Errors (all sanitized):
 *   - 422: invalid JSON body
 *   - 429: rate limit exceeded (with Retry-After header)
 *   - 401: invalid credentials (generic, no enumeration)
 *   - 426: must-change-password (returned by downstream protected handlers,
 *     not by login itself — login succeeds and the principal carries the flag)
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { login, sanitizePrincipal } from "@/lib/auth/service";
import { toSafeResponse, AppError } from "@/lib/errors";
import {
  sessionCookieName,
  sessionCookieAttributes,
} from "@/lib/auth/session";
import {
  csrfCookieName,
  csrfCookieAttributes,
} from "@/lib/auth/csrf";
import { checkRateLimit, recordLoginAttempt } from "@/lib/auth/rateLimit";
import { getClientIp } from "@/lib/auth/client-ip";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent");
  const db = getDb();

  // PER-IP RATE LIMIT CHECK — runs BEFORE body parsing.
  // This ensures malformed requests (invalid JSON, bad email format, short
  // password) cannot bypass rate limiting by failing before the rate-limit
  // check in `login()`.
  //
  // When no trusted IP is available (ip === null), IP-based rate limiting
  // is SKIPPED. This is safer than a shared "unknown" bucket (DoS vector
  // where one attacker locks out all legitimate users). Email-based rate
  // limiting in `login()` still applies for requests that reach login().
  if (ip) {
    const ipDecision = await checkRateLimit(db, ip, "ip");
    if (!ipDecision.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: `Too many login attempts from this IP. Retry in ${ipDecision.retryAfterSeconds}s.`,
          },
        },
        { status: 429 },
      );
    }
  }

  // Parse body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Record the failed attempt by IP (if available) so the rate limiter counts it.
    if (ip) {
      await recordLoginAttempt(db, ip, "ip", false, ip, userAgent);
    }
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid JSON body" } },
      { status: 422 },
    );
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    // Record the failed attempt by IP (if available).
    // (We can't record by email because the email might be malformed; we
    // use the IP as the identifier.)
    if (ip) {
      await recordLoginAttempt(db, ip, "ip", false, ip, userAgent);
    }
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid email or password",
        },
      },
      { status: 422 },
    );
  }

  try {
    const result = await login(
      { email: parsed.data.email, password: parsed.data.password },
      ip,
      userAgent,
      db,
    );

    const maxAge = Math.floor(
      (result.expiresAt.getTime() - Date.now()) / 1000,
    );
    const response = NextResponse.json(
      { principal: sanitizePrincipal(result.principal) },
      { status: 200 },
    );

    // Set session cookie (HttpOnly).
    response.cookies.set(
      sessionCookieName(),
      result.sessionToken,
      sessionCookieAttributes(maxAge),
    );
    // Set CSRF cookie (NOT HttpOnly — client JS reads it).
    response.cookies.set(
      csrfCookieName(),
      result.csrfToken,
      csrfCookieAttributes(maxAge),
    );

    return response;
  } catch (err) {
    const safe = toSafeResponse(err);
    const response = NextResponse.json(safe.body, { status: safe.status });
    if (err instanceof AppError && err.code === "RATE_LIMITED") {
      // Extract the retry-after seconds from the error message and set
      // the standard Retry-After header.
      const match = /Retry in (\d+)s/.exec(err.message);
      if (match) {
        response.headers.set("Retry-After", match[1]!);
      }
    }
    // The safe.body.error.message for UNAUTHORIZED is already generic
    // ("Invalid email or password") — no user enumeration.
    return response;
  }
}

// Silence unused-import warning for env (used in the cookie helpers
// imported above).
void env;
