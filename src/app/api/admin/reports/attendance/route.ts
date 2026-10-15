/** GET /api/admin/reports/attendance?academyId=X&studentId=Y — per-student attendance report. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getPerStudentAttendanceReport } from "@/lib/domain/reports";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  const studentId = request.nextUrl.searchParams.get("studentId");
  if (!studentId) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "studentId query parameter is required" } },
      { status: 422 },
    );
  }
  const studentCheck = z.string().uuid().safeParse(studentId);
  if (!studentCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid studentId" } },
      { status: 422 },
    );
  }
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const report = await getPerStudentAttendanceReport(principal, academyId, studentId);
    return NextResponse.json(report);
  });
}
