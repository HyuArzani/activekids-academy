/** POST /api/coach/students/:id/videos?academyId=X — coach creates video. */
/** GET /api/coach/students/:id/videos?academyId=X — coach lists videos. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { createStudentVideo, listStudentVideos } from "@/lib/domain/student-videos";

const uuidSchema = z.string().min(1);
const createSchema = z.object({
  youtubeUrl: z.string().url().max(2000),
  title: z.string().min(1).max(200),
  trainingDate: z.string().date().optional(),
  category: z.string().max(100).optional(),
  notes: z.string().max(2000).nullable().optional(),
  isPublished: z.boolean().optional(),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;
  const idCheck = uuidSchema.safeParse(studentId);
  if (!idCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  // Use role: "coach" — the domain function's authorizeStudentAccess
  // also accepts admin. Admins who are also coaches (or have admin
  // membership) pass the handleApiRequest gate with role "coach" only
  // if they have a coach membership. To allow BOTH admin and coach,
  // we use a custom approach: try admin first, then coach.
  //
  // Actually, handleApiRequest rejects principals who don't have the
  // specified role. So we need a multi-role approach. The simplest
  // solution: accept "coach" role here (coaches pass), and admin
  // access goes through the /api/admin/ route (already exists).
  // This keeps the admin API intact and adds coach access.
  return handleApiRequest(request, { role: "coach", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createStudentVideo(principal, academyId, {
      studentId, youtubeUrl: body.youtubeUrl, title: body.title,
      trainingDate: body.trainingDate, category: body.category,
      notes: body.notes === undefined ? undefined : body.notes ?? undefined,
      isPublished: body.isPublished,
    });
    return NextResponse.json(result, { status: 201 });
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: studentId } = await context.params;
  const idCheck = uuidSchema.safeParse(studentId);
  if (!idCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid student ID" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId }, async (principal) => {
    const videos = await listStudentVideos(principal, academyId, studentId);
    return NextResponse.json({ videos });
  });
}
