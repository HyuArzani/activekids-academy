/** GET /api/admin/registrations?academyId=X&status=pending — list applications. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { listRegistrationApplications } from "@/lib/domain/registration";

const statusSchema = z.enum(["pending", "approved", "rejected", "all"]).default("pending");

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  const statusParam = request.nextUrl.searchParams.get("status") ?? "pending";
  const statusCheck = statusSchema.safeParse(statusParam);
  if (!statusCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid status filter" } },
      { status: 422 },
    );
  }
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const applications = await listRegistrationApplications(principal, academyId, statusCheck.data);
    return NextResponse.json({ applications });
  });
}
