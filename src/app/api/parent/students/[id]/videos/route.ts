/** GET /api/parent/students/:id/videos?academyId=X — parent lists child's videos (read-only). */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { listStudentVideos } from "@/lib/domain/student-videos";

const idSchema = z.string().min(1).refine(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), "Invalid ID format");

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;
  const idCheck = idSchema.safeParse(studentId);
  if (!idCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  // Parent role — the domain function's authorizeStudentAccess checks
  // guardian_student_links. Only linked parents can access.
  return handleApiRequest(request, { role: "parent", academyId }, async (principal) => {
    const videos = await listStudentVideos(principal, academyId, studentId);
    return NextResponse.json({ videos });
  });
}
