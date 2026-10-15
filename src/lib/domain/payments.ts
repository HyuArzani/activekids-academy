/**
 * Domain: Payments and payment allocations.
 *
 * Enforces:
 *   - Payment submission (parent submits amount + evidence metadata).
 *   - Payment confirmation (admin reviews + confirms, requires allocations).
 *   - Allocation sum must not exceed the confirmed payment amount
 *     (domain-level check in SERIALIZABLE transaction).
 *   - Academy scoping: payment, student, and allocations must all belong
 *     to the principal's academy.
 *
 * Stage 5 additions (manual workflow):
 *   - `recordPayment`: Admin records a confirmed payment + atomic package
 *     purchase + allocation + audit, with idempotency key + bounded retry.
 *   - `generatePaymentConfirmationMessage`: Indonesian WhatsApp-ready text
 *     using REAL assigned occurrence dates; unassigned sessions clearly
 *     marked "belum dijadwalkan". Pure read, no side effects.
 *   - `listPaymentsForStudent`, `getPaymentDetails`: academy-scoped reads.
 *
 * All operations run in SERIALIZABLE transactions.
 */

import { createHash } from "node:crypto";
import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import { isRetryableConflict } from "@/lib/db/pg-errors";
import {
  requireAcademyContext,
  loadStudentInAcademy,
  loadStudentPackageInAcademy,
  newId,
} from "./helpers";
import { purchasePackageInTx } from "./packages";

export interface SubmitPaymentInput {
  studentId: string;
  submittedAmount: number;
  evidenceUrl?: string;
  evidenceMeta?: Record<string, unknown>;
}

export interface ConfirmPaymentInput {
  paymentId: string;
  allocations: { studentPackageId: string; amount: number }[];
  reviewerNote?: string;
}

export async function submitPayment(
  principal: Principal,
  academyId: string,
  input: SubmitPaymentInput,
  db: DbClient = getDb(),
): Promise<{ paymentId: string }> {
  requireAcademyContext(principal, academyId);
  await loadStudentInAcademy(db, input.studentId, academyId);

  if (input.submittedAmount < 0) {
    throw Err.validation("Submitted amount must be non-negative.");
  }

  return db.withTxSerializable(async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO payments
         (id, academy_id, payer_user_id, student_id, submitted_amount, currency,
          evidence_url, evidence_meta, status)
       VALUES ($1, $2, $3, $4, $5, 'IDR', $6, $7, 'submitted');`,
      [
        id,
        academyId,
        principal.userId,
        input.studentId,
        input.submittedAmount,
        input.evidenceUrl ?? null,
        input.evidenceMeta ? JSON.stringify(input.evidenceMeta) : null,
      ],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "payment.submit",
      targetType: "payments",
      targetId: id,
      after: { studentId: input.studentId, submittedAmount: input.submittedAmount },
    });

    return { paymentId: id };
  });
}

export async function confirmPayment(
  principal: Principal,
  academyId: string,
  input: ConfirmPaymentInput,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  return db.withTxSerializable(async (tx) => {
    // Load + lock the payment.
    const paymentResult = await tx.query<{ id: string; submitted_amount: string; status: string; student_id: string }>(
      `SELECT id, submitted_amount, status, student_id
         FROM payments
        WHERE id = $1 AND academy_id = $2
        LIMIT 1;`,
      [input.paymentId, academyId],
    );
    const payment = paymentResult.rows[0] as { id: string; submitted_amount: string; status: string; student_id: string } | undefined;
    if (!payment) throw Err.notFound("Payment not found in this academy.");
    await tx.query(`SELECT id FROM payments WHERE id = $1 FOR UPDATE;`, [payment.id]);

    if (payment.status !== "submitted") {
      throw Err.conflict(`Payment status is '${payment.status}', must be 'submitted' to confirm.`);
    }

    // Validate allocations.
    const totalAllocated = input.allocations.reduce((sum, a) => sum + a.amount, 0);
    const submittedAmount = parseFloat(payment.submitted_amount);
    if (totalAllocated > submittedAmount) {
      throw Err.conflict(
        `Allocation sum (${totalAllocated}) exceeds payment amount (${submittedAmount}).`,
      );
    }

    // Verify each allocation's package belongs to the same academy.
    for (const alloc of input.allocations) {
      await loadStudentPackageInAcademy(tx, alloc.studentPackageId, academyId);
      if (alloc.amount <= 0) {
        throw Err.validation("Allocation amount must be positive.");
      }
    }

    // Confirm the payment.
    await tx.query(
      `UPDATE payments
          SET status = 'confirmed', reviewed_by = $2, reviewed_at = now(), reviewer_note = $3, updated_at = now()
        WHERE id = $1;`,
      [payment.id, principal.userId, input.reviewerNote ?? null],
    );

    // Create allocations.
    for (const alloc of input.allocations) {
      await tx.query(
        `INSERT INTO payment_allocations
           (id, payment_id, student_package_id, amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (payment_id, student_package_id) DO NOTHING;`,
        [newId(), payment.id, alloc.studentPackageId, alloc.amount],
      );
    }

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "payment.confirm",
      targetType: "payments",
      targetId: payment.id,
      before: { status: "submitted" },
      after: { status: "confirmed", totalAllocated, allocationCount: input.allocations.length },
      reason: input.reviewerNote,
    });
  });
}

// === Stage 5: Manual payment workflow ====================================

/** Maximum retry attempts for SERIALIZABLE conflicts (40001/40P01). */
const MAX_IDEMPOTENT_RETRIES = 3;

export interface RecordPaymentInput {
  studentId: string;
  packagePlanId: string;
  /** Actual amount received, strictly positive (IDR). */
  amount: number;
  paymentMethod: "cash" | "bank_transfer";
  /** ISO date string (YYYY-MM-DD). */
  paymentDate: string;
  /** Linked guardian user (academy-scoped). Mutually exclusive with payerName. */
  payerGuardianUserId?: string;
  /** Manual payer name when no linked guardian. Mutually exclusive with payerGuardianUserId. */
  payerName?: string;
  referenceNumber?: string;
  notes?: string;
  /** Client-generated idempotency key (required). */
  idempotencyKey: string;
}

export interface RecordPaymentResult {
  paymentId: string;
  packageId: string;
  entitlementIds: string[];
  message: string;
  /** True if this was an idempotent replay (no new records created). */
  replayed: boolean;
}

export interface PaymentDetailsRow {
  id: string;
  studentId: string;
  studentName: string;
  payerName: string | null;
  paymentMethod: string;
  amount: string; // numeric(12,2) returned as string by the driver
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  status: string;
  packageId: string | null;
  packageName: string | null;
  sessionCount: number | null;
  recordedAt: string;
}

/**
 * Stable serialization of the request body for idempotency hashing.
 * Recursively sorts object keys so key order does not affect the hash.
 * Excludes the `idempotencyKey` itself (it's the lookup key, not body content).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k !== "idempotencyKey").sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Compute the SHA-256 body hash for idempotency comparison. */
export function computeBodyHash(input: RecordPaymentInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/**
 * Record a manual payment + atomic package purchase. Single SERIALIZABLE
 * transaction creates: payment (status='confirmed'), payment_allocation,
 * student_package, exactly N session_entitlements, N 'created' events,
 * and an audit event. Any failure rolls back all of them.
 *
 * Idempotency: the client supplies an `idempotencyKey` + the full body.
 * The body hash is stored alongside the key.
 *   - Same key + same hash → return original result (no new records).
 *   - Same key + different hash → 409 IDEMPOTENCY_KEY_REUSE (non-retryable).
 *
 * Concurrency: under SERIALIZABLE, concurrent duplicate requests may
 * abort with 40001/40P01. This function retries the ENTIRE transaction
 * up to MAX_IDEMPOTENT_RETRIES times. Before each retry, it re-checks the
 * idempotency key in a fresh transaction (the first SELECT inside the
 * new tx). If a winner committed, the retry returns the original result.
 *
 * Real PostgreSQL concurrency NOT verified in this environment (Docker
 * unavailable — see tests/integration/pg/pg-payments-idempotency.test.ts,
 * skip-labeled). The design is correct by inspection.
 */
export async function recordPayment(
  principal: Principal,
  academyId: string,
  input: RecordPaymentInput,
  db: DbClient = getDb(),
): Promise<RecordPaymentResult> {
  requireAcademyContext(principal, academyId);

  // Pre-tx validation (correction #1: strictly positive amount).
  if (!input.amount || input.amount <= 0) {
    throw Err.validation("Payment amount must be greater than zero.");
  }
  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    throw Err.validation("idempotencyKey is required.");
  }
  // Payer: exactly one of guardian or name.
  if (input.payerGuardianUserId && input.payerName && input.payerName.trim() !== "") {
    throw Err.validation("Provide either payerGuardianUserId or payerName, not both.");
  }
  if (!input.payerGuardianUserId && (!input.payerName || input.payerName.trim() === "")) {
    throw Err.validation("Either payerGuardianUserId or a non-empty payerName is required.");
  }

  const bodyHash = computeBodyHash(input);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_IDEMPOTENT_RETRIES; attempt++) {
    try {
      return await db.withTxSerializable(async (tx) => {
        // 1. Re-check idempotency key FIRST (fresh tx on each retry).
        //    If a winner committed in a previous attempt, return its result.
        const existing = await tx.query<{ id: string; idempotency_body_hash: string }>(
          `SELECT id, idempotency_body_hash
             FROM payments
            WHERE academy_id = $1 AND idempotency_key = $2
            LIMIT 1;`,
          [academyId, input.idempotencyKey],
        );
        const existingRow = existing.rows[0] as { id: string; idempotency_body_hash: string } | undefined;
        if (existingRow) {
          if (existingRow.idempotency_body_hash === bodyHash) {
            // Idempotent replay — return original result, no new records.
            return await loadPaymentResult(tx, academyId, existingRow.id, true);
          }
          // Same key, different body → reject (non-retryable).
          throw Err.conflict(
            "Idempotency key was already used with different request data.",
            "idempotency_key_reuse",
          );
        }

        // 2. Validate academy scoping (inside tx for consistency).
        await loadStudentInAcademy(tx, input.studentId, academyId);

        // Resolve + validate the linked guardian (if provided).
        let payerUserId: string | null = null;
        if (input.payerGuardianUserId) {
          const guardianResult = await tx.query<{ guardian_user_id: string }>(
            `SELECT gsl.guardian_user_id
               FROM guardian_student_links gsl
               JOIN students s ON s.id = gsl.student_id
              WHERE gsl.guardian_user_id = $1
                AND gsl.student_id = $2
                AND s.academy_id = $3
              LIMIT 1;`,
            [input.payerGuardianUserId, input.studentId, academyId],
          );
          if (!guardianResult.rows[0]) {
            throw Err.notFound("Linked guardian not found for this student in this academy.");
          }
          payerUserId = input.payerGuardianUserId;
        }

        // 3. INSERT payment with ON CONFLICT DO NOTHING.
        //    Under SERIALIZABLE, a concurrent winner would typically abort
        //    this tx first (40001). The ON CONFLICT handles the rare case
        //    where the unique index fires before the serialization check.
        //    Notes are persisted here in the same tx as the payment.
        const insertResult = await tx.query<{ id: string }>(
          `INSERT INTO payments
             (id, academy_id, payer_user_id, student_id, submitted_amount, currency,
              status, reviewed_by, reviewed_at, payer_name, payment_method,
              reference_number, payment_date, recorded_by, notes,
              idempotency_key, idempotency_body_hash)
           VALUES ($1, $2, $3, $4, $5, 'IDR', 'confirmed', $6, now(), $7, $8, $9, $10, $6, $11,
                   $12, $13)
           ON CONFLICT (academy_id, idempotency_key) WHERE idempotency_key IS NOT NULL
           DO NOTHING
           RETURNING id;`,
          [
            newId(),
            academyId,
            payerUserId,
            input.studentId,
            input.amount,
            principal.userId,
            input.payerName ?? null,
            input.paymentMethod,
            input.referenceNumber ?? null,
            input.paymentDate,
            input.notes ?? null,
            input.idempotencyKey,
            bodyHash,
          ],
        );

        if (insertResult.rows.length === 0) {
          // ON CONFLICT fired — another tx won the race. Re-check the winner.
          const winner = await tx.query<{ id: string; idempotency_body_hash: string }>(
            `SELECT id, idempotency_body_hash
               FROM payments
              WHERE academy_id = $1 AND idempotency_key = $2
              LIMIT 1;`,
            [academyId, input.idempotencyKey],
          );
          const winnerRow = winner.rows[0] as { id: string; idempotency_body_hash: string } | undefined;
          if (winnerRow) {
            if (winnerRow.idempotency_body_hash === bodyHash) {
              return await loadPaymentResult(tx, academyId, winnerRow.id, true);
            }
            throw Err.conflict(
              "Idempotency key was already used with different request data.",
              "idempotency_key_reuse",
            );
          }
          // Winner not found (shouldn't happen) — force a retryable conflict.
          throw Err.conflict("Idempotency conflict could not be resolved — retry.", "retryable");
        }

        const paymentId = (insertResult.rows[0] as { id: string }).id;

        // 4. Atomic package purchase (reuses the existing domain logic).
        const pkg = await purchasePackageInTx(tx, principal, academyId, {
          studentId: input.studentId,
          packagePlanId: input.packagePlanId,
        });

        // 5. Payment allocation (full amount → the new package).
        await tx.query(
          `INSERT INTO payment_allocations (id, payment_id, student_package_id, amount)
           VALUES ($1, $2, $3, $4);`,
          [newId(), paymentId, pkg.packageId, input.amount],
        );

        // 6. Audit (same tx as the payment + package).
        await writeAudit({
          tx,
          academyId,
          actorUserId: principal.userId,
          action: "payment.record",
          targetType: "payments",
          targetId: paymentId,
          after: {
            studentId: input.studentId,
            packagePlanId: input.packagePlanId,
            packageId: pkg.packageId,
            amount: input.amount,
            paymentMethod: input.paymentMethod,
            paymentDate: input.paymentDate,
            entitlementCount: pkg.entitlementIds.length,
          },
        });

        // 7. Generate the WhatsApp-ready message (pure read inside the tx).
        const message = await generatePaymentConfirmationMessage(tx, academyId, paymentId);

        return {
          paymentId,
          packageId: pkg.packageId,
          entitlementIds: pkg.entitlementIds,
          message,
          replayed: false,
        };
      });
    } catch (err) {
      // Non-retryable: idempotency-key-reuse, validation, not-found, etc.
      if (isIdempotencyReuseError(err)) throw err;
      // Retryable serialization conflict → retry with a fresh tx.
      if (isRetryableConflict(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  // Retries exhausted — surface the retryable conflict to the caller.
  // handleApiRequest will set Retry-After. We do NOT claim success.
  throw lastErr instanceof Error
    ? lastErr
    : Err.conflict("Retryable conflict — retries exhausted.", "retryable");
}

function isIdempotencyReuseError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code: string }).code === "CONFLICT" &&
    "detail" in err &&
    (err as { detail?: string }).detail === "idempotency_key_reuse"
  );
}

/**
 * Load an existing payment's result (for idempotent replay). Reads the
 * allocation → package → entitlements + generates the message.
 */
async function loadPaymentResult(
  tx: TxClient,
  academyId: string,
  paymentId: string,
  replayed: boolean,
): Promise<RecordPaymentResult> {
  const allocResult = await tx.query<{ student_package_id: string }>(
    `SELECT pa.student_package_id
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
      WHERE pa.payment_id = $1 AND p.academy_id = $2
      LIMIT 1;`,
    [paymentId, academyId],
  );
  const packageId = (allocResult.rows[0] as { student_package_id: string } | undefined)?.student_package_id;
  if (!packageId) {
    throw Err.notFound("Payment allocation not found for this payment.");
  }

  const entResult = await tx.query<{ id: string }>(
    `SELECT id FROM session_entitlements WHERE student_package_id = $1 ORDER BY sequence;`,
    [packageId],
  );
  const entitlementIds = (entResult.rows as { id: string }[]).map((r) => r.id);

  const message = await generatePaymentConfirmationMessage(tx, academyId, paymentId);

  return { paymentId, packageId, entitlementIds, message, replayed };
}

// === Payment confirmation message (Indonesian, copy-only) ===============

/**
 * Generate an Indonesian WhatsApp-ready payment-confirmation message.
 * Uses REAL assigned occurrence dates; unassigned sessions are clearly
 * marked "(belum dijadwalkan)". Never invents dates. Pure read, no side
 * effects, no persistence.
 *
 * Format:
 *   Konfirmasi Pembayaran — [Academy]
 *
 *   Siswa: [Student name]
 *   Paket: [Plan name] — [N] sesi
 *   Jumlah Dibayar: Rp [amount] ([method], [date])
 *
 *   Jadwal Sesi:
 *   - Sesi 1: [dd MMM yyyy], [HH:mm] ✓
 *   - Sesi 2: (belum dijadwalkan)
 *   ...
 *
 *   Terima kasih.
 */
export async function generatePaymentConfirmationMessage(
  db: DbClient | TxClient,
  academyId: string,
  paymentId: string,
): Promise<string> {
  const paymentResult = await db.query<{
    amount: string;
    payment_method: string;
    payment_date: Date | string;
    student_name: string;
    plan_name: string;
    session_count: number;
    academy_name: string;
  }>(
    `SELECT p.submitted_amount AS amount, p.payment_method, p.payment_date,
            s.full_name AS student_name, pp.name AS plan_name,
            pp.session_count, a.name AS academy_name
       FROM payments p
       JOIN students s ON s.id = p.student_id
       JOIN payment_allocations pa ON pa.payment_id = p.id
       JOIN student_packages sp ON sp.id = pa.student_package_id
       JOIN package_plans pp ON pp.id = sp.package_plan_id
       JOIN academies a ON a.id = p.academy_id
      WHERE p.id = $1 AND p.academy_id = $2
      LIMIT 1;`,
    [paymentId, academyId],
  );
  const p = paymentResult.rows[0] as
    | { amount: string; payment_method: string; payment_date: Date | string; student_name: string; plan_name: string; session_count: number; academy_name: string }
    | undefined;
  if (!p) throw Err.notFound("Payment not found in this academy.");

  // Load entitlements + occurrence dates (LEFT JOIN so unassigned show NULL).
  const entResult = await db.query<{
    sequence: number;
    occurrence_date: Date | string | null;
    start_at: Date | string | null;
  }>(
    `SELECT e.sequence, tocc.occurrence_date, tocc.start_at
       FROM session_entitlements e
       JOIN payment_allocations pa ON pa.student_package_id = e.student_package_id
       LEFT JOIN training_occurrences tocc ON tocc.id = e.assigned_occurrence_id
      WHERE pa.payment_id = $1
      ORDER BY e.sequence;`,
    [paymentId],
  );
  const entitlements = entResult.rows as {
    sequence: number;
    occurrence_date: Date | string | null;
    start_at: Date | string | null;
  }[];

  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const formatDate = (d: Date | string | null): string | null => {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return null;
    const day = String(date.getUTCDate()).padStart(2, "0");
    const month = months[date.getUTCMonth()] ?? "?";
    const year = date.getUTCFullYear();
    return `${day} ${month} ${year}`;
  };
  const formatTime = (d: Date | string | null): string | null => {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return null;
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mm = String(date.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const lines: string[] = [];
  lines.push(`Konfirmasi Pembayaran — ${p.academy_name}`);
  lines.push("");
  lines.push(`Siswa: ${p.student_name}`);
  lines.push(`Paket: ${p.plan_name} — ${p.session_count} sesi`);
  lines.push(`Jumlah Dibayar: Rp ${p.amount} (${p.payment_method === "cash" ? "tunai" : "transfer bank"}, ${formatDate(p.payment_date) ?? "-"})`);
  lines.push("");
  lines.push("Jadwal Sesi:");
  for (const ent of entitlements) {
    const dateStr = formatDate(ent.occurrence_date);
    const timeStr = formatTime(ent.start_at);
    if (dateStr && timeStr) {
      lines.push(`- Sesi ${ent.sequence}: ${dateStr}, ${timeStr} ✓`);
    } else {
      lines.push(`- Sesi ${ent.sequence}: (belum dijadwalkan)`);
    }
  }
  lines.push("");
  lines.push("Terima kasih.");

  return lines.join("\n");
}

// === Reads: list + detail ===============================================

/**
 * List payments for a student (academy-scoped). Returns summary rows.
 */
export async function listPaymentsForStudent(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<PaymentDetailsRow[]> {
  requireAcademyContext(principal, academyId);
  await loadStudentInAcademy(db, studentId, academyId);

  const result = await db.query<PaymentDetailsRow>(
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
      WHERE p.student_id = $1 AND p.academy_id = $2
      ORDER BY p.created_at DESC;`,
    [studentId, academyId],
  );
  return result.rows as PaymentDetailsRow[];
}

/**
 * Get a single payment's details (academy-scoped). Cross-academy → 404.
 */
export async function getPaymentDetails(
  principal: Principal,
  academyId: string,
  paymentId: string,
  db: DbClient = getDb(),
): Promise<PaymentDetailsRow> {
  requireAcademyContext(principal, academyId);
  const result = await db.query<PaymentDetailsRow>(
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
      WHERE p.id = $1 AND p.academy_id = $2
      LIMIT 1;`,
    [paymentId, academyId],
  );
  const row = result.rows[0] as PaymentDetailsRow | undefined;
  if (!row) throw Err.notFound("Payment not found in this academy.");
  return row;
}
