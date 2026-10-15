/**
 * POST /api/admin/students — create a student.
 * GET /api/admin/students — list students (academy-scoped).
 *
 * Query: ?academyId=<uuid> (required — validated against the principal's
 *   admin membership).
 *
 * POST body: { fullName, dateOfBirth?, gender?, notes? }
 * GET query: ?classId?, ?includeArchived?
 *
 * Authorization: admin role in the specified academy. CSRF required for POST.
 * Cross-academy: the academyId is validated against the principal's
 *   memberships; a valid UUID from another academy → FORBIDDEN.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { createStudent, listStudents } from "@/lib/domain/students";

const createSchema = z.object({
  fullName: z.string().min(1, "Full name is required"),
  dateOfBirth: z.string().date().optional(),
  gender: z.enum(["male", "female", "unspecified"]).optional(),
  notes: z.string().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId, requireCsrf: true },
    async (principal) => {
      const body = await parseBody(request, createSchema);
      if (body instanceof NextResponse) return body;
      const result = await createStudent(principal, academyId, body);
      return NextResponse.json(result, { status: 201 });
    },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId },
    async (principal) => {
      const classId = request.nextUrl.searchParams.get("classId") ?? undefined;
      const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
      const result = await listStudents(principal, academyId, { classId, includeArchived });
      return NextResponse.json(result);
    },
  );
}
