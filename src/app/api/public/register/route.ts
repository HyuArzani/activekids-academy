/**
 * POST /api/public/register
 *
 * Public, unauthenticated parent registration submission. Creates a
 * 'pending' application only — does NOT create student/guardian/package/
 * entitlement/payment/account.
 *
 * Rate limited by IP (reuses the existing login_attempts infrastructure).
 *
 * Idempotency: optional idempotencyKey. Same key + same body → return
 * original. Same key + different body → 409.
 *
 * The `source` is server-controlled ('website') — never trusted from the
 * client. Future Google Forms integration uses a separate authenticated
 * server-side endpoint.
 *
 * The client cannot set: status, academyId (validated to exist), reviewedBy,
 * studentId, or other privileged fields.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { submitRegistration } from "@/lib/domain/registration";
import { getDb } from "@/lib/db";
import { toSafeResponse } from "@/lib/errors";
import { isRetryableConflict } from "@/lib/db/pg-errors";
import { getClientIp } from "@/lib/auth/client-ip";

const registerSchema = z.object({
  academyId: z.string().min(1, "Academy ID is required"),
  parentFullName: z.string().min(1, "Parent full name is required").max(200),
  parentPhone: z.string().min(1, "Parent phone is required").max(50),
  parentEmail: z.string().email().max(200).optional(),
  preferredContact: z.enum(["phone", "email", "whatsapp"]).optional(),
  childFullName: z.string().min(1, "Child full name is required").max(200),
  childDateOfBirth: z.string().date().optional(),
  classPreference: z.string().max(200).nullable().optional(),
  preferredDay: z.string().max(50).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  idempotencyKey: z.string().min(1).max(100).optional(),
}).strict(); // reject unknown fields — no source, status, studentId, etc.

/**
 * IP extraction uses the shared `getClientIp()` helper
 * (src/lib/auth/client-ip.ts), which is deployment-aware:
 *   - On Netlify: only `x-nf-client-connection-ip` is trusted.
 *     `X-Real-IP` is ignored (Netlify provides no overwrite guarantee).
 *   - Off Netlify (Caddy self-hosted): `x-nf-client-connection-ip` is
 *     checked first, then `X-Real-IP` (Caddy overwrites it).
 *   - `X-Forwarded-For` is NEVER trusted on any deployment.
 *
 * When no trusted IP is available, the domain layer applies a small,
 * independent GLOBAL fallback cap (not a shared per-IP "unknown" bucket
 * — that would be a DoS vector against real per-IP users). See
 * registration.ts and rateLimit.ts (REGISTRATION_NO_TRUSTED_IP_BUCKET).
 * Other protections remain: idempotency keys, input validation,
 * request-size limits, database UNIQUE constraints.
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid JSON body" } },
      { status: 422 },
    );
  }

  const result = registerSchema.safeParse(body);
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

  try {
    // The Zod schema allows nullable optionals (classPreference, preferredDay,
    // notes); the domain's SubmitRegistrationInput treats them as optional
    // strings. Null is treated as absent — the domain stores null as NULL.
    const input = {
      academyId: result.data.academyId,
      parentFullName: result.data.parentFullName,
      parentPhone: result.data.parentPhone,
      parentEmail: result.data.parentEmail,
      preferredContact: result.data.preferredContact,
      childFullName: result.data.childFullName,
      childDateOfBirth: result.data.childDateOfBirth,
      classPreference: result.data.classPreference ?? undefined,
      preferredDay: result.data.preferredDay ?? undefined,
      notes: result.data.notes ?? undefined,
      idempotencyKey: result.data.idempotencyKey,
    };
    const res = await submitRegistration(input, ip, getDb());
    return NextResponse.json(
      { applicationId: res.applicationId, replayed: res.replayed },
      { status: res.replayed ? 200 : 201 },
    );
  } catch (err) {
    const safe = toSafeResponse(err);
    const response = NextResponse.json(safe.body, { status: safe.status });
    if (isRetryableConflict(err)) {
      response.headers.set("Retry-After", "1");
    }
    return response;
  }
}
