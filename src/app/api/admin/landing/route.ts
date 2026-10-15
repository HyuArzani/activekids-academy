/** GET /api/admin/landing?academyId=X — get or create draft landing page. */
/** PATCH /api/admin/landing?academyId=X — update draft content. */
import { type NextRequest, NextResponse } from "next/server";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getOrCreateLandingPage, updateLandingPageDraft, landingContentSchema } from "@/lib/domain/cms";

const contentSchema = landingContentSchema;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const page = await getOrCreateLandingPage(principal, academyId);
    return NextResponse.json({ landingPage: page });
  });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, contentSchema);
    if (body instanceof NextResponse) return body;
    await updateLandingPageDraft(principal, academyId, body);
    return NextResponse.json({ ok: true });
  });
}
