/**
 * GET /api/public/application?id=X
 *
 * Public, unauthenticated lookup of a registration application by ID.
 * Returns a LIMITED view of the application — enough for the parent
 * to check the status, but NOT the full admin view.
 *
 * Returns only:
 *   - status (pending | approved | rejected)
 *   - childFullName (so the parent can confirm it's their application)
 *   - submittedAt
 *   - reviewedAt (null if pending)
 *   - rejectionReason (null unless rejected)
 *
 * Does NOT return: parentFullName, parentPhone, parentEmail,
 * preferredContact, classPreference, preferredDay, notes, academyId,
 * reviewedBy, studentId, source.
 *
 * This is intentionally minimal — the reference ID is a UUID, which is
 * not easily guessable, but we still minimize the data surface.
 *
 * Rate limited by IP (reuses login_attempts infrastructure).
 * NOTE: This endpoint does NOT currently rate-limit by IP — the
 * lookup is by UUID (122 bits of entropy, not guessable). The
 * getClientIp import was removed as unused.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { toSafeResponse } from "@/lib/errors";

const uuidSchema = z.string().uuid();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Application ID is required" } },
      { status: 422 },
    );
  }
  const idCheck = uuidSchema.safeParse(id);
  if (!idCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid application ID format" } },
      { status: 422 },
    );
  }

  try {
    const db = getDb();
    const result = await db.query<{
      status: string;
      child_full_name: string;
      submitted_at: Date;
      reviewed_at: Date | null;
      rejection_reason: string | null;
    }>(
      `SELECT status, child_full_name, submitted_at, reviewed_at, rejection_reason
         FROM registration_applications
        WHERE id = $1
        LIMIT 1;`,
      [id],
    );
    const row = result.rows[0] as
      | { status: string; child_full_name: string; submitted_at: Date; reviewed_at: Date | null; rejection_reason: string | null }
      | undefined;
    if (!row) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Application not found. Please check your reference ID." } },
        { status: 404 },
      );
    }

    // Return only the minimal public view.
    return NextResponse.json({
      application: {
        id,
        status: row.status,
        childFullName: row.child_full_name,
        submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at,
        reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at,
        rejectionReason: row.rejection_reason,
      },
    });
  } catch (err) {
    const safe = toSafeResponse(err);
    return NextResponse.json(safe.body, { status: safe.status });
  }
}
