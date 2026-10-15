/** POST /api/admin/students/:id/transfer — transfer to another class. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { transferClass } from "@/lib/domain/enrollments";

const uuidSchema = z.string().uuid();
const transferSchema = z.object({
  newClassId: z.string().uuid(),
  effectiveFrom: z.string().date(),
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
    const body = await parseBody(request, transferSchema);
    if (body instanceof NextResponse) return body;
    const result = await transferClass(principal, academyId, { studentId, newClassId: body.newClassId, effectiveFrom: new Date(body.effectiveFrom), reason: body.reason });
    return NextResponse.json(result, { status: 200 });
  });
}
