/** POST /api/admin/payments?academyId=X — record manual payment + atomic package purchase. */
/** GET /api/admin/payments?academyId=X&studentId=Y — list payments for a student. */
/** GET /api/admin/payments?academyId=X&fromDate=Y&toDate=Z — academy-wide payments in a date range. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { recordPayment, listPaymentsForStudent } from "@/lib/domain/payments";
import { requireAcademyContext } from "@/lib/domain/helpers";
import { getDb } from "@/lib/db";
import type { Principal } from "@/lib/auth/principal";

const recordSchema = z.object({
  studentId: z.string().uuid(),
  packagePlanId: z.string().uuid(),
  amount: z.number().positive({ message: "Amount must be greater than zero" }),
  paymentMethod: z.enum(["cash", "bank_transfer"]),
  paymentDate: z.string().date(),
  payerGuardianUserId: z.string().uuid().optional(),
  payerName: z.string().min(1).max(200).optional(),
  referenceNumber: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(100),
}).refine(
  (v) => (v.payerGuardianUserId ? true : (v.payerName && v.payerName.trim() !== "")) && !(v.payerGuardianUserId && v.payerName && v.payerName.trim() !== ""),
  { message: "Provide either payerGuardianUserId or payerName (not both, not neither)" },
);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, recordSchema);
    if (body instanceof NextResponse) return body;
    const result = await recordPayment(principal, academyId, {
      studentId: body.studentId,
      packagePlanId: body.packagePlanId,
      amount: body.amount,
      paymentMethod: body.paymentMethod,
      paymentDate: body.paymentDate,
      payerGuardianUserId: body.payerGuardianUserId,
      payerName: body.payerName,
      referenceNumber: body.referenceNumber,
      notes: body.notes,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  const studentId = request.nextUrl.searchParams.get("studentId");
  const fromDate = request.nextUrl.searchParams.get("fromDate");
  const toDate = request.nextUrl.searchParams.get("toDate");

  // Two modes:
  //   1. studentId → list payments for a single student (existing behavior).
  //   2. fromDate + toDate → academy-wide listing across all students.
  // If both are provided, studentId takes precedence (back-compat with the
  // existing UI/tests that always pass studentId).

  if (studentId) {
    const studentCheck = z.string().uuid().safeParse(studentId);
    if (!studentCheck.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "Invalid studentId" } },
        { status: 422 },
      );
    }
    return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
      const payments = await listPaymentsForStudent(principal, academyId, studentId);
      return NextResponse.json({ payments });
    });
  }

  // Academy-wide mode: fromDate + toDate required.
  if (!fromDate || !toDate) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Provide studentId, or both fromDate and toDate (YYYY-MM-DD)",
        },
      },
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
  if (fromDate > toDate) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "fromDate must be on or before toDate" } },
      { status: 422 },
    );
  }

  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const payments = await listPaymentsForDateRangeAcademy(principal, academyId, fromDate, toDate);
    return NextResponse.json({ payments });
  });
}

/** Academy-wide payment listing for the Payments UI. Returns payments
 *  in a date range with student + plan details. Admin-role only.
 *
 *  This is a thin wrapper that reads directly via the db client — there
 *  is no separate domain function for it because the query mirrors
 *  `listPaymentsForStudent` (just without the `student_id = $` filter).
 */
interface AcademyPaymentListItem {
  id: string;
  studentId: string;
  studentName: string;
  payerName: string | null;
  paymentMethod: string;
  amount: string;
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  status: string;
  packageId: string | null;
  packageName: string | null;
  sessionCount: number | null;
  recordedAt: string;
}

async function listPaymentsForDateRangeAcademy(
  principal: Principal,
  academyId: string,
  fromDate: string,
  toDate: string,
): Promise<AcademyPaymentListItem[]> {
  requireAcademyContext(principal, academyId);
  void principal; // already validated by handleApiRequest + requireAcademyContext
  const db = getDb();
  const result = await db.query<AcademyPaymentListItem>(
    `SELECT p.id, p.student_id AS "studentId", s.full_name AS "studentName",
            p.payer_name AS "payerName", p.payment_method AS "paymentMethod",
            p.submitted_amount::text AS "amount",
            to_char(p.payment_date, 'YYYY-MM-DD') AS "paymentDate",
            p.reference_number AS "referenceNumber", p.notes, p.status,
            pa.student_package_id AS "packageId",
            pp.name AS "packageName", pp.session_count AS "sessionCount",
            to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "recordedAt"
       FROM payments p
       JOIN students s ON s.id = p.student_id
  LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
  LEFT JOIN student_packages sp ON sp.id = pa.student_package_id
  LEFT JOIN package_plans pp ON pp.id = sp.package_plan_id
      WHERE p.academy_id = $1
        AND p.payment_date >= $2
        AND p.payment_date <= $3
      ORDER BY p.payment_date DESC, p.created_at DESC
      LIMIT 200;`,
    [academyId, fromDate, toDate],
  );
  return result.rows as AcademyPaymentListItem[];
}
