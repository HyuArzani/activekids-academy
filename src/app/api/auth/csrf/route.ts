/**
 * GET /api/auth/csrf
 *
 * Returns the current CSRF token (read from the cookie) so that
 * client-side JS can include it in the X-CSRF-Token header for
 * state-changing requests. This endpoint is a convenience — the CSRF
 * cookie is already readable by JS (NOT HttpOnly), so clients can also
 * read document.cookie directly.
 *
 * Requires a valid session. Does NOT require must_change_password=false.
 * Does NOT require CSRF (GET request).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { toSafeResponse } from "@/lib/errors";
import {
  extractPrincipal,
  requirePrincipal,
} from "@/lib/auth/principal";
import {
  deriveCsrfToken,
  csrfCookieName,
} from "@/lib/auth/csrf";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const db = getDb();
    const extracted = await extractPrincipal(request, db);
    const principal = requirePrincipal(extracted?.principal ?? null);
    // Re-derive the CSRF token from the session token (stateless HMAC).
    // The raw token is in `extracted.rawToken` — we use it to recompute.
    const csrfToken = deriveCsrfToken(extracted!.rawToken);
    void principal;
    return NextResponse.json({ csrfToken }, { status: 200 });
  } catch (err) {
    const safe = toSafeResponse(err);
    return NextResponse.json(safe.body, { status: safe.status });
  }
}

// Silence unused-import warning.
void csrfCookieName;
