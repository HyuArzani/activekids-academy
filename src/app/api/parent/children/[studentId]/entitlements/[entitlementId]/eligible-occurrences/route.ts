/** GET /api/parent/children/:studentId/entitlements/:entitlementId/eligible-occurrences?academyId=X
 *  Stage 10 Phase 1: parent-scoped eligible occurrences for move/makeup.
 *
 *  Returns provisional eligible future occurrences (same class, planned,
 *  active schedule version, not past). Capacity is provisional — the mutation
 *  endpoint revalidates transactionally.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getEligibleOccurrences } from "@/lib/domain/parent-portal";

const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ studentId: string; entitlementId: string }> },
): Promise<NextResponse> {
  const { studentId, entitlementId } = await context.params;
  const studentCheck = uuidSchema.safeParse(studentId);
  const entitlementCheck = uuidSchema.safeParse(entitlementId);
  if (!studentCheck.success || !entitlementCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid ID format" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "parent", academyId },
    async (principal) => {
      const occurrences = await getEligibleOccurrences(
        principal,
        academyId,
        studentId,
        entitlementId,
      );
      return NextResponse.json({ occurrences });
    },
  );
}
