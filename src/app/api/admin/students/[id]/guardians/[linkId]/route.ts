/**
 * DELETE /api/admin/students/:id/guardians/:linkId — remove a guardian link.
 *
 * Query: ?academyId=<uuid> (required — validated against the principal's
 *   admin membership).
 *
 * Authorization: admin role in the specified academy. CSRF required.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { removeGuardianLink } from "@/lib/domain/guardians";

const uuidSchema = z.string().uuid();

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; linkId: string }> },
): Promise<NextResponse> {
  const { id: studentId, linkId } = await context.params;

  const studentIdCheck = uuidSchema.safeParse(studentId);
  if (!studentIdCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } },
      { status: 422 },
    );
  }

  const linkIdCheck = uuidSchema.safeParse(linkId);
  if (!linkIdCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid link ID format" } },
      { status: 422 },
    );
  }

  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId, requireCsrf: true },
    async (principal) => {
      await removeGuardianLink(principal, academyId, studentId, linkId);
      return NextResponse.json({ ok: true }, { status: 200 });
    },
  );
}
