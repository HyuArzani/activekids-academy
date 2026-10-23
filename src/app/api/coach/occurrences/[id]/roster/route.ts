import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getCoachOccurrenceRoster } from "@/lib/domain/coach-attendance";

const uuidSchema = z.string().uuid();

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid occurrence ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId }, async (principal) =>
    NextResponse.json(await getCoachOccurrenceRoster(principal, academyId, id)),
  );
}
