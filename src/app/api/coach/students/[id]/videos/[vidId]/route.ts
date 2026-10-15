/** PATCH /api/coach/students/:id/videos/:vidId?academyId=X — coach updates video. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { updateStudentVideo } from "@/lib/domain/student-videos";

const uuidSchema = z.string().min(1);
const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  youtubeUrl: z.string().url().max(2000).optional(),
  trainingDate: z.string().date().nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  isPublished: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: "At least one field required" });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; vidId: string }> },
): Promise<NextResponse> {
  const { id: studentId, vidId } = await context.params;
  const idCheck = uuidSchema.safeParse(studentId);
  const vidCheck = uuidSchema.safeParse(vidId);
  if (!idCheck.success || !vidCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid ID" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, patchSchema);
    if (body instanceof NextResponse) return body;
    await updateStudentVideo(principal, academyId, vidId, {
      title: body.title,
      youtubeUrl: body.youtubeUrl,
      trainingDate: body.trainingDate === undefined ? undefined : body.trainingDate,
      category: body.category === undefined ? undefined : body.category,
      notes: body.notes === undefined ? undefined : body.notes,
      isPublished: body.isPublished,
    });
    return NextResponse.json({ ok: true });
  });
}
