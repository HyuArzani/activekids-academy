/** GET /api/admin/packages/:id — package details + entitlements. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getPackageDetails } from "@/lib/domain/packages";

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
    const details = await getPackageDetails(principal, academyId, packageId);
    return NextResponse.json(details);
  });
}
