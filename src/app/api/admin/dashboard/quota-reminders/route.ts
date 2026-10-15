/** GET /api/admin/dashboard/quota-reminders?academyId=X — live quota reminder lists. */
import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getQuotaReminders } from "@/lib/domain/dashboard";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const result = await getQuotaReminders(principal, academyId);
    return NextResponse.json(result);
  });
}
