/** POST /api/admin/registrations/:id/resolve-guardian?academyId=X
 * — Admin explicitly selects an existing guardian for the application. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { resolveExistingGuardian } from "@/lib/domain/registration";

const uuidSchema = z.string().min(1);
const resolveSchema = z.object({
  guardianUserId: z.string().min(1),
  reason: z.string().min(1, "Reason is required").max(2000),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: applicationId } = await context.params;
  const idCheck = uuidSchema.safeParse(applicationId);
  if (!idCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid application ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId, requireCsrf: true },
    async (principal) => {
      const body = await parseBody(request, resolveSchema);
      if (body instanceof NextResponse) return body;
      await resolveExistingGuardian(principal, academyId, applicationId, body.guardianUserId, body.reason);
      return NextResponse.json({ ok: true });
    },
  );
}
