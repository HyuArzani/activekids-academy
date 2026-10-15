/** POST /api/admin/landing/revert?academyId=X — revert to an earlier published version. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { revertLandingPage } from "@/lib/domain/cms";

const revertSchema = z.object({
  versionNumber: z.number().int().positive(),
}).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, revertSchema);
    if (body instanceof NextResponse) return body;
    const result = await revertLandingPage(principal, academyId, body.versionNumber);
    return NextResponse.json(result);
  });
}
