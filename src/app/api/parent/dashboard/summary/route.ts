/** GET /api/parent/dashboard/summary?academyId=X — parent dashboard overview. */
import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getParentDashboardSummary } from "@/lib/domain/parent-portal";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "parent", academyId }, async (principal) => {
    const summary = await getParentDashboardSummary(principal, academyId);
    return NextResponse.json(summary);
  });
}
