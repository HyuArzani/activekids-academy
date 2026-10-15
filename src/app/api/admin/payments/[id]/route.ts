/** GET /api/admin/payments/:id?academyId=X — payment detail. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getPaymentDetails } from "@/lib/domain/payments";

const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: paymentId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(paymentId);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid payment ID" } },
      { status: 422 },
    );
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const payment = await getPaymentDetails(principal, academyId, paymentId);
    return NextResponse.json({ payment });
  });
}
