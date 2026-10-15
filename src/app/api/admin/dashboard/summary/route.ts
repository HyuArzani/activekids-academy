/** GET /api/admin/dashboard/summary?academyId=X — read-only academy metrics. */
import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getDashboardSummary } from "@/lib/domain/dashboard";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const summary = await getDashboardSummary(principal, academyId);
    return NextResponse.json(summary);
  });
}
