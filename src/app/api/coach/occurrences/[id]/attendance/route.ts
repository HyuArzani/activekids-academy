import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery, parseBody } from "@/lib/api/handler";
import { recordAttendance } from "@/lib/domain/attendance";

const schema = z.object({
  studentId: z.string().uuid(),
  status: z.enum(["present", "absent", "excused"]),
  entitlementId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});
const uuidSchema = z.string().uuid();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid occurrence ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, schema);
    if (body instanceof NextResponse) return body;
    return NextResponse.json(await recordAttendance(principal, academyId, { ...body, occurrenceId: id }), { status: 201 });
  });
}
