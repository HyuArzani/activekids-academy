/** POST /api/admin/occurrences/:id/attendance?academyId=X — record attendance. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { recordAttendance } from "@/lib/domain/attendance";

const uuidSchema = z.string().uuid();
const statusSchema = z.enum(["present", "absent", "excused", "late"]);
const recordSchema = z.object({
  studentId: z.string().uuid(),
  status: statusSchema,
  entitlementId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: occurrenceId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(occurrenceId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid occurrence ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, recordSchema);
    if (body instanceof NextResponse) return body;
    const result = await recordAttendance(principal, academyId, {
      occurrenceId,
      studentId: body.studentId,
      status: body.status,
      entitlementId: body.entitlementId,
      notes: body.notes,
    });
    return NextResponse.json(result, { status: 201 });
  });
}
