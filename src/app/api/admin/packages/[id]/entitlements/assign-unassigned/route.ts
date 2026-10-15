/** POST /api/admin/packages/:id/entitlements/assign-unassigned — bulk-assign. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { assignUnassignedEntitlements } from "@/lib/domain/entitlements";

const uuidSchema = z.string().uuid();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: packageId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(packageId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid package ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const result = await assignUnassignedEntitlements(principal, academyId, packageId);
    return NextResponse.json(result);
  });
}
