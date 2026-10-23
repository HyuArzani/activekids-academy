/** GET/PATCH /api/admin/attendance/:id?academyId=X — get + update attendance. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getAttendance, updateAttendance } from "@/lib/domain/attendance";

const uuidSchema = z.string().uuid();
const statusSchema = z.enum(["present", "absent", "excused"]);
const updateSchema = z
  .object({
    status: statusSchema.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.notes !== undefined, {
    message: "Provide status and/or notes",
  });

export async function GET(
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
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const record = await getAttendance(principal, academyId, attendanceId);
    return NextResponse.json({ attendance: record });
  });
}

export async function PATCH(
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
    const body = await parseBody(request, updateSchema);
    if (body instanceof NextResponse) return body;
    await updateAttendance(principal, academyId, attendanceId, {
      status: body.status,
      notes: body.notes === undefined ? undefined : body.notes,
    });
    return NextResponse.json({ ok: true });
  });
}
