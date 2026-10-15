/** GET /api/admin/payments/:id/message?academyId=X — WhatsApp-ready Indonesian message. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { generatePaymentConfirmationMessage } from "@/lib/domain/payments";
import { getDb } from "@/lib/db";

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
  return handleApiRequest(request, { role: "admin", academyId }, async () => {
    const message = await generatePaymentConfirmationMessage(getDb(), academyId, paymentId);
    return NextResponse.json({ message });
  });
}
