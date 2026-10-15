/**
 * GET /api/admin/occurrences?academyId=X&fromDate=Y&toDate=Z
 *   — academy-wide occurrence listing, joins class name + slot time.
 *
 * Used by the Attendance UI to show "today's sessions" across all classes
 * in the academy without N round-trips (one per class).
 *
 * Returns up to 200 rows, ordered by occurrence_date, start_at.
 *
 * Optional query params:
 *   - fromDate (YYYY-MM-DD, inclusive)
 *   - toDate   (YYYY-MM-DD, inclusive)
 *   - classId  (filter to a single class within the academy)
 *   - status   (planned | completed | cancelled)
 *
 * Auth: admin role in the academy. (Coaches currently use coach-specific
 * endpoints; extending this to coaches is a future enhancement.)
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { requireAcademyContext } from "@/lib/domain/helpers";
import type { Principal } from "@/lib/auth/principal";

const dateSchema = z.string().date();
const uuidSchema = z.string().uuid();
const statusSchema = z.enum(["planned", "completed", "cancelled"]);

interface OccurrenceListRow {
  id: string;
  classId: string;
  className: string;
  occurrenceDate: string;
  startAt: string;
  endAt: string;
  status: string;
  capacity: number;
  cancelledReason: string | null;
  /** Count of attendance records (any status) for this occurrence. */
  recordedCount: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  const fromDateRaw = request.nextUrl.searchParams.get("fromDate");
  const toDateRaw = request.nextUrl.searchParams.get("toDate");
  const classId = request.nextUrl.searchParams.get("classId");
  const status = request.nextUrl.searchParams.get("status");

  // Validate optional filters before the auth check so 422 is returned
  // for malformed query strings (consistent with other endpoints).
  if (fromDateRaw) {
    const r = dateSchema.safeParse(fromDateRaw);
    if (!r.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "Invalid fromDate (use YYYY-MM-DD)" } },
        { status: 422 },
      );
    }
  }
  if (toDateRaw) {
    const r = dateSchema.safeParse(toDateRaw);
    if (!r.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "Invalid toDate (use YYYY-MM-DD)" } },
        { status: 422 },
      );
    }
  }
  if (fromDateRaw && toDateRaw && fromDateRaw > toDateRaw) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "fromDate must be on or before toDate" } },
      { status: 422 },
    );
  }
  if (classId) {
    const r = uuidSchema.safeParse(classId);
    if (!r.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "Invalid classId" } },
        { status: 422 },
      );
    }
  }
  if (status) {
    const r = statusSchema.safeParse(status);
    if (!r.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_FAILED", message: "Invalid status (planned | completed | cancelled)" } },
        { status: 422 },
      );
    }
  }

  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const rows = await listOccurrences(principal, academyId, {
      fromDate: fromDateRaw,
      toDate: toDateRaw,
      classId,
      status,
    });
    return NextResponse.json({ occurrences: rows });
  });
}

async function listOccurrences(
  principal: Principal,
  academyId: string,
  filters: {
    fromDate: string | null;
    toDate: string | null;
    classId: string | null;
    status: string | null;
  },
): Promise<OccurrenceListRow[]> {
  requireAcademyContext(principal, academyId);
  void principal; // principal already validated by handleApiRequest + requireAcademyContext
  const db = getDb();

  const params: unknown[] = [academyId];
  const where: string[] = ["tocc.academy_id = $1"];
  if (filters.fromDate) {
    params.push(filters.fromDate);
    where.push(`tocc.occurrence_date >= $${params.length}`);
  }
  if (filters.toDate) {
    params.push(filters.toDate);
    where.push(`tocc.occurrence_date <= $${params.length}`);
  }
  if (filters.classId) {
    params.push(filters.classId);
    where.push(`tocc.class_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`tocc.status = $${params.length}`);
  }

  // LEFT JOIN LATERAL to count attendance rows per occurrence in a single
  // query (avoids N+1). COUNT(ar.id) is 0 when no attendance rows exist.
  const result = await db.query<OccurrenceListRow>(
    `SELECT tocc.id,
            tocc.class_id AS "classId",
            c.name AS "className",
            to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS "occurrenceDate",
            to_char(tocc.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startAt",
            to_char(tocc.end_at   AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "endAt",
            tocc.status,
            tocc.capacity,
            tocc.cancelled_reason AS "cancelledReason",
            COALESCE(att.cnt, 0) AS "recordedCount"
       FROM training_occurrences tocc
       JOIN classes c ON c.id = tocc.class_id
  LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt
           FROM attendance_records ar
          WHERE ar.training_occurrence_id = tocc.id
       ) att ON true
      WHERE ${where.join(" AND ")}
      ORDER BY tocc.occurrence_date, tocc.start_at
      LIMIT 200;`,
    params,
  );
  return result.rows as OccurrenceListRow[];
}
