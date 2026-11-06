/** GET /api/coach/occurrences/:id/plan?academyId=X — coach reads a plan. */
/** PUT /api/coach/occurrences/:id/plan?academyId=X — coach upserts a plan. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery, parseBody } from "@/lib/api/handler";
import { getCoachPlan, upsertCoachPlan } from "@/lib/domain/training-plans";

const uuidSchema = z.string().uuid();
const upsertSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
  visibleToParents: z.boolean().optional(),
}).strict();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid occurrence ID" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId }, async (principal) =>
    NextResponse.json({ plan: await getCoachPlan(principal, academyId, id) }),
  );
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid occurrence ID" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "coach", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, upsertSchema);
    if (body instanceof NextResponse) return body;
    const plan = await upsertCoachPlan(principal, academyId, id, {
      title: body.title,
      content: body.content,
      visibleToParents: body.visibleToParents,
    });
    return NextResponse.json({ plan });
  });
}
