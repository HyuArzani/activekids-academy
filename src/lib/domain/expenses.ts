/**
 * Domain: Academy expenses (cash outflow).
 *
 * Stage 5: Admin records expenses with amount, free-text category
 * (incl. "refund"), date, note, and optional related_payment_id for
 * refund traceability.
 *
 * Key rules:
 *   - "refund" is just a category string — recording a refund expense
 *     does NOT mutate the referenced payment's status, the package,
 *     entitlements, or attendance. It's a financial record only.
 *   - related_payment_id, when provided, must reference a payment in
 *     the SAME academy (cross-academy → NOT_FOUND before insert).
 *   - PATCH is restricted to note/description only. Amount, category,
 *     incurred_on, related_payment_id are immutable post-create.
 *     Financial corrections use a new compensating expense row.
 *   - All mutations run in SERIALIZABLE transactions with audit events.
 *
 * Academy scoping: every read/write filters by academy_id.
 *
 * Server-only. Never import from client code.
 */

import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  newId,
} from "./helpers";

export interface RecordExpenseInput {
  amount: number;
  category: string;
  /** ISO date (YYYY-MM-DD). */
  incurredOn: string;
  note?: string;
  /** Optional: the payment this refund relates to (same academy). */
  relatedPaymentId?: string;
}

export interface ExpenseRow {
  id: string;
  amount: string; // numeric(12,2) as string
  category: string;
  incurredOn: string;
  note: string | null;
  relatedPaymentId: string | null;
  createdBy: string;
  createdAt: string;
}

/**
 * Record an academy expense. SERIALIZABLE tx + audit.
 *
 * If relatedPaymentId is provided, validates the payment belongs to the
 * same academy (cross-academy → NOT_FOUND). The expense row references
 * the payment for traceability — it does NOT mutate the payment, the
 * package, entitlements, or attendance.
 */
export async function recordExpense(
  principal: Principal,
  academyId: string,
  input: RecordExpenseInput,
  db: DbClient = getDb(),
): Promise<{ expenseId: string }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!input.amount || input.amount < 0) {
    throw Err.validation("Expense amount must be non-negative.");
  }
  if (!input.category || input.category.trim() === "") {
    throw Err.validation("Category is required.");
  }
  if (!input.incurredOn || input.incurredOn.trim() === "") {
    throw Err.validation("Incurred-on date is required.");
  }

  return db.withTxSerializable(async (tx) => {
    // If relatedPaymentId provided, validate same-academy.
    if (input.relatedPaymentId) {
      const payResult = await tx.query<{ id: string }>(
        `SELECT id FROM payments WHERE id = $1 AND academy_id = $2 LIMIT 1;`,
        [input.relatedPaymentId, academyId],
      );
      if (!payResult.rows[0]) {
        throw Err.notFound("Related payment not found in this academy.");
      }
    }

    const id = newId();
    await tx.query(
      `INSERT INTO academy_expenses
         (id, academy_id, category, amount, currency, incurred_on, note,
          created_by, related_payment_id)
       VALUES ($1, $2, $3, $4, 'IDR', $5, $6, $7, $8);`,
      [
        id,
        academyId,
        input.category,
        input.amount,
        input.incurredOn,
        input.note ?? null,
        principal.userId,
        input.relatedPaymentId ?? null,
      ],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "expense.record",
      targetType: "academy_expenses",
      targetId: id,
      after: {
        amount: input.amount,
        category: input.category,
        incurredOn: input.incurredOn,
        relatedPaymentId: input.relatedPaymentId ?? null,
      },
    });

    return { expenseId: id };
  });
}

/**
 * List expenses in a date range (academy-scoped).
 */
export async function listExpenses(
  principal: Principal,
  academyId: string,
  fromDate: string,
  toDate: string,
  db: DbClient = getDb(),
): Promise<ExpenseRow[]> {
  requireAcademyContext(principal, academyId);

  if (new Date(toDate) < new Date(fromDate)) {
    throw Err.validation("toDate must be on or after fromDate.");
  }

  const result = await db.query<ExpenseRow>(
    `SELECT e.id, e.amount::text AS "amount", e.category,
            to_char(e.incurred_on, 'YYYY-MM-DD') AS "incurredOn",
            e.note, e.related_payment_id AS "relatedPaymentId",
            e.created_by AS "createdBy",
            to_char(e.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
       FROM academy_expenses e
      WHERE e.academy_id = $1
        AND e.incurred_on >= $2
        AND e.incurred_on <= $3
      ORDER BY e.incurred_on DESC, e.created_at DESC;`,
    [academyId, fromDate, toDate],
  );
  return result.rows as ExpenseRow[];
}

/**
 * Get a single expense (academy-scoped). Cross-academy → 404.
 */
export async function getExpense(
  principal: Principal,
  academyId: string,
  expenseId: string,
  db: DbClient = getDb(),
): Promise<ExpenseRow> {
  requireAcademyContext(principal, academyId);
  const result = await db.query<ExpenseRow>(
    `SELECT e.id, e.amount::text AS "amount", e.category,
            to_char(e.incurred_on, 'YYYY-MM-DD') AS "incurredOn",
            e.note, e.related_payment_id AS "relatedPaymentId",
            e.created_by AS "createdBy",
            to_char(e.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
       FROM academy_expenses e
      WHERE e.id = $1 AND e.academy_id = $2
      LIMIT 1;`,
    [expenseId, academyId],
  );
  const row = result.rows[0] as ExpenseRow | undefined;
  if (!row) throw Err.notFound("Expense not found in this academy.");
  return row;
}

/**
 * Update an expense's note/description only. Amount, category,
 * incurred_on, and related_payment_id are IMMUTABLE post-create.
 * Financial corrections require a new compensating expense row.
 */
export async function updateExpenseNote(
  principal: Principal,
  academyId: string,
  expenseId: string,
  note: string | null,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  return db.withTxSerializable(async (tx) => {
    // Lock + load the expense (academy-scoped).
    const result = await tx.query<{ id: string; note: string | null }>(
      `SELECT id, note FROM academy_expenses WHERE id = $1 AND academy_id = $2 LIMIT 1;`,
      [expenseId, academyId],
    );
    const row = result.rows[0] as { id: string; note: string | null } | undefined;
    if (!row) throw Err.notFound("Expense not found in this academy.");
    await tx.query(`SELECT id FROM academy_expenses WHERE id = $1 FOR UPDATE;`, [row.id]);

    const beforeState = { note: row.note };

    await tx.query(
      `UPDATE academy_expenses SET note = $2, updated_at = now() WHERE id = $1;`,
      [row.id, note],
    );

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "expense.update",
      targetType: "academy_expenses",
      targetId: row.id,
      before: beforeState,
      after: { note },
    });
  });
}
