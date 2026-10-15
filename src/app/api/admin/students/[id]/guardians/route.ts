/**
 * POST /api/admin/students/:id/guardians — link a guardian to a student.
 * GET  /api/admin/students/:id/guardians — list guardian links for a student.
 *
 * Query: ?academyId=<uuid> (required — validated against the principal's
 *   admin membership).
 *
 * POST body: { guardianUserId, isPrimary?, relationship? }
 *
 * Authorization: admin role in the specified academy. CSRF required for POST.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { createGuardianLink, listGuardianLinks } from "@/lib/domain/guardians";

const uuidSchema = z.string().uuid();

const createSchema = z.object({
  guardianUserId: z.string().uuid(),
  isPrimary: z.boolean().optional(),
  relationship: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;

  const uuidCheck = uuidSchema.safeParse(studentId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } },
      { status: 422 },
    );
  }

  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId, requireCsrf: true },
    async (principal) => {
      const body = await parseBody(request, createSchema);
      if (body instanceof NextResponse) return body;
      const result = await createGuardianLink(principal, academyId, studentId, body);
      return NextResponse.json(result, { status: 201 });
    },
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;

  const uuidCheck = uuidSchema.safeParse(studentId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } },
      { status: 422 },
    );
  }

  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId },
    async (principal) => {
      const links = await listGuardianLinks(principal, academyId, studentId);
      return NextResponse.json({ guardians: links });
    },
  );
}
