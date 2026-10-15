/** POST /api/admin/attendance/:id/correct?academyId=X — admin correction. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { correctAttendance } from "@/lib/domain/attendance";

const uuidSchema = z.string().uuid();
const statusSchema = z.enum(["present", "absent", "excused", "late"]);
const correctSchema = z.object({
  status: statusSchema,
  reason: z.string().min(1, "Reason is required"),
  notes: z.string().max(2000).nullable().optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: attendanceId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(attendanceId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid attendance ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, correctSchema);
    if (body instanceof NextResponse) return body;
    await correctAttendance(principal, academyId, attendanceId, {
      status: body.status,
      reason: body.reason,
      notes: body.notes === undefined ? undefined : body.notes,
    });
    return NextResponse.json({ ok: true });
  });
}
