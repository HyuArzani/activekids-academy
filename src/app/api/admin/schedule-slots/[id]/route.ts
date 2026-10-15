/** DELETE /api/admin/schedule-slots/:id?academyId=X — delete a slot.
 *  Fails safely with 409 CONFLICT if occurrences reference it (FK ON DELETE
 *  RESTRICT). Returns 404 if the slot does not exist in this academy. */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, getAcademyIdFromQuery } from "@/lib/api/handler";
import { requireAcademyContext } from "@/lib/domain/helpers";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit/writer";
import { Err, toSafeResponse } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";

const uuidSchema = z.string().uuid();

interface SlotDetailRow {
  id: string;
  scheduleVersionId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  capacityOverride: number | null;
  versionStatus: string;
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: slotId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(slotId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid slot ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    try {
      await deleteSlot(principal, academyId, slotId);
      return NextResponse.json({ ok: true });
    } catch (err) {
      // Map FK RESTRICT violations to a clear 409 instead of an opaque
      // 500 UPSTREAM_ERROR. The client gets an actionable message:
      // "Cannot delete slot: training occurrences reference it." The
      // admin must retire the slot via the versioning workflow (supersede
      // the version; slots from superseded versions cannot be modified,
      // but they can be effectively retired by creating a new version
      // without them and regenerating occurrences).
      if (isPgForeignKeyViolation(err)) {
        return NextResponse.json(
          { error: { code: "CONFLICT", message: "Cannot delete slot: training occurrences reference it. Retire the slot by superseding its schedule version and creating a new version without it.", detail: "slot_in_use" } },
          { status: 409 },
        );
      }
      const safe = toSafeResponse(err);
      return NextResponse.json(safe.body, { status: safe.status });
    }
  });
}

/**
 * Detect a foreign-key RESTRICT/CASCADE violation that prevents slot
 * deletion. Returns true for:
 *   - PostgreSQL SQLSTATE 23503 (foreign_key_violation).
 *   - PgLite SQLSTATE 23001 (its RESTRICT-specific code; PgLite deviates
 *     from the PostgreSQL standard here).
 *   - The PgLite/PostgreSQL message patterns "violates foreign key
 *     constraint", "violates RESTRICT setting of foreign key constraint",
 *     or "is referenced from table" (the detail string).
 *
 * Accepts either the raw driver error or an AppError-wrapped
 * `UPSTREAM_ERROR` (whose `serverCause` is the raw driver error).
 */
function isPgForeignKeyViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  // SQLSTATE codes:
  //   '23503' — PostgreSQL standard foreign_key_violation.
  //   '23001' — PgLite RESTRICT violation (deviates from PG standard).
  if (typeof code === "string" && (code === "23503" || code === "23001")) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    const lower = message.toLowerCase();
    if (lower.includes("violates foreign key constraint")) return true;
    if (lower.includes("violates restrict setting of foreign key")) return true;
    if (lower.includes("is referenced from table")) return true;
  }
  // AppError-wrapped upstream errors: recurse into the serverCause.
  const cause = (err as { serverCause?: unknown }).serverCause;
  if (cause && typeof cause === "object") {
    return isPgForeignKeyViolation(cause);
  }
  return false;
}

async function deleteSlot(principal: Principal, academyId: string, slotId: string): Promise<void> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  // SERIALIZABLE: matches the version-creation endpoint's isolation. A
  // concurrent occurrence-generation request could otherwise race with the
  // slot deletion (the FK ON DELETE RESTRICT catches the conflict, but we
  // want a clean retryable signal at the application layer).
  return db.withTxSerializable(async (tx) => {
    // Load the slot's details for the audit `before` payload AND to verify
    // academy scope + version status. We use FOR UPDATE to lock the row
    // so a concurrent occurrence INSERT can't race with the deletion.
    const slotResult = await tx.query<SlotDetailRow>(
      `SELECT ss.id, ss.schedule_version_id AS "scheduleVersionId",
              ss.weekday,
              to_char(ss.start_time, 'HH24:MI') AS "startTime",
              to_char(ss.end_time, 'HH24:MI') AS "endTime",
              ss.capacity_override AS "capacityOverride",
              sv.status AS "versionStatus"
         FROM schedule_slots ss
         JOIN schedule_versions sv ON sv.id = ss.schedule_version_id
         JOIN classes c ON c.id = sv.class_id
        WHERE ss.id = $1 AND c.academy_id = $2
        FOR UPDATE OF ss
        LIMIT 1;`,
      [slotId, academyId],
    );
    const slotRow = (slotResult.rows[0] as SlotDetailRow | undefined);
    if (!slotRow) {
      throw Err.notFound("Schedule slot not found in this academy.");
    }
    if (slotRow.versionStatus === "superseded") {
      throw Err.conflict(
        "Cannot delete slots from a superseded schedule version.",
        "slot_in_superseded_version",
      );
    }

    const beforePayload = {
      scheduleVersionId: slotRow.scheduleVersionId,
      weekday: slotRow.weekday,
      startTime: slotRow.startTime,
      endTime: slotRow.endTime,
      capacityOverride: slotRow.capacityOverride,
    };

    // Attempt deletion. FK ON DELETE RESTRICT on training_occurrences
    // prevents deletion if any occurrences reference this slot; the
    // application-layer handler above converts that into a 409.
    await tx.query(`DELETE FROM schedule_slots WHERE id = $1;`, [slotId]);

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "schedule_slot.delete", targetType: "schedule_slots", targetId: slotId,
      before: beforePayload,
    });
  });
}
