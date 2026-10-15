/** GET /api/admin/classes/:id/roster?academyId=X&date=YYYY-MM-DD — class roster for a date. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getClassRoster } from "@/lib/domain/enrollments";

const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: classId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(classId);
  if (!uuidCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid class ID format" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  const dateStr = request.nextUrl.searchParams.get("date");
  if (!dateStr) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "date query parameter is required (YYYY-MM-DD)" } }, { status: 422 });
  }
  const dateCheck = z.string().date().safeParse(dateStr);
  if (!dateCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid date format (use YYYY-MM-DD)" } }, { status: 422 });
  }
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const roster = await getClassRoster(principal, academyId, classId, new Date(dateCheck.data));
    return NextResponse.json({ roster });
  });
}
