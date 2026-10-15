/** GET /api/admin/reports/students?academyId=X — student roster report. */
import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getStudentRosterReport } from "@/lib/domain/reports";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const report = await getStudentRosterReport(principal, academyId);
    return NextResponse.json(report);
  });
}
