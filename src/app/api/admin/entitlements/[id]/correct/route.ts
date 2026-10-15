/** POST /api/admin/entitlements/:id/correct — admin reassign. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { adminCorrect } from "@/lib/domain/entitlements";

const uuidSchema = z.string().uuid();
const correctSchema = z.object({
  newAssignedOccurrenceId: z.string().uuid().nullable(),
  reason: z.string().min(1, "Reason is required"),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: entitlementId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(entitlementId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid entitlement ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, correctSchema);
    if (body instanceof NextResponse) return body;
    await adminCorrect(principal, academyId, { entitlementId, newAssignedOccurrenceId: body.newAssignedOccurrenceId, reason: body.reason });
    return NextResponse.json({ ok: true });
  });
}
