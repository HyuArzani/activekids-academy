/** GET /api/parent/children/:studentId/schedule?academyId=X — parent reads child schedule. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getChildSchedule } from "@/lib/domain/parent-portal";

const idSchema = z.string().min(1).refine(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), "Invalid ID format");

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const { studentId } = await context.params;
  const idCheck = idSchema.safeParse(studentId);
  if (!idCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "parent", academyId }, async (principal) => {
    const result = await getChildSchedule(principal, academyId, studentId);
    return NextResponse.json({ schedule: result });
  });
}
