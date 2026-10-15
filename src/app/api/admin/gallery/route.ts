/** GET/POST /api/admin/gallery?academyId=X — list + create gallery items. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { createGalleryItem, listGalleryItems } from "@/lib/domain/cms";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  mediaKey: z.string().max(500).nullable().optional(),
  mediaType: z.enum(["image", "video"]).optional(),
  displayOrder: z.number().int().min(0).optional(),
  isFeatured: z.boolean().optional(),
  isPublished: z.boolean().optional(),
}).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const items = await listGalleryItems(principal, academyId);
    return NextResponse.json({ gallery: items });
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createGalleryItem(principal, academyId, body);
    return NextResponse.json(result, { status: 201 });
  });
}
