/** POST /api/admin/expenses?academyId=X — record expense. */
/** GET /api/admin/expenses?academyId=X&fromDate=Y&toDate=Z — list by date range. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { recordExpense, listExpenses } from "@/lib/domain/expenses";

const recordSchema = z.object({
  amount: z.number().nonnegative({ message: "Amount must be non-negative" }),
  category: z.string().min(1, "Category is required").max(100),
  incurredOn: z.string().date(),
  note: z.string().max(2000).optional(),
  relatedPaymentId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, recordSchema);
    if (body instanceof NextResponse) return body;
    const result = await recordExpense(principal, academyId, {
      amount: body.amount,
      category: body.category,
      incurredOn: body.incurredOn,
      note: body.note,
      relatedPaymentId: body.relatedPaymentId,
    });
    return NextResponse.json(result, { status: 201 });
  });
}

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
  const fromCheck = z.string().date().safeParse(fromDate);
  const toCheck = z.string().date().safeParse(toDate);
  if (!fromCheck.success || !toCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid date format (use YYYY-MM-DD)" } },
      { status: 422 },
    );
  }
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const expenses = await listExpenses(principal, academyId, fromDate, toDate);
    return NextResponse.json({ expenses });
  });
}
