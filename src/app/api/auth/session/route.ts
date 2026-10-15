/**
 * GET /api/auth/session
 *
 * Returns the current principal (sanitized) if authenticated, or 401 if not.
 * This is the endpoint the page shell calls to determine the initial view
 * (login form vs logged-in view vs change-password form).
 *
 * Does NOT require CSRF (GET request, no state change).
 * Does NOT require must_change_password=false (the page needs to know the
 * principal's state to render the change-password form).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { toSafeResponse } from "@/lib/errors";
import {
  extractPrincipal,
  requirePrincipal,
} from "@/lib/auth/principal";
import { sanitizePrincipal } from "@/lib/auth/service";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const db = getDb();
    const extracted = await extractPrincipal(request, db);
    const principal = requirePrincipal(extracted?.principal ?? null);
    return NextResponse.json(
      { principal: sanitizePrincipal(principal) },
      { status: 200 },
    );
  } catch (err) {
    const safe = toSafeResponse(err);
    return NextResponse.json(safe.body, { status: safe.status });
  }
}
