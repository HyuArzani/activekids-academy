/** POST /api/admin/registrations/:id/reject?academyId=X — reject application. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { rejectRegistration } from "@/lib/domain/registration";

const uuidSchema = z.string().uuid();
const rejectSchema = z.object({
  reason: z.string().min(1, "Reason is required").max(2000),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const uuidCheck = uuidSchema.safeParse(id);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid application ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, rejectSchema);
    if (body instanceof NextResponse) return body;
    await rejectRegistration(principal, academyId, id, body.reason);
    return NextResponse.json({ ok: true });
  });
}
