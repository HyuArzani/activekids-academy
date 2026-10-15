/** GET /api/admin/expenses/:id?academyId=X — expense detail. */
/** PATCH /api/admin/expenses/:id?academyId=X — update note only. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getExpense, updateExpenseNote } from "@/lib/domain/expenses";

const uuidSchema = z.string().uuid();
const patchSchema = z.object({
  note: z.string().max(2000).nullable(),
}).strict(); // reject amount/category/incurredOn — immutable post-create

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: expenseId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(expenseId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid expense ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const expense = await getExpense(principal, academyId, expenseId);
    return NextResponse.json({ expense });
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: expenseId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(expenseId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid expense ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, patchSchema);
    if (body instanceof NextResponse) return body;
    await updateExpenseNote(principal, academyId, expenseId, body.note);
    return NextResponse.json({ ok: true });
  });
}
