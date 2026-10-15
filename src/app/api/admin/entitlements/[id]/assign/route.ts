/** POST /api/admin/entitlements/:id/assign — assign to occurrence. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { assignOccurrence } from "@/lib/domain/entitlements";

const uuidSchema = z.string().uuid();
const assignSchema = z.object({ occurrenceId: z.string().uuid() });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: entitlementId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(entitlementId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid entitlement ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, assignSchema);
    if (body instanceof NextResponse) return body;
    await assignOccurrence(principal, academyId, { entitlementId, occurrenceId: body.occurrenceId });
    return NextResponse.json({ ok: true });
  });
}
