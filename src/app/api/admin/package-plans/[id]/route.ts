/** PATCH /api/admin/package-plans/:id — update plan. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { updatePackagePlan } from "@/lib/domain/packages";

const uuidSchema = z.string().uuid();
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  sessionCount: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
}).refine((o) => Object.keys(o).length > 0, { message: "At least one field required" });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const uuidCheck = uuidSchema.safeParse(id);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid ID format" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, updateSchema);
    if (body instanceof NextResponse) return body;
    const result = await updatePackagePlan(principal, academyId, id, body);
    return NextResponse.json(result);
  });
}
