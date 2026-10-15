/** POST /api/admin/registrations/:id/approve?academyId=X — approve application. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { approveRegistration } from "@/lib/domain/registration";

const uuidSchema = z.string().uuid();

export async function POST(
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
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const result = await approveRegistration(principal, academyId, id);
    return NextResponse.json(result);
  });
}
