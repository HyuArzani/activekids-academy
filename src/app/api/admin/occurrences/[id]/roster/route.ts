/** GET /api/admin/occurrences/:id/roster?academyId=X — occurrence roster. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getOccurrenceRoster } from "@/lib/domain/attendance";

const uuidSchema = z.string().uuid();

export async function GET(
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
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const result = await getOccurrenceRoster(principal, academyId, occurrenceId);
    return NextResponse.json(result);
  });
}
