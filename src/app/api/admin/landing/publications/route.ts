/** GET /api/admin/landing/publications?academyId=X — list publication history. */
import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { listLandingPagePublications } from "@/lib/domain/cms";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const publications = await listLandingPagePublications(principal, academyId);
    return NextResponse.json({ publications });
  });
}
