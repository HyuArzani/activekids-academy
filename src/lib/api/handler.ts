/**
 * Shared API route handler — provides consistent auth, CSRF, error mapping,
 * and retryable-conflict handling for all API endpoints.
 *
 * Pattern:
 *   export async function POST(request: NextRequest): Promise<NextResponse> {
 *     const academyId = request.nextUrl.searchParams.get("academyId") ?? "";
 *     return handleApiRequest(request, {
 *       role: "admin", academyId, requireCsrf: true,
 *     }, async (principal) => {
 *       const body = await parseBody(request, createSchema);
 *       const result = await createStudent(principal, academyId, body, getDb());
 *       return NextResponse.json(result, { status: 201 });
 *     });
 *   }
 *
 * This helper:
 *   1. Extracts the principal from the session cookie (never trusts client claims).
 *   2. Enforces must_change_password (unless allowMustChangePassword).
 *   3. Validates role + academy membership (cross-academy access → FORBIDDEN).
 *   4. Validates CSRF for state-changing requests.
 *   5. Calls the handler with the authenticated principal.
 *   6. Maps all errors via toSafeResponse (generic client messages).
 *   7. Sets Retry-After header for retryable serialization conflicts (40001/40P01).
 *   8. Does NOT add automatic retries — the client decides.
 *
 * Server-only. Never import from client code.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { toSafeResponse } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";
import {
  extractPrincipal,
  requirePrincipal,
  requireNotMustChangePassword,
  requireRole,
  requireAcademyMembership,
} from "@/lib/auth/principal";
import type { Role } from "@/lib/auth/principal";
import {
  csrfCookieName,
  verifyCsrf,
  CSRF_HEADER,
} from "@/lib/auth/csrf";
import { isRetryableConflict } from "@/lib/db/pg-errors";

export interface ApiHandlerOpts {
  /** Required role (admin, coach, or parent). */
  role: Role;
  /** Academy ID — validated against the principal's memberships. */
  academyId: string;
  /** Require CSRF verification (state-changing requests). */
  requireCsrf?: boolean;
  /** Allow principals with must_change_password=true (rarely needed). */
  allowMustChangePassword?: boolean;
}

/**
 * Handle an authenticated API request. Extracts the principal, validates
 * authorization, checks CSRF, and calls the handler. All errors are mapped
 * to safe client responses via `toSafeResponse`.
 */
export async function handleApiRequest(
  request: NextRequest,
  opts: ApiHandlerOpts,
  handler: (principal: Principal) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    // F9 fix: validate academyId is present before proceeding.
    if (!opts.academyId || opts.academyId.trim() === "") {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "academyId query parameter is required" } },
        { status: 422 },
      );
    }

    const db = getDb();
    const extracted = await extractPrincipal(request, db);
    const principal = requirePrincipal(extracted?.principal ?? null);

    // Forced password change gate (unless explicitly bypassed).
    if (!opts.allowMustChangePassword) {
      requireNotMustChangePassword(principal);
    }

    // Role + academy validation.
    requireRole(principal, opts.role, opts.academyId);
    requireAcademyMembership(principal, opts.academyId);

    // CSRF verification for state-changing requests.
    if (opts.requireCsrf && extracted) {
      const csrfCookie = request.cookies.get(csrfCookieName())?.value;
      const csrfHeader = request.headers.get(CSRF_HEADER) ?? undefined;
      if (!verifyCsrf(extracted.rawToken, csrfCookie, csrfHeader)) {
        return NextResponse.json(
          { error: { code: "CSRF_INVALID", message: "Invalid CSRF token" } },
          { status: 403 },
        );
      }
    }

    return await handler(principal);
  } catch (err) {
    const safe = toSafeResponse(err);
    const response = NextResponse.json(safe.body, { status: safe.status });
    // For retryable serialization conflicts, suggest a client retry.
    if (isRetryableConflict(err)) {
      response.headers.set("Retry-After", "1");
    }
    return response;
  }
}

/**
 * Parse and validate a JSON request body against a Zod schema.
 * Returns 422 on invalid JSON or schema validation failure.
 */
export async function parseBody<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
): Promise<T | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid JSON body" } },
      { status: 422 },
    );
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid input",
          detail: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      },
      { status: 422 },
    );
  }
  return result.data;
}

/**
 * Extract the academyId from the request's query parameters.
 * Returns empty string if not present.
 */
export function getAcademyIdFromQuery(request: NextRequest): string {
  return request.nextUrl.searchParams.get("academyId") ?? "";
}
