/** PATCH /api/admin/videos/:id?academyId=X — update YouTube highlight video. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { updateYoutubeVideo } from "@/lib/domain/cms";

const uuidSchema = z.string().min(1);
const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2000).optional(),
  displayOrder: z.number().int().min(0).optional(),
  isFeatured: z.boolean().optional(),
  isPublished: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: "At least one field required" });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: videoId } = await context.params;
  const idCheck = uuidSchema.safeParse(videoId);
  if (!idCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid video ID" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, patchSchema);
    if (body instanceof NextResponse) return body;
    await updateYoutubeVideo(principal, academyId, videoId, body);
    return NextResponse.json({ ok: true });
  });
}
