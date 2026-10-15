/** GET /api/admin/registrations/:id?academyId=X — application detail. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getRegistrationApplication } from "@/lib/domain/registration";

const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const uuidCheck = uuidSchema.safeParse(id);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid application ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const application = await getRegistrationApplication(principal, academyId, id);
    return NextResponse.json({ application });
  });
}
