/**
 * POST /api/auth/change-password
 *
 * Body: { currentPassword, newPassword }
 * Requires: valid session + valid CSRF token.
 *
 * CSRF enforcement:
 *   The login route sets BOTH the session cookie (HttpOnly) AND the CSRF
 *   cookie (NOT HttpOnly) on every successful login. Therefore, a user
 *   who is forced to change their password (must_change_password=true)
 *   DOES have a CSRF token available immediately after login — the client
 *   JS reads `futsal_csrf` from `document.cookie` and submits it in the
 *   `X-CSRF-Token` header. The earlier exemption was based on incorrect
 *   reasoning and has been removed.
 *
 *   The current-password verification is proof of IDENTITY (the requester
 *   knows the current password). CSRF verification is proof of ORIGIN
 *   (the request came from the same site that set the cookies). These are
 *   DIFFERENT security controls; both are required.
 *
 * This endpoint is EXEMPT from the must_change_password gate — it IS the
 * escape hatch. We do NOT call requireNotMustChangePassword here.
 *
 * After successful change:
 *   - `must_change_password` is set to false.
 *   - The CURRENT session remains valid (the user shouldn't be logged out
 *     for changing their password).
 *   - All OTHER sessions for this user are revoked (security precaution,
 *     performed transactionally with the password update).
 *
 * Errors:
 *   - 401: not authenticated, or current password incorrect
 *   - 403: CSRF token missing/invalid
 *   - 422: new password too short or equals current
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { toSafeResponse } from "@/lib/errors";
import {
  extractPrincipal,
  requirePrincipal,
} from "@/lib/auth/principal";
import { changePassword, sanitizePrincipal } from "@/lib/auth/service";
import {
  csrfCookieName,
  verifyCsrf,
  CSRF_HEADER,
} from "@/lib/auth/csrf";

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid JSON body" } },
      { status: 422 },
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid input",
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      },
      { status: 422 },
    );
  }

  try {
    const db = getDb();
    const extracted = await extractPrincipal(request, db);
    if (!extracted) {
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 },
      );
    }
    const { principal, rawToken } = extracted;

    // CSRF verification: the session token's HMAC must match BOTH the CSRF
    // cookie AND the X-CSRF-Token header. This is a state-changing
    // authenticated request — CSRF is required.
    const csrfCookie = request.cookies.get(csrfCookieName())?.value;
    const csrfHeader = request.headers.get(CSRF_HEADER) ?? undefined;
    if (!verifyCsrf(rawToken, csrfCookie, csrfHeader)) {
      return NextResponse.json(
        { error: { code: "CSRF_INVALID", message: "Invalid CSRF token" } },
        { status: 403 },
      );
    }

    // This endpoint is EXEMPT from the must_change_password gate — it IS
    // the escape hatch. We do NOT call requireNotMustChangePassword here.

    await changePassword(
      principal,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      db,
    );

    // Re-load the principal (must_change_password is now false).
    const reExtracted = await extractPrincipal(request, db);
    const rePrincipal = requirePrincipal(reExtracted?.principal ?? null);

    return NextResponse.json(
      { principal: sanitizePrincipal(rePrincipal) },
      { status: 200 },
    );
  } catch (err) {
    const safe = toSafeResponse(err);
    return NextResponse.json(safe.body, { status: safe.status });
  }
}
