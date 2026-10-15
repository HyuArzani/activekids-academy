/** GET /api/admin/packages/:id/entitlements — list entitlements for a package. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { listEntitlementsForPackage } from "@/lib/domain/packages";

const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: packageId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(packageId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid package ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const entitlements = await listEntitlementsForPackage(principal, academyId, packageId);
    return NextResponse.json({ entitlements });
  });
}
