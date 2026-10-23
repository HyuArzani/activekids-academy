import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery, parseBody } from "@/lib/api/handler";
import { updateAttendance } from "@/lib/domain/attendance";

const schema = z.object({
  status: z.enum(["present", "absent", "excused"]).optional(),
  notes: z.string().max(2000).nullable().optional(),
}).refine((body) => body.status !== undefined || body.notes !== undefined, { message: "Provide status and/or notes" });
const uuidSchema = z.string().uuid();

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid attendance ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, schema);
    if (body instanceof NextResponse) return body;
    await updateAttendance(principal, academyId, id, body);
    return NextResponse.json({ ok: true });
  });
}
