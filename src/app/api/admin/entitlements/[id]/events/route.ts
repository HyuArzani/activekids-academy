/** GET /api/admin/entitlements/:id/events — event/audit history. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { listEntitlementEvents } from "@/lib/domain/entitlements";

const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: entitlementId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(entitlementId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid entitlement ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const events = await listEntitlementEvents(principal, academyId, entitlementId);
    return NextResponse.json({ events });
  });
}
