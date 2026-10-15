/** GET /api/admin/classes/:id?academyId=X — get single class detail.
 *  PUT /api/admin/classes/:id?academyId=X — update class name/capacity/active.
 *  Phase B2.1: minimum CRUD for class management. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { requireAcademyContext } from "@/lib/domain/helpers";
import { newId } from "@/lib/domain/helpers";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";

const uuidSchema = z.string().uuid();

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  capacity: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
}).refine((obj) => Object.keys(obj).length > 0, { message: "At least one field must be provided" });

interface ClassDetail {
  id: string;
  name: string;
  capacity: number;
  isActive: boolean;
  createdAt: string;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: classId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(classId);
  if (!uuidCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid class ID format" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const cls = await loadClassDetail(principal, academyId, classId);
    return NextResponse.json(cls);
  });
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: classId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(classId);
  if (!uuidCheck.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid class ID format" } }, { status: 422 });
  }
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, updateSchema);
    if (body instanceof NextResponse) return body;
    const result = await updateClass(principal, academyId, classId, body);
    return NextResponse.json(result);
  });
}

async function loadClassDetail(principal: Principal, academyId: string, classId: string): Promise<ClassDetail> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  const result = await db.query<ClassDetail>(
    `SELECT id, name, capacity, is_active AS "isActive",
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
       FROM classes
      WHERE id = $1 AND academy_id = $2;`,
    [classId, academyId],
  );
  if (!result.rows[0]) {
    const { Err } = await import("@/lib/errors");
    throw Err.notFound("Class not found in this academy.");
  }
  return result.rows[0] as ClassDetail;
}

interface UpdateClassInput {
  name?: string;
  capacity?: number;
  isActive?: boolean;
}

async function updateClass(principal: Principal, academyId: string, classId: string, input: UpdateClassInput): Promise<ClassDetail> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  return db.withTx(async (tx) => {
    // Load current state for audit.
    const current = await tx.query<{ name: string; capacity: number; is_active: boolean }>(
      `SELECT name, capacity, is_active FROM classes WHERE id = $1 AND academy_id = $2;`,
      [classId, academyId],
    );
    if (!current.rows[0]) {
      const { Err } = await import("@/lib/errors");
      throw Err.notFound("Class not found in this academy.");
    }
    const before = {
      name: (current.rows[0] as { name: string }).name,
      capacity: (current.rows[0] as { capacity: number }).capacity,
      isActive: (current.rows[0] as { is_active: boolean }).is_active,
    };

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) { params.push(input.name); sets.push(`name = $${params.length}`); }
    if (input.capacity !== undefined) { params.push(input.capacity); sets.push(`capacity = $${params.length}`); }
    if (input.isActive !== undefined) { params.push(input.isActive); sets.push(`is_active = $${params.length}`); }
    params.push(classId, academyId);
    await tx.query(
      `UPDATE classes SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length - 1} AND academy_id = $${params.length};`,
      params,
    );

    // Re-read updated row.
    const updated = await tx.query<ClassDetail>(
      `SELECT id, name, capacity, is_active AS "isActive",
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
         FROM classes WHERE id = $1 AND academy_id = $2;`,
      [classId, academyId],
    );
    const result = updated.rows[0] as ClassDetail;

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "class.update", targetType: "classes", targetId: classId,
      before, after: { name: result.name, capacity: result.capacity, isActive: result.isActive },
    });

    return result;
  });
}
