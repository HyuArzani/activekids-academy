/** GET /api/admin/classes/:id/schedule-versions?academyId=X — list schedule versions.
 *  POST /api/admin/classes/:id/schedule-versions?academyId=X — create a new active version (supersedes the previous one). */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { requireAcademyContext, newId } from "@/lib/domain/helpers";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit/writer";
import { Err } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";

const uuidSchema = z.string().uuid();
const createSchema = z.object({
  effectiveFrom: z.string().date(),
});

interface ScheduleVersionRow {
  id: string;
  classId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: classId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(classId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid class ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId }, async (principal) => {
    const versions = await listVersions(principal, academyId, classId);
    return NextResponse.json({ versions });
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: classId } = await context.params;
  const uuidCheck = uuidSchema.safeParse(classId);
  if (!uuidCheck.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid class ID" } }, { status: 422 });
  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(request, { role: "admin", academyId, requireCsrf: true }, async (principal) => {
    const body = await parseBody(request, createSchema);
    if (body instanceof NextResponse) return body;
    const result = await createVersion(principal, academyId, classId, body.effectiveFrom);
    return NextResponse.json(result, { status: 201 });
  });
}

async function listVersions(principal: Principal, academyId: string, classId: string): Promise<ScheduleVersionRow[]> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  // Verify class belongs to academy.
  const classCheck = await db.query<{ id: string }>(`SELECT id FROM classes WHERE id = $1 AND academy_id = $2;`, [classId, academyId]);
  if (!classCheck.rows[0]) {
    throw Err.notFound("Class not found in this academy.");
  }
  const result = await db.query<ScheduleVersionRow>(
    `SELECT id, class_id AS "classId", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
            to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo", status
       FROM schedule_versions
      WHERE class_id = $1
      ORDER BY effective_from DESC;`,
    [classId],
  );
  return result.rows as ScheduleVersionRow[];
}

async function createVersion(principal: Principal, academyId: string, classId: string, effectiveFrom: string): Promise<ScheduleVersionRow> {
  requireAcademyContext(principal, academyId);
  const db = getDb();
  // SERIALIZABLE: matches migration 0003's documented intent that
  // "non-overlap of FUTURE effective periods is domain-enforced inside a
  // SERIALIZABLE transaction". The DB partial unique index
  // (schedule_versions_one_active_per_class) is the last-line defense; this
  // transaction makes the active-version transition atomic and surfaces
  // any concurrent creation as a retryable serialization conflict.
  return db.withTxSerializable(async (tx) => {
    // Verify class belongs to academy.
    const classCheck = await tx.query<{ id: string }>(`SELECT id FROM classes WHERE id = $1 AND academy_id = $2;`, [classId, academyId]);
    if (!classCheck.rows[0]) {
      throw Err.notFound("Class not found in this academy.");
    }

    // Load the currently-active version (if any) BEFORE superseding it, so
    // we can validate the new effective_from against it and record the
    // supersession in the audit trail.
    const activeResult = await tx.query<{ id: string; effective_from: Date }>(
      `SELECT id, effective_from FROM schedule_versions
        WHERE class_id = $1 AND effective_to IS NULL AND status = 'active'
        LIMIT 1;`,
      [classId],
    );
    const activeRow = (activeResult.rows[0] as { id: string; effective_from: Date } | undefined);

    // Effective-date validation (defensive; the DB CHECK constraint
    // `effective_to >= effective_from` is the last-line defense, but a
    // violation there surfaces as an opaque 500 UPSTREAM_ERROR. We validate
    // here so the client gets a clear 422).
    //
    // Per Phase B2.2.1 spec: "Effective dates are validated and do not
    // create overlapping or contradictory version periods." We enforce:
    //   1. The new effective_from must be strictly later than the
    //      previous active version's effective_from (no overlap).
    //   2. (DB-enforced) effective_to >= effective_from (no contradiction).
    //
    // We do NOT enforce "today or later" because that would reject
    // legitimate backdated schedule corrections (e.g., setting up a new
    // academy's historical schedule). Backdated versions don't corrupt
    // existing occurrences because occurrences preserve their
    // schedule_version_id snapshot at generation time.
    if (activeRow) {
      const prevEffectiveYmd = formatYmd(activeRow.effective_from);
      if (effectiveFrom <= prevEffectiveYmd) {
        throw Err.validation(
          "New effective date must be later than the previous active version's effective date.",
          `before_previous_effective_date:${prevEffectiveYmd}`,
        );
      }
    }

    // Supersede the existing active version (if any). The DB partial unique
    // index enforces at most one active version per class even under
    // concurrent transactions; a race will surface as a retryable
    // serialization conflict (40P01/40001) caught by the API handler.
    let supersededId: string | null = null;
    let supersededEffectiveFrom: string | null = null;
    if (activeRow) {
      supersededId = activeRow.id;
      supersededEffectiveFrom = formatYmd(activeRow.effective_from);
      await tx.query(
        `UPDATE schedule_versions SET effective_to = $1, status = 'superseded', updated_at = now()
          WHERE id = $2;`,
        [effectiveFrom, activeRow.id],
      );
    }

    // Insert the new active version.
    const versionId = newId();
    await tx.query(
      `INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, $3, 'active');`,
      [versionId, classId, effectiveFrom],
    );

    const result = await tx.query<ScheduleVersionRow>(
      `SELECT id, class_id AS "classId", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
              to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo", status
         FROM schedule_versions WHERE id = $1;`,
      [versionId],
    );

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "schedule_version.create", targetType: "schedule_versions", targetId: versionId,
      // Record both the new version and the superseded version for full
      // traceability of version transitions.
      before: supersededId
        ? { supersededVersionId: supersededId, supersededEffectiveFrom, supersededToStatus: "superseded" }
        : null,
      after: { classId, effectiveFrom, status: "active" },
    });

    return (result.rows[0] as ScheduleVersionRow);
  });
}

/** Format a Date (which may be UTC midnight from a DATE column) as "YYYY-MM-DD"
 *  in Asia/Jakarta (UTC+7). Used to compare against the user-supplied
 *  effectiveFrom string (which is already a YMD). */
function formatYmd(d: Date): string {
  // DATE columns load as UTC-midnight Date objects; shift to Jakarta for YMD.
  const shifted = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
