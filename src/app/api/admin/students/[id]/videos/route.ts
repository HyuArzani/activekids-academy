/** POST /api/admin/students/:id/videos?academyId=X — create student training video. */
/** GET /api/admin/students/:id/videos?academyId=X — list student training videos. */
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
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
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
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const videos = await listStudentVideos(principal, academyId, studentId);
    return NextResponse.json({ videos });
  });
}
