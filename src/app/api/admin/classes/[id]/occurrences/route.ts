/** GET /api/admin/classes/:id/occurrences?academyId=X&fromDate=Y&toDate=Z — list occurrences for a class. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { requireAcademyContext } from "@/lib/domain/helpers";
import { getDb } from "@/lib/db";
import type { Principal } from "@/lib/auth/principal";

const uuidSchema = z.string().uuid();

interface OccurrenceRow {
  id: string;
  occurrenceDate: string;
  startAt: string;
  endAt: string;
  status: string;
  capacity: number;
  className: string;
  cancelledReason: string | null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: classId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(classId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid class ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  const fromDate = request.nextUrl.searchParams.get("fromDate");
  const toDate = request.nextUrl.searchParams.get("toDate");
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const occurrences = await listOccurrences(principal, academyId, classId, fromDate, toDate);
    return NextResponse.json({ occurrences });
  });
}

async function listOccurrences(principal: Principal, academyId: string, classId: string, fromDate: string | null, toDate: string | null): Promise<OccurrenceRow[]> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  const classCheck = await db.query<{ id: string }>(`SELECT id FROM classes WHERE id = $1 AND academy_id = $2;`, [classId, academyId]);
  if (!classCheck.rows[0]) {
    const { Err } = await import("@/lib/errors");
    throw Err.notFound("Class not found in this academy.");
  }
  const params: unknown[] = [classId, academyId];
  let dateFilter = "";
  if (fromDate) { params.push(fromDate); dateFilter += ` AND tocc.occurrence_date >= $${params.length}`; }
  if (toDate) { params.push(toDate); dateFilter += ` AND tocc.occurrence_date <= $${params.length}`; }
  const result = await db.query<OccurrenceRow>(
    `SELECT tocc.id,
            to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS "occurrenceDate",
            to_char(tocc.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startAt",
            to_char(tocc.end_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "endAt",
            tocc.status, tocc.capacity,
            c.name AS "className",
            tocc.cancelled_reason AS "cancelledReason"
       FROM training_occurrences tocc
       JOIN classes c ON c.id = tocc.class_id
      WHERE tocc.class_id = $1 AND tocc.academy_id = $2${dateFilter}
      ORDER BY tocc.occurrence_date, tocc.start_at
      LIMIT 200;`,
    params,
  );
  return result.rows as OccurrenceRow[];
}
