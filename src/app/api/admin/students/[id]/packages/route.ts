/** POST /api/admin/students/:id/packages — purchase. GET — list history. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { purchasePackage, listStudentPackages } from "@/lib/domain/packages";

const uuidSchema = z.string().uuid();
const purchaseSchema = z.object({ packagePlanId: z.string().uuid() });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(studentId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, purchaseSchema);
    if (body instanceof NextResponse) return body;
    const result = await purchasePackage(principal, academyId, { studentId, packagePlanId: body.packagePlanId });
    return NextResponse.json(result, { status: 201 });
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(studentId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const packages = await listStudentPackages(principal, academyId, studentId);
    return NextResponse.json({ packages });
  });
}
