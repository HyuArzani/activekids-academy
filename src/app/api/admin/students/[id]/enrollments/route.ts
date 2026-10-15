/**
 * POST /api/admin/students/:id/enrollments — create enrollment.
 * GET  /api/admin/students/:id/enrollments — list enrollments (history + current).
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { createEnrollment, listEnrollments } from "@/lib/domain/enrollments";

const uuidSchema = z.string().uuid();
const createSchema = z.object({
  classId: z.string().uuid(),
  effectiveFrom: z.string().date(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(studentId);
  if (!uuidCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createEnrollment(principal, academyId, { studentId, classId: body.classId, effectiveFrom: new Date(body.effectiveFrom) });
    return NextResponse.json(result, { status: 201 });
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(studentId);
  if (!uuidCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const enrollments = await listEnrollments(principal, academyId, studentId);
    return NextResponse.json({ enrollments });
  });
}
