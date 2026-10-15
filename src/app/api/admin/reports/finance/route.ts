/** GET /api/admin/reports/finance?academyId=X&fromDate=Y&toDate=Z — monthly financial report. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getMonthlyFinanceReport } from "@/lib/domain/reports";

const dateSchema = z.string().date();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  const fromDate = request.nextUrl.searchParams.get("fromDate");
  const toDate = request.nextUrl.searchParams.get("toDate");
  if (!fromDate || !toDate) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "fromDate and toDate query parameters are required (YYYY-MM-DD)" } },
      { status: 422 },
    );
  }
  const fromCheck = dateSchema.safeParse(fromDate);
  const toCheck = dateSchema.safeParse(toDate);
  if (!fromCheck.success || !toCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid date format (use YYYY-MM-DD)" } },
      { status: 422 },
    );
  }
  if (fromDate > toDate) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "fromDate must be on or before toDate" } },
      { status: 422 },
    );
  }
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const report = await getMonthlyFinanceReport(principal, academyId, fromDate, toDate);
    return NextResponse.json(report);
  });
}
