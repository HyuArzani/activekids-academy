/** GET /api/admin/classes?academyId=X — list classes in academy.
 *  POST /api/admin/classes?academyId=X — create a new class.
 *  Phase B2.1: extended from B1.1 to support class creation. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { requireAcademyContext, newId } from "@/lib/domain/helpers";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";

interface ClassListItem {
  id: string;
  name: string;
  capacity: number;
  isActive: boolean;
}

const createSchema = z.object({
  name: z.string().min(1, "Class name is required"),
  capacity: z.number().int().positive().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const classes = await listClassesForAcademy(principal, academyId);
    return NextResponse.json({ classes });
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createClass(principal, academyId, body);
    return NextResponse.json(result, { status: 201 });
  });
}

async function listClassesForAcademy(principal: Principal, academyId: string): Promise<ClassListItem[]> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  const result = await db.query<ClassListItem>(
    `SELECT id, name, capacity, is_active AS "isActive"
       FROM classes
      WHERE academy_id = $1
      ORDER BY name;`,
    [academyId],
  );
  return result.rows as ClassListItem[];
}

interface CreateClassInput {
  name: string;
  capacity?: number;
}

async function createClass(principal: Principal, academyId: string, input: CreateClassInput): Promise<ClassListItem> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  const classId = newId();
  const capacity = input.capacity ?? 12; // DB default

  await db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, $3, $4, true);`,
    [classId, academyId, input.name, capacity],
  );

  // Audit the creation.
  await db.withTx(async (tx) => {
    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "class.create", targetType: "classes", targetId: classId,
      after: { name: input.name, capacity, isActive: true },
    });
  });

  return { id: classId, name: input.name, capacity, isActive: true };
}
