/** GET /api/parent/children?academyId=X — parent's linked children list. */
import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getParentChildren } from "@/lib/domain/parent-portal";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "parent", academyId }, async (principal) => {
    const children = await getParentChildren(principal, academyId);
    return NextResponse.json({ children });
  });
}
