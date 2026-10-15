/** POST /api/parent/children/:studentId/entitlements/:entitlementId/move
 *  Stage 9: Parent normal move (idempotent). */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { moveEntitlement } from "@/lib/domain/entitlements";

const uuidSchema = z.string().uuid();
const moveSchema = z.object({
  destinationOccurrenceId: z.string().uuid(),
  expectedCurrentOccurrenceId: z.string().uuid(),
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
      const body = await parseBody(request, moveSchema);
      if (body instanceof NextResponse) return body;
      const result = await moveEntitlement(principal, academyId, {
        entitlementId,
        destinationOccurrenceId: body.destinationOccurrenceId,
        expectedCurrentOccurrenceId: body.expectedCurrentOccurrenceId,
        idempotencyKey: idempotencyKey.trim(),
        reason: body.reason,
      });
      return NextResponse.json(result, { status: 200 });
    },
  );
}
