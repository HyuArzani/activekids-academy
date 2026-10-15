/**
 * POST /api/auth/logout
 *
 * Revokes the current session (sets revoked_at) and clears both the session
 * and CSRF cookies. Idempotent — calling without a session returns 204.
 *
 * Requires CSRF validation (state-changing request).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { toSafeResponse } from "@/lib/errors";
import {
  extractPrincipal,
  requirePrincipal,
  revokeSession,
} from "@/lib/auth/principal";
import {
  sessionCookieName,
  sessionCookieAttributes,
} from "@/lib/auth/session";
import {
  csrfCookieName,
  csrfCookieAttributes,
  verifyCsrf,
  CSRF_HEADER,
} from "@/lib/auth/csrf";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const db = getDb();
    const extracted = await extractPrincipal(request, db);
    if (!extracted) {
      // Not authenticated — still clear cookies (idempotent logout).
      const response = NextResponse.json({ ok: true }, { status: 200 });
      response.cookies.delete(sessionCookieName());
      response.cookies.delete(csrfCookieName());
      return response;
    }
    const { principal, rawToken } = extracted;

    // CSRF validation: must match session token HMAC.
    const csrfCookie = request.cookies.get(csrfCookieName())?.value;
    const csrfHeader = request.headers.get(CSRF_HEADER) ?? undefined;
    if (!verifyCsrf(rawToken, csrfCookie, csrfHeader)) {
      const response = NextResponse.json(
        { error: { code: "CSRF_INVALID", message: "Invalid CSRF token" } },
        { status: 403 },
      );
      return response;
    }

    await revokeSession(db, principal.sessionId);

    const response = NextResponse.json({ ok: true }, { status: 200 });
    response.cookies.set(sessionCookieName(), "", sessionCookieAttributes(0));
    response.cookies.set(csrfCookieName(), "", csrfCookieAttributes(0));
    return response;
  } catch (err) {
    const safe = toSafeResponse(err);
    return NextResponse.json(safe.body, { status: safe.status });
  }
}

// requirePrincipal is imported for parity with other protected routes; this
// route uses the idempotent pattern (no principal required for logout).
void requirePrincipal;
