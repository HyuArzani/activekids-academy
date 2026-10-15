/** POST /api/admin/classes/:id/generate-occurrences?academyId=X — generate occurrences from the active schedule version. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { generateOccurrences } from "@/lib/domain/scheduling";

const uuidSchema = z.string().uuid();
const generateSchema = z.object({
  weeksAhead: z.number().int().min(1).max(52).default(16),
  fromDate: z.string().date().optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: classId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(classId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid class ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, generateSchema);
    if (body instanceof NextResponse) return body;
    const fromDate = body.fromDate ? new Date(body.fromDate) : new Date();
    const result = await generateOccurrences(principal, academyId, {
      classId,
      fromDate,
      weeksAhead: body.weeksAhead,
    });
    return NextResponse.json(result);
  });
}
