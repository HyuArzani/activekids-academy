/** POST /api/parent/children/:studentId/entitlements/:entitlementId/makeup
 *  Stage 9: Parent makeup assignment (idempotent). */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { parentAssignMakeup } from "@/lib/domain/entitlements";

const uuidSchema = z.string().uuid();
const makeupSchema = z.object({
  destinationOccurrenceId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ studentId: string; entitlementId: string }> },
): Promise<NextResponse> {
  const { entitlementId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(entitlementId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid entitlement ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!idempotencyKey.trim()) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Idempotency-Key header is required" } },
      { status: 422 },
    );
  }
  return handleApiRequest(
    request,
    { role: "parent", academyId, requireCsrf: true },
    async (principal) => {
      const body = await parseBody(request, makeupSchema);
      if (body instanceof NextResponse) return body;
      const result = await parentAssignMakeup(principal, academyId, {
        entitlementId,
        destinationOccurrenceId: body.destinationOccurrenceId,
        idempotencyKey: idempotencyKey.trim(),
        reason: body.reason,
      });
      return NextResponse.json(result, { status: 200 });
    },
  );
}
