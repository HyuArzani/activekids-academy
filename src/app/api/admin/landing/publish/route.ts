/** POST /api/admin/landing/publish?academyId=X — publish the current draft. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { publishLandingPage } from "@/lib/domain/cms";

const publishSchema = z.object({
  publishNote: z.string().max(500).nullable().optional(),
}).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, publishSchema);
    if (body instanceof NextResponse) return body;
    const result = await publishLandingPage(principal, academyId, body.publishNote ?? null);
    return NextResponse.json(result, { status: 201 });
  });
}
