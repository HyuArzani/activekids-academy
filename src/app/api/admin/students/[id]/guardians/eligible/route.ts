/**
 * GET /api/admin/students/:id/guardians/eligible?q=<query>
 *
 * Search for users eligible to be linked as a guardian for a student.
 * Used by the AddGuardian UI to replace the old UUID-paste workflow.
 *
 * Query parameters:
 *   - academyId=<uuid> (required — validated against the principal's
 *     admin membership).
 *   - q=<search query> (required — minimum 2 characters after trim;
 *     shorter queries return an empty list rather than loading all
 *     parents in the academy).
 *
 * Returns: { eligible: [{ id, email, fullName, isAlreadyLinked }] }
 *   - Only parent-role users with an ACTIVE membership in the academy.
 *   - Only active users (u.status = 'active').
 *   - Match: email OR full_name ILIKE '%q%' (case-insensitive, partial).
 *   - isAlreadyLinked: true if this user is already linked to THIS
 *     student (UX hint — the POST endpoint is the real duplicate-
 *     prevention layer via the UNIQUE constraint).
 *   - Limited to 20 results (ELIGIBLE_GUARDIAN_MAX_RESULTS).
 *
 * Authorization: admin role in the specified academy. No CSRF required
 * (GET is read-only). Cross-academy student UUID → 404 NOT_FOUND (via
 * loadStudentInAcademy in the domain layer).
 *
 * Does NOT return: password hashes, session tokens, credentials, or
 * any data from other academies. This is NOT a general-purpose user
 * directory — it is narrowly scoped to "who can I link to THIS student
 * in THIS academy".
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { searchEligibleGuardians, ELIGIBLE_GUARDIAN_MIN_QUERY } from "@/lib/domain/guardians";

const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;

  // Validate the :id is a UUID before hitting the database.
  const uuidCheck = uuidSchema.safeParse(studentId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } },
      { status: 422 },
    );
  }

  const academyId = getAcademyIdFromQuery(request);
  const rawQuery = request.nextUrl.searchParams.get("q") ?? "";

  return handleApiRequest(
    request,
    { role: "admin", academyId },
    async (principal) => {
      // Sanitize + validate the search query. The domain also enforces
      // the minimum length, but returning 422 here gives a clearer
      // client signal than an empty list for a malformed request.
      const trimmed = rawQuery.trim();
      if (trimmed.length > 0 && trimmed.length < ELIGIBLE_GUARDIAN_MIN_QUERY) {
        return NextResponse.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: `Search query must be at least ${ELIGIBLE_GUARDIAN_MIN_QUERY} characters.`,
            },
          },
          { status: 422 },
        );
      }

      const eligible = await searchEligibleGuardians(
        principal,
        academyId,
        studentId,
        trimmed,
      );
      return NextResponse.json({ eligible });
    },
  );
}
