/** GET/POST /api/admin/videos?academyId=X — list + create YouTube videos. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { createYoutubeVideo, listYoutubeVideos } from "@/lib/domain/cms";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  url: z.string().min(1).max(2000).url(),
  displayOrder: z.number().int().min(0).optional(),
  isFeatured: z.boolean().optional(),
  isPublished: z.boolean().optional(),
}).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const videos = await listYoutubeVideos(principal, academyId);
    return NextResponse.json({ videos });
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createYoutubeVideo(principal, academyId, body);
    return NextResponse.json(result, { status: 201 });
  });
}
