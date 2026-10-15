/** POST /api/admin/package-plans — create plan. GET — list plans. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { createPackagePlan, listPackagePlans } from "@/lib/domain/packages";

const createSchema = z.object({ name: z.string().min(1), sessionCount: z.number().int().positive() });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createPackagePlan(principal, academyId, body);
    return NextResponse.json(result, { status: 201 });
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const plans = await listPackagePlans(principal, academyId);
    return NextResponse.json({ plans });
  });
}
