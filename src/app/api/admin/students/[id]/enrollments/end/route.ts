/** POST /api/admin/students/:id/enrollments/end — end active enrollment. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { endEnrollment } from "@/lib/domain/enrollments";

const uuidSchema = z.string().uuid();
const endSchema = z.object({
  effectiveTo: z.string().date(),
  reason: z.string().optional(),
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
    const body = await parseBody(request, endSchema);
    if (body instanceof NextResponse) return body;
    await endEnrollment(principal, academyId, studentId, { effectiveTo: new Date(body.effectiveTo), reason: body.reason });
    return NextResponse.json({ ok: true }, { status: 200 });
  });
}
