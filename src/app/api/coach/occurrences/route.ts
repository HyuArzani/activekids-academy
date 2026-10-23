import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { listCoachOccurrences } from "@/lib/domain/coach-attendance";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId }, async (principal) =>
    NextResponse.json({ occurrences: await listCoachOccurrences(principal, academyId) }),
  );
}
