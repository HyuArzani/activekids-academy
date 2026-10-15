/**
 * Domain: Session entitlement operations.
 *
 * Enforces invariants #2–#6, #9:
 *   #2  original_occurrence_id immutable once set (DB trigger).
 *   #3  at most one skip per package (domain: SERIALIZABLE + FOR UPDATE + COUNT).
 *   #4  skip releases occurrence, eligible for makeup (domain).
 *   #5  makeup doesn't consume skip or duplicate (domain).
 *   #6  academy-cancel doesn't consume skip (domain).
 *   #9  admin-correct requires admin role + non-empty reason + audit.
 *
 * All operations run in SERIALIZABLE transactions with SELECT FOR UPDATE
 * on the relevant rows (student_package, training_occurrence).
 *
 * Per Decision 1: excused absence does NOT consume skip; it's recorded
 * distinctly from a student-initiated skip (event_type='excused_absence').
 *
 * Per Decision 2: existing occurrences are immutable snapshots. Schedule
 * changes do NOT rewrite or delete occurrences. Obsolete occurrences are
 * NOT made available for new bookings (the assignOccurrence function
 * checks that the occurrence belongs to the CURRENT active schedule
 * version).
 *
 * Per Decision 3: occurrence assignment is a separate explicit, idempotent
 * operation. Unassigned entitlements (original_occurrence_id = NULL) can
 * be assigned later.
 */

import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import { isRetryableConflict } from "@/lib/db/pg-errors";
import { env } from "@/lib/env";
import {
  requireAcademyContext,
  loadEntitlementInAcademy,
  loadOccurrenceInAcademy,
  loadStudentPackageInAcademy,
  loadActiveScheduleVersion,
  newId,
  type EntitlementRow,
  type TrainingOccurrenceRow,
} from "./helpers";
import { computeEntitlementBodyHash } from "./entitlement-idempotency";

// === Bounded retry helper (Stage 9) =======================================

/** Max retry attempts for serialization/deadlock conflicts (40001/40P01). */
const MAX_IDEMPOTENT_RETRIES = 3;

/**
 * Run a SERIALIZABLE transaction with bounded retry on 40001/40P01.
 * Only retryable conflicts are retried; business errors (validation,
 * capacity, stale-source, idempotency-key-reuse) propagate immediately.
 * Each retry uses a fresh transaction and snapshot.
 */
async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_IDEMPOTENT_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRetryableConflict(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : Err.conflict("Retryable conflict — retries exhausted.", "retryable");
}

// === Guardian access for an entitlement (Stage 9, parent auth) ===========

/**
 * Verify that the principal is the guardian of the entitlement's student.
 * Runs inside the caller's transaction (TOCTOU-safe). Returns the studentId
 * (used in the canonical idempotency payload). Throws NOT_FOUND if the
 * entitlement is not in the academy or the guardian link is missing (does
 * NOT reveal which — avoids information leakage).
 */
async function verifyGuardianAccessForEntitlement(
  tx: TxClient,
  principal: Principal,
  academyId: string,
  entitlementId: string,
): Promise<string> {
  const result = await tx.query<{ student_id: string; c: number }>(
    `SELECT sp.student_id, COUNT(*)::int AS c
       FROM session_entitlements e
       JOIN student_packages sp ON sp.id = e.student_package_id
       JOIN students s ON s.id = sp.student_id
       JOIN guardian_student_links gsl ON gsl.student_id = s.id
      WHERE e.id = $1 AND s.academy_id = $2 AND gsl.guardian_user_id = $3
      GROUP BY sp.student_id
      LIMIT 1;`,
    [entitlementId, academyId, principal.userId],
  );
  const row = result.rows[0];
  if (!row || row.c === 0) {
    throw Err.notFound("Entitlement not found.");
  }
  return row.student_id;
}

// === Skip (student-initiated, consumes the one-skip allowance) ===========

export interface SkipInput {
  entitlementId: string;
  reason?: string;
}

/**
 * Skip an entitlement. Consumes the package's one-skip allowance.
 * Sets status='skipped', assigned_occurrence_id=NULL, skip_used=TRUE.
 * The entitlement is NOT deleted — it remains eligible for a makeup.
 *
 * Invariant #3: at most one skip per package. A second skip for the
 * same package is rejected with CONFLICT.
 */
export async function skipEntitlement(
  principal: Principal,
  academyId: string,
  input: SkipInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  await runWithRetry(() =>
    db.withTxSerializable(async (tx) => {
      await skipEntitlementCore(tx, principal, academyId, input.entitlementId, input.reason);
    }),
  );
}

/**
 * Core skip logic (extracted for reuse by the parent endpoint). Runs inside
 * the caller's SERIALIZABLE transaction. Lock order: entitlement → package.
 */
async function skipEntitlementCore(
  tx: TxClient,
  principal: Principal,
  academyId: string,
  entitlementId: string,
  reason: string | undefined,
): Promise<{ skipAllowanceUsed: number; skipAllowanceRemaining: number }> {
  // Load + lock the entitlement (canonical first lock).
  const entitlement = await loadEntitlementInAcademy(tx, entitlementId, academyId);
  await tx.query(`SELECT id FROM session_entitlements WHERE id = $1 FOR UPDATE;`, [entitlement.id]);

  if (entitlement.status !== "active") {
    throw Err.conflict(`Cannot skip: entitlement status is '${entitlement.status}', must be 'active'.`, "invalid_status");
  }
  if (entitlement.assigned_occurrence_id === null) {
    throw Err.conflict("Cannot skip: entitlement has no current occurrence assignment to release.", "no_assignment");
  }

  // Load + lock the parent student_package (canonical: after entitlement).
  const pkg = await loadStudentPackageInAcademy(tx, entitlement.student_package_id, academyId);
  await tx.query(`SELECT id FROM student_packages WHERE id = $1 FOR UPDATE;`, [pkg.id]);

  // Check the one-skip-per-package rule.
  const skipCountResult = await tx.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
       FROM session_entitlements
      WHERE student_package_id = $1 AND skip_used = TRUE;`,
    [pkg.id],
  );
  const skipCount = (skipCountResult.rows[0] as { c: number }).c;
  if (skipCount >= pkg.skip_allowance) {
    throw Err.conflict(
      `Skip allowance exceeded (${skipCount}/${pkg.skip_allowance} used). A second skip is not allowed.`,
      "skip_allowance_exceeded",
    );
  }

  // Record the before state for the event.
  const beforeState = {
    status: entitlement.status,
    assigned_occurrence_id: entitlement.assigned_occurrence_id,
    skip_used: entitlement.skip_used,
  };

  // Apply the skip.
  await tx.query(
    `UPDATE session_entitlements
        SET status = 'skipped',
            assigned_occurrence_id = NULL,
            skip_used = TRUE,
            updated_at = now()
      WHERE id = $1;`,
    [entitlement.id],
  );

  // Write the entitlement event.
  await tx.query(
    `INSERT INTO entitlement_events
       (id, entitlement_id, event_type, occurred_at, actor_user_id, reason, before_state, after_state)
     VALUES ($1, $2, 'skip_requested', now(), $3, $4, $5::jsonb, $6::jsonb);`,
    [
      newId(),
      entitlement.id,
      principal.userId,
      reason ?? null,
      JSON.stringify(beforeState),
      JSON.stringify({ status: "skipped", assigned_occurrence_id: null, skip_used: true }),
    ],
  );

  await writeAudit({
    tx,
    academyId,
    actorUserId: principal.userId,
    action: "entitlement.skip",
    targetType: "session_entitlements",
    targetId: entitlement.id,
    before: beforeState,
    after: { status: "skipped", skip_used: true },
    reason,
  });

  return {
    skipAllowanceUsed: skipCount + 1,
    skipAllowanceRemaining: pkg.skip_allowance - (skipCount + 1),
  };
}

// === Makeup (assigns a new occurrence; does NOT consume skip) =============

export interface AssignMakeupInput {
  entitlementId: string;
  newOccurrenceId: string;
  reason?: string;
}

/**
 * Assign a makeup occurrence to a skipped or awaiting-makeup entitlement.
 * Does NOT consume the skip allowance (the skip was already consumed).
 * Does NOT duplicate the entitlement (the same entitlement is reused).
 *
 * Invariant #5: makeup does not consume another skip or duplicate.
 *
 * The occurrence must:
 *   - Belong to the same academy.
 *   - Have status='planned' (not cancelled or completed).
 *   - Belong to the CURRENT active schedule version (not an obsolete
 *     version — per Decision 2, old future occurrences are NOT available
 *     for new bookings).
 *   - Have available capacity (checked via DB trigger + domain logic).
 */
export async function assignMakeup(
  principal: Principal,
  academyId: string,
  input: AssignMakeupInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  await runWithRetry(() =>
    db.withTxSerializable(async (tx) => {
      await assignMakeupCore(tx, principal, academyId, input.entitlementId, input.newOccurrenceId, input.reason);
    }),
  );
}

/**
 * Core makeup logic (extracted for reuse by the parent endpoint). Runs inside
 * the caller's SERIALIZABLE transaction. Lock order: entitlement → occurrence.
 */
async function assignMakeupCore(
  tx: TxClient,
  principal: Principal,
  academyId: string,
  entitlementId: string,
  newOccurrenceId: string,
  reason: string | undefined,
): Promise<{ originalOccurrenceId: string | null; assignedOccurrenceId: string }> {
  // Load + lock the entitlement (canonical first lock).
  const entitlement = await loadEntitlementInAcademy(tx, entitlementId, academyId);
  await tx.query(`SELECT id FROM session_entitlements WHERE id = $1 FOR UPDATE;`, [entitlement.id]);

  if (entitlement.status !== "skipped" && entitlement.status !== "awaiting_makeup") {
    throw Err.conflict(
      `Cannot assign makeup: entitlement status is '${entitlement.status}', must be 'skipped' or 'awaiting_makeup'.`,
      "invalid_status",
    );
  }

  // Load + lock the target occurrence (canonical: after entitlement).
  const occ = await loadOccurrenceInAcademy(tx, newOccurrenceId, academyId);
  await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [occ.id]);

  if (occ.status !== "planned") {
    throw Err.conflict(`Cannot assign makeup: occurrence status is '${occ.status}', must be 'planned'.`, "occurrence_not_planned");
  }

  // Per Decision 2: the occurrence must belong to the CURRENT active
  // schedule version (not an obsolete one).
  const activeVersion = await loadActiveScheduleVersion(tx, occ.class_id);
  if (!activeVersion || occ.schedule_version_id !== activeVersion.id) {
    throw Err.conflict(
      "Cannot assign makeup: occurrence belongs to an obsolete schedule version. Only occurrences from the current active version are available for new bookings.",
      "obsolete_version",
    );
  }

  // Capacity check (defense-in-depth; the DB trigger also checks).
  const capacityResult = await tx.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
       FROM session_entitlements
      WHERE assigned_occurrence_id = $1 AND status = 'active';`,
    [occ.id],
  );
  const activeCount = (capacityResult.rows[0] as { c: number }).c;
  if (activeCount >= occ.capacity) {
    throw Err.conflict(`Occurrence capacity exceeded (${activeCount}/${occ.capacity}).`, "destination_full");
  }

  const beforeState = {
    status: entitlement.status,
    assigned_occurrence_id: entitlement.assigned_occurrence_id,
  };

  // Determine if this is the initial assignment (original_occurrence_id is NULL).
  // If so, set original_occurrence_id to the new occurrence (it becomes
  // immutable after this). The DB trigger allows NULL → value.
  const setOriginal = entitlement.original_occurrence_id === null;

  await tx.query(
    `UPDATE session_entitlements
        SET status = 'active',
            assigned_occurrence_id = $2${setOriginal ? ", original_occurrence_id = $2" : ""},
            updated_at = now()
      WHERE id = $1;`,
    [entitlement.id, newOccurrenceId],
  );

  await tx.query(
    `INSERT INTO entitlement_events
       (id, entitlement_id, event_type, occurred_at, actor_user_id, reason, before_state, after_state)
     VALUES ($1, $2, 'makeup_assigned', now(), $3, $4, $5::jsonb, $6::jsonb);`,
    [
      newId(),
      entitlement.id,
      principal.userId,
      reason ?? null,
      JSON.stringify(beforeState),
      JSON.stringify({ status: "active", assigned_occurrence_id: newOccurrenceId, original_set: setOriginal }),
    ],
  );

  await writeAudit({
    tx,
    academyId,
    actorUserId: principal.userId,
    action: "entitlement.makeup",
    targetType: "session_entitlements",
    targetId: entitlement.id,
    before: beforeState,
    after: { status: "active", assigned_occurrence_id: newOccurrenceId },
    reason,
  });

  return {
    originalOccurrenceId: setOriginal ? newOccurrenceId : entitlement.original_occurrence_id,
    assignedOccurrenceId: newOccurrenceId,
  };
}

// === Academy-cancel (does NOT consume skip) ===============================

export interface CancelOccurrenceInput {
  occurrenceId: string;
  reason: string;
}

/**
 * Cancel a training occurrence (academy-initiated). All active entitlements
 * assigned to this occurrence are set to 'awaiting_makeup' with
 * assigned_occurrence_id=NULL. skip_used stays FALSE — academy-cancel
 * does NOT consume the student's skip allowance (invariant #6).
 *
 * The reassignment is explicit: the admin must later use `assignMakeup`
 * to assign each affected entitlement to a new occurrence.
 */
export async function cancelOccurrence(
  principal: Principal,
  academyId: string,
  input: CancelOccurrenceInput,
  db: DbClient = getDb(),
): Promise<{ affectedEntitlements: number }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!input.reason || input.reason.trim() === "") {
    throw Err.validation("A non-empty reason is required for occurrence cancellation.");
  }

  return db.withTxSerializable(async (tx) => {
    const occ = await loadOccurrenceInAcademy(tx, input.occurrenceId, academyId);
    await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [occ.id]);

    if (occ.status === "cancelled") {
      throw Err.conflict("Occurrence is already cancelled.");
    }

    // Cancel the occurrence.
    await tx.query(
      `UPDATE training_occurrences
          SET status = 'cancelled', cancelled_at = now(), cancelled_reason = $2, updated_at = now()
        WHERE id = $1;`,
      [occ.id, input.reason],
    );

    // Set all active entitlements assigned to this occurrence to awaiting_makeup.
    // skip_used stays FALSE — academy-cancel does NOT consume skip.
    const affectedResult = await tx.query(
      `UPDATE session_entitlements
          SET status = 'awaiting_makeup', assigned_occurrence_id = NULL, updated_at = now()
        WHERE assigned_occurrence_id = $1 AND status = 'active'
        RETURNING id;`,
      [occ.id],
    );
    const affectedIds = (affectedResult.rows ?? []).map((r) => (r as { id: string }).id);

    // Record events for each affected entitlement.
    for (const entId of affectedIds) {
      await tx.query(
        `INSERT INTO entitlement_events
           (id, entitlement_id, event_type, occurred_at, actor_user_id, reason, after_state)
         VALUES ($1, $2, 'cancelled_reassigned', now(), $3, $4, $5::jsonb);`,
        [
          newId(),
          entId,
          principal.userId,
          input.reason,
          JSON.stringify({ status: "awaiting_makeup", assigned_occurrence_id: null, skip_used: false }),
        ],
      );
    }

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "occurrence.cancel",
      targetType: "training_occurrences",
      targetId: occ.id,
      after: { status: "cancelled", reason: input.reason, affectedEntitlements: affectedIds.length },
      reason: input.reason,
    });

    return { affectedEntitlements: affectedIds.length };
  });
}

// === Excused absence (does NOT consume skip) ==============================

export interface ExcusedAbsenceInput {
  entitlementId: string;
  reason: string;
}

/**
 * Record an excused absence for an entitlement. Sets status to
 * 'awaiting_makeup' with assigned_occurrence_id=NULL. Does NOT consume
 * the skip allowance (per Decision 1).
 *
 * The event is recorded with event_type='excused_absence' (distinct from
 * 'skip_requested' which is student-initiated and consumes the allowance).
 */
export async function excusedAbsence(
  principal: Principal,
  academyId: string,
  input: ExcusedAbsenceInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  if (!input.reason || input.reason.trim() === "") {
    throw Err.validation("A non-empty reason is required for an excused absence.");
  }

  return db.withTxSerializable(async (tx) => {
    const entitlement = await loadEntitlementInAcademy(tx, input.entitlementId, academyId);

    if (entitlement.status !== "active") {
      throw Err.conflict(`Cannot record excused absence: entitlement status is '${entitlement.status}', must be 'active'.`);
    }

    const beforeState = {
      status: entitlement.status,
      assigned_occurrence_id: entitlement.assigned_occurrence_id,
      skip_used: entitlement.skip_used,
    };

    // Set to awaiting_makeup. skip_used stays FALSE (does NOT consume skip).
    await tx.query(
      `UPDATE session_entitlements
          SET status = 'awaiting_makeup', assigned_occurrence_id = NULL, updated_at = now()
        WHERE id = $1;`,
      [entitlement.id],
    );

    await tx.query(
      `INSERT INTO entitlement_events
         (id, entitlement_id, event_type, occurred_at, actor_user_id, reason, before_state, after_state)
       VALUES ($1, $2, 'excused_absence', now(), $3, $4, $5::jsonb, $6::jsonb);`,
      [
        newId(),
        entitlement.id,
        principal.userId,
        input.reason,
        JSON.stringify(beforeState),
        JSON.stringify({ status: "awaiting_makeup", assigned_occurrence_id: null, skip_used: false }),
      ],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "entitlement.excused_absence",
      targetType: "session_entitlements",
      targetId: entitlement.id,
      before: beforeState,
      after: { status: "awaiting_makeup", skip_used: false },
      reason: input.reason,
    });
  });
}

// === Admin correct (requires admin role + reason + audit) ================

export interface AdminCorrectInput {
  entitlementId: string;
  /** The new occurrence to assign, or null to unassign. */
  newAssignedOccurrenceId: string | null;
  reason: string;
}

/**
 * Admin-correct an entitlement's assignment. Requires:
 *   - Principal has admin role in the academy (invariant #9).
 *   - Non-empty reason (required by DB CHECK + domain check).
 *   - Audit event in the same transaction.
 *
 * Can assign to a new occurrence, or unassign (set to NULL).
 * The original_occurrence_id is NOT changed (it's immutable once set).
 */
export async function adminCorrect(
  principal: Principal,
  academyId: string,
  input: AdminCorrectInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!input.reason || input.reason.trim() === "") {
    throw Err.validation("A non-empty reason is required for admin corrections.");
  }

  return db.withTxSerializable(async (tx) => {
    const entitlement = await loadEntitlementInAcademy(tx, input.entitlementId, academyId);
    // Lock the entitlement row.
    await tx.query(`SELECT id FROM session_entitlements WHERE id = $1 FOR UPDATE;`, [entitlement.id]);

    const beforeState = {
      status: entitlement.status,
      assigned_occurrence_id: entitlement.assigned_occurrence_id,
    };

    if (input.newAssignedOccurrenceId !== null) {
      // Validate the new occurrence.
      const occ = await loadOccurrenceInAcademy(tx, input.newAssignedOccurrenceId, academyId);
      await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [occ.id]);

      if (occ.status === "cancelled") {
        throw Err.conflict("Cannot assign to a cancelled occurrence.");
      }

      // Capacity check (the DB trigger also checks).
      const capacityResult = await tx.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
           FROM session_entitlements
          WHERE assigned_occurrence_id = $1 AND status = 'active' AND id <> $2;`,
        [occ.id, entitlement.id],
      );
      const activeCount = (capacityResult.rows[0] as { c: number }).c;
      if (activeCount + 1 > occ.capacity) {
        throw Err.conflict(`Occurrence capacity exceeded (${activeCount + 1}/${occ.capacity}).`);
      }
    }

    // Apply the correction. If this is the first assignment (original is NULL),
    // set original_occurrence_id too (it becomes immutable).
    const setOriginal =
      input.newAssignedOccurrenceId !== null && entitlement.original_occurrence_id === null;

    await tx.query(
      `UPDATE session_entitlements
          SET assigned_occurrence_id = $2${setOriginal ? ", original_occurrence_id = $2" : ""},
              updated_at = now()
        WHERE id = $1;`,
      [entitlement.id, input.newAssignedOccurrenceId],
    );

    // Record the admin-corrected event (reason is REQUIRED — DB CHECK enforces).
    await tx.query(
      `INSERT INTO entitlement_events
         (id, entitlement_id, event_type, occurred_at, actor_user_id, reason, before_state, after_state)
       VALUES ($1, $2, 'admin_corrected', now(), $3, $4, $5::jsonb, $6::jsonb);`,
      [
        newId(),
        entitlement.id,
        principal.userId,
        input.reason,
        JSON.stringify(beforeState),
        JSON.stringify({ assigned_occurrence_id: input.newAssignedOccurrenceId, original_set: setOriginal }),
      ],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "entitlement.admin_correct",
      targetType: "session_entitlements",
      targetId: entitlement.id,
      before: beforeState,
      after: { assigned_occurrence_id: input.newAssignedOccurrenceId },
      reason: input.reason,
    });
  });
}

// === Occurrence assignment (explicit, idempotent) ========================

export interface AssignOccurrenceInput {
  entitlementId: string;
  occurrenceId: string;
}

/**
 * Assign an occurrence to an unassigned entitlement. This is the explicit,
 * idempotent operation for occurrence assignment (separate from package
 * purchase per Decision 3).
 *
 * The entitlement must currently be unassigned (original_occurrence_id IS
 * NULL). If the entitlement already has an occurrence, this is a no-op
 * (idempotent) if the occurrence is the same, or a conflict if different.
 */
export async function assignOccurrence(
  principal: Principal,
  academyId: string,
  input: AssignOccurrenceInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);

  await runWithRetry(() =>
    db.withTxSerializable(async (tx) => {
    const entitlement = await loadEntitlementInAcademy(tx, input.entitlementId, academyId);
    await tx.query(`SELECT id FROM session_entitlements WHERE id = $1 FOR UPDATE;`, [entitlement.id]);

    // Idempotent: if already assigned to the same occurrence, no-op.
    if (entitlement.assigned_occurrence_id === input.occurrenceId) {
      return; // idempotent success
    }

    // If already assigned to a DIFFERENT occurrence, reject (use adminCorrect).
    if (entitlement.assigned_occurrence_id !== null) {
      throw Err.conflict(
        "Entitlement is already assigned to a different occurrence. Use adminCorrect to reassign.",
      );
    }

    if (entitlement.status !== "active") {
      throw Err.conflict(`Cannot assign occurrence: entitlement status is '${entitlement.status}', must be 'active'.`);
    }

    const occ = await loadOccurrenceInAcademy(tx, input.occurrenceId, academyId);
    await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [occ.id]);

    if (occ.status !== "planned") {
      throw Err.conflict(`Cannot assign: occurrence status is '${occ.status}', must be 'planned'.`);
    }

    // Per Decision 2: occurrence must belong to the CURRENT active version.
    const activeVersion = await loadActiveScheduleVersion(tx, occ.class_id);
    if (!activeVersion || occ.schedule_version_id !== activeVersion.id) {
      throw Err.conflict("Occurrence belongs to an obsolete schedule version. Not available for new bookings.");
    }

    // Capacity check.
    const capacityResult = await tx.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
         FROM session_entitlements
        WHERE assigned_occurrence_id = $1 AND status = 'active' AND id <> $2;`,
      [occ.id, entitlement.id],
    );
    const activeCount = (capacityResult.rows[0] as { c: number }).c;
    if (activeCount + 1 > occ.capacity) {
      throw Err.conflict(`Occurrence capacity exceeded (${activeCount + 1}/${occ.capacity}).`);
    }

    // This is the initial assignment — set both original_occurrence_id
    // (immutable after this) and assigned_occurrence_id.
    await tx.query(
      `UPDATE session_entitlements
          SET original_occurrence_id = $2,
              assigned_occurrence_id = $2,
              updated_at = now()
        WHERE id = $1;`,
      [entitlement.id, input.occurrenceId],
    );

    await tx.query(
      `INSERT INTO entitlement_events
         (id, entitlement_id, event_type, occurred_at, actor_user_id, reason)
       VALUES ($1, $2, 'occurrence_assigned', now(), $3, 'Initial occurrence assignment');`,
      [newId(), entitlement.id, principal.userId],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "entitlement.assign_occurrence",
      targetType: "session_entitlements",
      targetId: entitlement.id,
      after: { original_occurrence_id: input.occurrenceId, assigned_occurrence_id: input.occurrenceId },
    });
    }),
  );
}

// === List entitlement events (history) ===================================

export interface EntitlementEventRow {
  id: string;
  event_type: string;
  occurred_at: Date;
  actor_user_id: string | null;
  reason: string | null;
  before_state: string | null;
  after_state: string | null;
}

export async function listEntitlementEvents(
  principal: Principal,
  academyId: string,
  entitlementId: string,
  db: DbClient = getDb(),
): Promise<EntitlementEventRow[]> {
  requireAcademyContext(principal, academyId);
  // Verify the entitlement is in this academy (via package → student → academy).
  await loadEntitlementInAcademy(db, entitlementId, academyId);

  const result = await db.query<EntitlementEventRow>(
    `SELECT ee.id, ee.event_type, ee.occurred_at, ee.actor_user_id,
            ee.reason, ee.before_state::text, ee.after_state::text
       FROM entitlement_events ee
      WHERE ee.entitlement_id = $1
      ORDER BY ee.occurred_at ASC;`,
    [entitlementId],
  );
  return result.rows as EntitlementEventRow[];
}

// === Bulk-assign unassigned entitlements (recovery) ====================

export interface AssignUnassignedResult {
  assigned: number;
  stillUnassigned: number;
  details: { entitlementId: string; occurrenceId: string }[];
}

/**
 * Attempt to assign all unassigned entitlements in a package to eligible
 * future training occurrences. Assignments are made in sequence order.
 * Entitlements that cannot be assigned (no eligible occurrence, capacity
 * full, etc.) remain unassigned and visible.
 *
 * Each assignment is an explicit call to `assignOccurrence`, so all
 * existing invariants (academy scoping, version check, capacity, FOR
 * UPDATE) are preserved.
 */
export async function assignUnassignedEntitlements(
  principal: Principal,
  academyId: string,
  packageId: string,
  db: DbClient = getDb(),
): Promise<AssignUnassignedResult> {
  requireAcademyContext(principal, academyId);

  // Load the package (academy-scoped).
  const pkg = await loadStudentPackageInAcademy(db, packageId, academyId);

  // Find all unassigned entitlements (original_occurrence_id IS NULL,
  // assigned_occurrence_id IS NULL, status='active') in sequence order.
  const unassignedResult = await db.query<{ id: string }>(
    `SELECT e.id
       FROM session_entitlements e
      WHERE e.student_package_id = $1
        AND e.original_occurrence_id IS NULL
        AND e.assigned_occurrence_id IS NULL
        AND e.status = 'active'
      ORDER BY e.sequence;`,
    [pkg.id],
  );
  const unassignedIds = (unassignedResult.rows as { id: string }[]).map((r) => r.id);

  let assigned = 0;
  const details: { entitlementId: string; occurrenceId: string }[] = [];

  for (const entitlementId of unassignedIds) {
    // Find the next eligible occurrence: same academy, same class (as
    // class_id_at_purchase), status='planned', from the current active
    // schedule version, not already at capacity, date >= today.
    const eligibleResult = await db.query<{ id: string }>(
      `SELECT tocc.id
         FROM training_occurrences tocc
         JOIN schedule_versions sv ON sv.id = tocc.schedule_version_id
        WHERE tocc.academy_id = $1
          AND tocc.class_id = $2
          AND tocc.status = 'planned'
          AND tocc.occurrence_date >= CURRENT_DATE
          AND sv.status = 'active'
          AND sv.effective_to IS NULL
          AND tocc.capacity > (
            SELECT COUNT(*) FROM session_entitlements
             WHERE assigned_occurrence_id = tocc.id AND status = 'active'
          )
        ORDER BY tocc.occurrence_date, tocc.start_at
        LIMIT 1;`,
      [academyId, pkg.class_id_at_purchase],
    );

    const eligibleOcc = (eligibleResult.rows[0] as { id: string } | undefined);

    if (!eligibleOcc) {
      // No eligible occurrence — leave unassigned, move to next entitlement.
      continue;
    }

    try {
      await assignOccurrence(principal, academyId, {
        entitlementId,
        occurrenceId: eligibleOcc.id,
      }, db);
      assigned++;
      details.push({ entitlementId, occurrenceId: eligibleOcc.id });
    } catch {
      // Assignment failed (e.g., capacity filled by a concurrent
      // assignment, or occurrence no longer eligible). Leave unassigned.
      continue;
    }
  }

  return {
    assigned,
    stillUnassigned: unassignedIds.length - assigned,
    details,
  };
}

// === Stage 9: Parent scheduling mutations (idempotent) ===================

export interface ParentMoveInput {
  entitlementId: string;
  destinationOccurrenceId: string;
  expectedCurrentOccurrenceId: string;
  idempotencyKey: string;
  reason?: string;
}

export interface ParentMoveResult {
  operation: "move";
  entitlementId: string;
  originalOccurrenceId: string | null;
  assignedOccurrenceId: string;
  status: string;
  moveCountUsed: number;
  moveCountRemaining: number;
  noOp: boolean;
}

export interface ParentSkipInput {
  entitlementId: string;
  idempotencyKey: string;
  reason?: string;
}

export interface ParentSkipResult {
  operation: "skip";
  entitlementId: string;
  status: string;
  skipAllowanceUsed: number;
  skipAllowanceRemaining: number;
}

export interface ParentMakeupInput {
  entitlementId: string;
  destinationOccurrenceId: string;
  idempotencyKey: string;
  reason?: string;
}

export interface ParentMakeupResult {
  operation: "makeup";
  entitlementId: string;
  originalOccurrenceId: string | null;
  assignedOccurrenceId: string;
  status: string;
}

/** Idempotency-record row shape for replay checks. */
interface IdempotencyRecord {
  result: string;
  body_hash: string;
  no_op: boolean;
}

/**
 * Look up an existing idempotency record. Returns the stored result (replay)
 * or throws idempotency_key_reuse if the key exists with a different body hash.
 * Returns null if no record exists (first request).
 */
async function checkIdempotencyReplay(
  tx: TxClient,
  entitlementId: string,
  idempotencyKey: string,
  bodyHash: string,
): Promise<{ replayed: true; result: string; noOp: boolean } | { replayed: false }> {
  const existing = await tx.query<IdempotencyRecord>(
    `SELECT result::text, body_hash, no_op
       FROM entitlement_idempotency_records
      WHERE entitlement_id = $1 AND idempotency_key = $2
      LIMIT 1;`,
    [entitlementId, idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) return { replayed: false };
  if (row.body_hash === bodyHash) {
    return { replayed: true, result: row.result, noOp: row.no_op };
  }
  throw Err.conflict(
    "Idempotency key reuse — the key was used for a different request.",
    "idempotency_key_reuse",
  );
}

/**
 * Insert an idempotency record with ON CONFLICT DO NOTHING. If the insert
 * conflicts (another tx won the race), throws a retryable signal so the
 * bounded-retry loop starts a fresh tx and re-checks for the winner's record.
 */
async function insertIdempotencyRecord(
  tx: TxClient,
  academyId: string,
  entitlementId: string,
  idempotencyKey: string,
  bodyHash: string,
  operation: "move" | "skip" | "makeup",
  result: unknown,
  noOp: boolean,
): Promise<void> {
  const ins = await tx.query(
    `INSERT INTO entitlement_idempotency_records
       (id, academy_id, entitlement_id, idempotency_key, body_hash, operation, result, no_op)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (entitlement_id, idempotency_key) DO NOTHING
     RETURNING id;`,
    [newId(), academyId, entitlementId, idempotencyKey, bodyHash, operation, JSON.stringify(result), noOp],
  );
  if (ins.rowCount === 0) {
    // Another tx won the race. Force a retry — the fresh tx's replay check
    // will find the winner's committed record and return it.
    throw Err.conflict("Idempotency race — retry.", "retryable");
  }
}

/**
 * Parent normal move. Moves the entitlement's assigned occurrence from
 * expectedCurrentOccurrenceId to destinationOccurrenceId. Preserves
 * original_occurrence_id (immutable). Consumes one move allowance.
 *
 * Idempotent: same key + same body returns the stored result. Same key +
 * different body → 409 idempotency_key_reuse. No-op (expected===dest) stores
 * a record without creating a normal_moved event or consuming allowance.
 *
 * Lock order: entitlement → occurrences (ascending ID).
 */
export async function moveEntitlement(
  principal: Principal,
  academyId: string,
  input: ParentMoveInput,
  db: DbClient = getDb(),
): Promise<ParentMoveResult> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "parent", academyId);

  return runWithRetry(() =>
    db.withTxSerializable(async (tx) => {
      // 1. Guardian access (inside tx, TOCTOU-safe). Returns studentId.
      const studentId = await verifyGuardianAccessForEntitlement(
        tx, principal, academyId, input.entitlementId,
      );

      // 2. Compute canonical body hash.
      const bodyHash = computeEntitlementBodyHash({
        operation: "move",
        academyId,
        studentId,
        entitlementId: input.entitlementId,
        destinationOccurrenceId: input.destinationOccurrenceId,
        expectedCurrentOccurrenceId: input.expectedCurrentOccurrenceId,
        reason: input.reason ?? null,
      });

      // 3. Load + lock the entitlement (canonical first lock).
      const entitlement = await loadEntitlementInAcademy(tx, input.entitlementId, academyId);
      await tx.query(`SELECT id FROM session_entitlements WHERE id = $1 FOR UPDATE;`, [entitlement.id]);

      // 4. Idempotency replay check (before state validation).
      const replay = await checkIdempotencyReplay(
        tx, entitlement.id, input.idempotencyKey, bodyHash,
      );
      if (replay.replayed) {
        return JSON.parse(replay.result) as ParentMoveResult;
      }

      // 5. Stale-source precondition (optimistic concurrency).
      if (entitlement.assigned_occurrence_id !== input.expectedCurrentOccurrenceId) {
        throw Err.conflict(
          "Stale assignment — the entitlement has been moved. Refresh and retry with a new request.",
          "stale_assignment",
        );
      }

      // 6. No-op: expected === destination.
      if (input.expectedCurrentOccurrenceId === input.destinationOccurrenceId) {
        const moveCountResult = await tx.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM entitlement_events
            WHERE entitlement_id = $1 AND event_type = 'normal_moved';`,
          [entitlement.id],
        );
        const moveCountUsed = (moveCountResult.rows[0] as { c: number }).c;
        const moveLimit = env.NORMAL_MOVE_LIMIT_PER_ENTITLEMENT;
        const result: ParentMoveResult = {
          operation: "move",
          entitlementId: entitlement.id,
          originalOccurrenceId: entitlement.original_occurrence_id,
          assignedOccurrenceId: entitlement.assigned_occurrence_id!,
          status: entitlement.status,
          moveCountUsed,
          moveCountRemaining: Math.max(0, moveLimit - moveCountUsed),
          noOp: true,
        };
        await insertIdempotencyRecord(
          tx, academyId, entitlement.id, input.idempotencyKey, bodyHash, "move", result, true,
        );
        await writeAudit({
          tx, academyId, actorUserId: principal.userId,
          action: "entitlement.move_noop", targetType: "session_entitlements",
          targetId: entitlement.id,
          after: { noOp: true, assignedOccurrenceId: entitlement.assigned_occurrence_id },
          reason: input.reason,
        });
        return result;
      }

      // 7. Load + lock occurrences (ascending ID, source + destination).
      const occIds = [input.destinationOccurrenceId];
      if (input.expectedCurrentOccurrenceId !== input.destinationOccurrenceId) {
        occIds.push(input.expectedCurrentOccurrenceId);
      }
      occIds.sort();
      const occMap = new Map<string, TrainingOccurrenceRow>();
      for (const oid of occIds) {
        const occ = await loadOccurrenceInAcademy(tx, oid, academyId);
        await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [occ.id]);
        occMap.set(occ.id, occ);
      }
      const destOcc = occMap.get(input.destinationOccurrenceId)!;

      // 8. Historical lock: destination must be in the future.
      if (new Date(destOcc.start_at).getTime() <= Date.now()) {
        throw Err.conflict("Cannot move to a past or already-started occurrence.", "past_occurrence");
      }

      // 9. Occurrence status check.
      if (destOcc.status !== "planned") {
        throw Err.conflict(`Cannot move: occurrence status is '${destOcc.status}', must be 'planned'.`, "occurrence_not_planned");
      }

      // 10. Same-class eligibility.
      const pkg = await loadStudentPackageInAcademy(tx, entitlement.student_package_id, academyId);
      if (destOcc.class_id !== pkg.class_id_at_purchase) {
        throw Err.conflict("Destination occurrence does not belong to the package's class.", "class_mismatch");
      }

      // 11. Active schedule version check.
      const activeVersion = await loadActiveScheduleVersion(tx, destOcc.class_id);
      if (!activeVersion || destOcc.schedule_version_id !== activeVersion.id) {
        throw Err.conflict("Destination occurrence belongs to an obsolete schedule version.", "obsolete_version");
      }

      // 12. Capacity check.
      const capResult = await tx.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM session_entitlements
          WHERE assigned_occurrence_id = $1 AND status = 'active' AND id <> $2;`,
        [destOcc.id, entitlement.id],
      );
      const activeCount = (capResult.rows[0] as { c: number }).c;
      if (activeCount + 1 > destOcc.capacity) {
        throw Err.conflict(`Occurrence capacity exceeded (${activeCount + 1}/${destOcc.capacity}).`, "destination_full");
      }

      // 13. Move-limit check (inside the same tx as the UPDATE).
      const moveCountResult = await tx.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM entitlement_events
          WHERE entitlement_id = $1 AND event_type = 'normal_moved';`,
        [entitlement.id],
      );
      const moveCountUsed = (moveCountResult.rows[0] as { c: number }).c;
      const moveLimit = env.NORMAL_MOVE_LIMIT_PER_ENTITLEMENT;
      if (moveCountUsed >= moveLimit) {
        throw Err.conflict(`Move allowance exceeded (${moveCountUsed}/${moveLimit}).`, "move_limit_exceeded");
      }

      // 14. UPDATE entitlement (assigned only — never original_occurrence_id).
      const beforeState = { assigned_occurrence_id: entitlement.assigned_occurrence_id };
      await tx.query(
        `UPDATE session_entitlements
            SET assigned_occurrence_id = $2, updated_at = now()
          WHERE id = $1;`,
        [entitlement.id, input.destinationOccurrenceId],
      );

      // 15. INSERT normal_moved event.
      await tx.query(
        `INSERT INTO entitlement_events
           (id, entitlement_id, event_type, occurred_at, actor_user_id, reason, before_state, after_state)
         VALUES ($1, $2, 'normal_moved', now(), $3, $4, $5::jsonb, $6::jsonb);`,
        [
          newId(),
          entitlement.id,
          principal.userId,
          input.reason ?? null,
          JSON.stringify(beforeState),
          JSON.stringify({ assigned_occurrence_id: input.destinationOccurrenceId }),
        ],
      );

      // 16. Build result + insert idempotency record.
      const result: ParentMoveResult = {
        operation: "move",
        entitlementId: entitlement.id,
        originalOccurrenceId: entitlement.original_occurrence_id,
        assignedOccurrenceId: input.destinationOccurrenceId,
        status: "active",
        moveCountUsed: moveCountUsed + 1,
        moveCountRemaining: Math.max(0, moveLimit - (moveCountUsed + 1)),
        noOp: false,
      };
      await insertIdempotencyRecord(
        tx, academyId, entitlement.id, input.idempotencyKey, bodyHash, "move", result, false,
      );

      // 17. Audit.
      await writeAudit({
        tx, academyId, actorUserId: principal.userId,
        action: "entitlement.move", targetType: "session_entitlements",
        targetId: entitlement.id,
        before: beforeState,
        after: { assigned_occurrence_id: input.destinationOccurrenceId },
        reason: input.reason,
      });

      return result;
    }),
  );
}

/**
 * Parent skip. Idempotent wrapper around the shared skip core. Adds guardian
 * authorization, idempotency key handling, and parent-role enforcement.
 */
export async function parentSkipEntitlement(
  principal: Principal,
  academyId: string,
  input: ParentSkipInput,
  db: DbClient = getDb(),
): Promise<ParentSkipResult> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "parent", academyId);

  return runWithRetry(() =>
    db.withTxSerializable(async (tx) => {
      // 1. Guardian access.
      const studentId = await verifyGuardianAccessForEntitlement(
        tx, principal, academyId, input.entitlementId,
      );

      // 2. Compute canonical body hash.
      const bodyHash = computeEntitlementBodyHash({
        operation: "skip",
        academyId,
        studentId,
        entitlementId: input.entitlementId,
        destinationOccurrenceId: null,
        expectedCurrentOccurrenceId: null,
        reason: input.reason ?? null,
      });

      // 3. Load + lock the entitlement (for the replay check ordering).
      const entitlement = await loadEntitlementInAcademy(tx, input.entitlementId, academyId);
      await tx.query(`SELECT id FROM session_entitlements WHERE id = $1 FOR UPDATE;`, [entitlement.id]);

      // 4. Idempotency replay check (before state validation).
      const replay = await checkIdempotencyReplay(
        tx, entitlement.id, input.idempotencyKey, bodyHash,
      );
      if (replay.replayed) {
        return JSON.parse(replay.result) as ParentSkipResult;
      }

      // 5. Perform the skip (delegates to the shared core — same tx).
      const coreResult = await skipEntitlementCore(
        tx, principal, academyId, input.entitlementId, input.reason,
      );

      // 6. Build result + insert idempotency record.
      const result: ParentSkipResult = {
        operation: "skip",
        entitlementId: input.entitlementId,
        status: "skipped",
        skipAllowanceUsed: coreResult.skipAllowanceUsed,
        skipAllowanceRemaining: coreResult.skipAllowanceRemaining,
      };
      await insertIdempotencyRecord(
        tx, academyId, entitlement.id, input.idempotencyKey, bodyHash, "skip", result, false,
      );

      return result;
    }),
  );
}

/**
 * Parent makeup. Idempotent wrapper around the shared makeup core. Adds
 * guardian authorization, idempotency key handling, and parent-role enforcement.
 */
export async function parentAssignMakeup(
  principal: Principal,
  academyId: string,
  input: ParentMakeupInput,
  db: DbClient = getDb(),
): Promise<ParentMakeupResult> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "parent", academyId);

  return runWithRetry(() =>
    db.withTxSerializable(async (tx) => {
      // 1. Guardian access.
      const studentId = await verifyGuardianAccessForEntitlement(
        tx, principal, academyId, input.entitlementId,
      );

      // 2. Compute canonical body hash.
      const bodyHash = computeEntitlementBodyHash({
        operation: "makeup",
        academyId,
        studentId,
        entitlementId: input.entitlementId,
        destinationOccurrenceId: input.destinationOccurrenceId,
        expectedCurrentOccurrenceId: null,
        reason: input.reason ?? null,
      });

      // 3. Load + lock the entitlement (for the replay check ordering).
      const entitlement = await loadEntitlementInAcademy(tx, input.entitlementId, academyId);
      await tx.query(`SELECT id FROM session_entitlements WHERE id = $1 FOR UPDATE;`, [entitlement.id]);

      // 4. Idempotency replay check (before state validation).
      const replay = await checkIdempotencyReplay(
        tx, entitlement.id, input.idempotencyKey, bodyHash,
      );
      if (replay.replayed) {
        return JSON.parse(replay.result) as ParentMakeupResult;
      }

      // 5. Perform the makeup (delegates to the shared core — same tx).
      const coreResult = await assignMakeupCore(
        tx, principal, academyId, input.entitlementId, input.destinationOccurrenceId, input.reason,
      );

      // 6. Build result + insert idempotency record.
      const result: ParentMakeupResult = {
        operation: "makeup",
        entitlementId: input.entitlementId,
        originalOccurrenceId: coreResult.originalOccurrenceId,
        assignedOccurrenceId: coreResult.assignedOccurrenceId,
        status: "active",
      };
      await insertIdempotencyRecord(
        tx, academyId, entitlement.id, input.idempotencyKey, bodyHash, "makeup", result, false,
      );

      return result;
    }),
  );
}
