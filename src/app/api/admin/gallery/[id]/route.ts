/** GET/PATCH /api/admin/gallery/:id?academyId=X — get + update gallery item. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { updateGalleryItem } from "@/lib/domain/cms";

const uuidSchema = z.string().min(1);
const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  mediaKey: z.string().max(500).nullable().optional(),
  mediaType: z.enum(["image", "video"]).optional(),
  displayOrder: z.number().int().min(0).optional(),
  isFeatured: z.boolean().optional(),
  isPublished: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: "At least one field required" });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: itemId } = await context.params;
  const idCheck = uuidSchema.safeParse(itemId);
  if (!idCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid gallery item ID" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, patchSchema);
    if (body instanceof NextResponse) return body;
    await updateGalleryItem(principal, academyId, itemId, body);
    return NextResponse.json({ ok: true });
  });
}
