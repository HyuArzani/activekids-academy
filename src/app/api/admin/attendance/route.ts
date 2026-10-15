/**
 * GET /api/admin/attendance?academyId=X&studentId=Y — attendance history for a student.
 * GET /api/admin/attendance?academyId=X&fromDate=Y&toDate=Z — attendance in a date range.
 *
 * If both studentId and fromDate/toDate are provided, studentId takes precedence.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { listAttendanceForStudent, listAttendanceForDateRange } from "@/lib/domain/attendance";

const dateSchema = z.string().date();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  const studentId = request.nextUrl.searchParams.get("studentId");
  const fromDateStr = request.nextUrl.searchParams.get("fromDate");
  const toDateStr = request.nextUrl.searchParams.get("toDate");

  // Validate query parameters.
  if (studentId) {
    const studentCheck = z.string().uuid().safeParse(studentId);
    if (!studentCheck.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "Invalid studentId" } },
        { status: 422 },
      );
    }
  } else if (fromDateStr && toDateStr) {
    const fromCheck = dateSchema.safeParse(fromDateStr);
    const toCheck = dateSchema.safeParse(toDateStr);
    if (!fromCheck.success || !toCheck.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "Invalid date format (use YYYY-MM-DD)" } },
        { status: 422 },
      );
    }
  } else {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Provide studentId, or both fromDate and toDate (YYYY-MM-DD)",
        },
      },
      { status: 422 },
    );
  }

  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    if (studentId) {
      const records = await listAttendanceForStudent(principal, academyId, studentId);
      return NextResponse.json({ attendance: records });
    }
    // Date range query (fromDateStr and toDateStr are validated above).
    const records = await listAttendanceForDateRange(
      principal,
      academyId,
      new Date(fromDateStr!),
      new Date(toDateStr!),
    );
    return NextResponse.json({ attendance: records });
  });
}
