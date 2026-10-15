/** GET /api/admin/schedule-versions/:id/slots?academyId=X — list slots.
 *  POST /api/admin/schedule-versions/:id/slots?academyId=X — create a slot. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { requireAcademyContext, newId } from "@/lib/domain/helpers";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";

const uuidSchema = z.string().uuid();
const createSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Start time must be HH:MM"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "End time must be HH:MM"),
  capacityOverride: z.number().int().positive().optional(),
}).refine((d) => d.startTime < d.endTime, { message: "End time must be after start time" });

interface SlotRow {
  id: string;
  scheduleVersionId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  capacityOverride: number | null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(versionId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid version ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const slots = await listSlots(principal, academyId, versionId);
    return NextResponse.json({ slots });
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(versionId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid version ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createSlot(principal, academyId, versionId, body);
    return NextResponse.json(result, { status: 201 });
  });
}

async function listSlots(principal: Principal, academyId: string, versionId: string): Promise<SlotRow[]> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  // Verify version belongs to a class in this academy.
  const versionCheck = await db.query<{ id: string }>(
    `SELECT sv.id FROM schedule_versions sv JOIN classes c ON c.id = sv.class_id
      WHERE sv.id = $1 AND c.academy_id = $2;`,
    [versionId, academyId],
  );
  if (!versionCheck.rows[0]) {
    const { Err } = await import("@/lib/errors");
    throw Err.notFound("Schedule version not found in this academy.");
  }
  const result = await db.query<SlotRow>(
    `SELECT id, schedule_version_id AS "scheduleVersionId", weekday,
            to_char(start_time, 'HH24:MI') AS "startTime",
            to_char(end_time, 'HH24:MI') AS "endTime",
            capacity_override AS "capacityOverride"
       FROM schedule_slots
      WHERE schedule_version_id = $1
      ORDER BY weekday, start_time;`,
    [versionId],
  );
  return result.rows as SlotRow[];
}

async function createSlot(principal: Principal, academyId: string, versionId: string, input: z.infer<typeof createSchema>): Promise<SlotRow> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  return db.withTx(async (tx) => {
    const versionCheck = await tx.query<{ id: string; status: string }>(
      `SELECT sv.id, sv.status FROM schedule_versions sv JOIN classes c ON c.id = sv.class_id
        WHERE sv.id = $1 AND c.academy_id = $2;`,
      [versionId, academyId],
    );
    if (!versionCheck.rows[0]) {
      const { Err } = await import("@/lib/errors");
      throw Err.notFound("Schedule version not found in this academy.");
    }
    const versionStatus = (versionCheck.rows[0] as { status: string }).status;
    if (versionStatus === "superseded") {
      const { Err } = await import("@/lib/errors");
      throw Err.conflict("Cannot add slots to a superseded schedule version.");
    }

    const slotId = newId();
    await tx.query(
      `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time, capacity_override)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [slotId, versionId, input.weekday, input.startTime, input.endTime, input.capacityOverride ?? null],
    );

    const result = await tx.query<SlotRow>(
      `SELECT id, schedule_version_id AS "scheduleVersionId", weekday,
              to_char(start_time, 'HH24:MI') AS "startTime",
              to_char(end_time, 'HH24:MI') AS "endTime",
              capacity_override AS "capacityOverride"
         FROM schedule_slots WHERE id = $1;`,
      [slotId],
    );

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "schedule_slot.create", targetType: "schedule_slots", targetId: slotId,
      after: { versionId, weekday: input.weekday, startTime: input.startTime, endTime: input.endTime, capacityOverride: input.capacityOverride ?? null },
    });

    return (result.rows[0] as SlotRow);
  });
}
