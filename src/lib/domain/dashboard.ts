/**
 * Domain: Dashboard quota reminders.
 *
 * Stage 5: A live, database-backed Admin endpoint that groups reminders
 * by student and avoids duplicate entries. Returns THREE distinct,
 * mutually-exclusive lists based on actual entitlement states:
 *
 *   1. exhausted       — no active AND no pending-makeup entitlements,
 *                        with completed or cancelled history.
 *   2. makeupNeeded    — no active entitlements but ≥1 skipped or
 *                        awaiting_makeup entitlement.
 *   3. schedulingNeeded — ≥1 active entitlement that is unassigned
 *                        (assigned_occurrence_id IS NULL).
 *
 * Correction #3: a student with NO package/entitlement history is NOT
 * classified as "exhausted" merely because their counts are zero. The
 * INNER JOIN on session_entitlements means only students with at least
 * one entitlement row appear. A student with zero entitlements appears
 * in NONE of the lists.
 *
 * Entitlement state rules (from the actual implementation):
 *   active + assigned      → usable
 *   active + unassigned    → usable + unassigned (→ schedulingNeeded)
 *   skipped                → pending makeup (→ makeupNeeded)
 *   awaiting_makeup       → pending makeup (→ makeupNeeded)
 *   completed             → not usable, not pending (counts toward exhausted)
 *   cancelled             → not usable, not pending (counts toward exhausted)
 *
 * The three lists are mutually exclusive by construction:
 *   - exhausted requires active=0 AND pending=0
 *   - makeupNeeded requires active=0 AND pending>0
 *   - schedulingNeeded requires active>0 (and unassigned_active>0)
 * A student with active>0 but all assigned appears in NONE (they're fine).
 *
 * Aggregation: GROUP BY student_id, summing across the student's
 * packages in the academy. A student with multiple packages appears
 * once per list (or once in no list).
 *
 * No cron, no cache, no auto-send. The endpoint is a live read.
 *
 * Server-only. Never import from client code.
 */

import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import type { Principal } from "@/lib/auth/principal";
import { requireAcademyContext } from "./helpers";

export interface QuotaReminderStudent {
  studentId: string;
  studentName: string;
  primaryGuardianName: string | null;
  primaryGuardianPhone: string | null;
  activeCount: number;
  pendingMakeupCount: number;
  completedCount: number;
  cancelledCount: number;
  unassignedActiveCount: number;
  reminderText: string;
}

export interface QuotaReminders {
  exhausted: QuotaReminderStudent[];
  makeupNeeded: QuotaReminderStudent[];
  schedulingNeeded: QuotaReminderStudent[];
}

const MONTHS_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
];

function formatTodayId(): string {
  const d = new Date();
  return `${d.getUTCDate()} ${MONTHS_ID[d.getUTCMonth() ?? 0]} ${d.getUTCFullYear()}`;
}

/**
 * Get the three quota-reminder lists (academy-scoped).
 */
export async function getQuotaReminders(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<QuotaReminders> {
  requireAcademyContext(principal, academyId);

  // Single query: aggregate per student across all their packages.
  // INNER JOIN on session_entitlements excludes students with no
  // package/entitlement history (correction #3).
  const result = await db.query<{
    student_id: string;
    student_name: string;
    guardian_name: string | null;
    guardian_phone: string | null;
    active_count: number;
    pending_makeup_count: number;
    completed_count: number;
    cancelled_count: number;
    unassigned_active_count: number;
  }>(
    `SELECT s.id AS student_id, s.full_name AS student_name,
            g.full_name AS guardian_name,
            gsl.contact_phone AS guardian_phone,
            COUNT(*) FILTER (WHERE e.status = 'active') AS active_count,
            COUNT(*) FILTER (WHERE e.status IN ('skipped', 'awaiting_makeup')) AS pending_makeup_count,
            COUNT(*) FILTER (WHERE e.status = 'completed') AS completed_count,
            COUNT(*) FILTER (WHERE e.status = 'cancelled') AS cancelled_count,
            COUNT(*) FILTER (WHERE e.status = 'active' AND e.assigned_occurrence_id IS NULL) AS unassigned_active_count
       FROM session_entitlements e
       JOIN student_packages sp ON sp.id = e.student_package_id
       JOIN students s ON s.id = sp.student_id
  LEFT JOIN guardian_student_links gsl ON gsl.student_id = s.id AND gsl.is_primary = TRUE
  LEFT JOIN users g ON g.id = gsl.guardian_user_id
      WHERE s.academy_id = $1
      GROUP BY s.id, s.full_name, guardian_name, guardian_phone
      ORDER BY s.full_name;`,
    [academyId],
  );

  const rows = result.rows as {
    student_id: string;
    student_name: string;
    guardian_name: string | null;
    guardian_phone: string | null;
    active_count: number;
    pending_makeup_count: number;
    completed_count: number;
    cancelled_count: number;
    unassigned_active_count: number;
  }[];

  const exhausted: QuotaReminderStudent[] = [];
  const makeupNeeded: QuotaReminderStudent[] = [];
  const schedulingNeeded: QuotaReminderStudent[] = [];

  for (const r of rows) {
    // Mutually exclusive classification.
    if (r.active_count === 0 && r.pending_makeup_count === 0 && (r.completed_count + r.cancelled_count) > 0) {
      exhausted.push({
        studentId: r.student_id,
        studentName: r.student_name,
        primaryGuardianName: r.guardian_name,
        primaryGuardianPhone: r.guardian_phone,
        activeCount: r.active_count,
        pendingMakeupCount: r.pending_makeup_count,
        completedCount: r.completed_count,
        cancelledCount: r.cancelled_count,
        unassignedActiveCount: r.unassigned_active_count,
        reminderText: buildExhaustedText(r),
      });
    } else if (r.active_count === 0 && r.pending_makeup_count > 0) {
      makeupNeeded.push({
        studentId: r.student_id,
        studentName: r.student_name,
        primaryGuardianName: r.guardian_name,
        primaryGuardianPhone: r.guardian_phone,
        activeCount: r.active_count,
        pendingMakeupCount: r.pending_makeup_count,
        completedCount: r.completed_count,
        cancelledCount: r.cancelled_count,
        unassignedActiveCount: r.unassigned_active_count,
        reminderText: buildMakeupNeededText(r),
      });
    } else if (r.active_count > 0 && r.unassigned_active_count > 0) {
      schedulingNeeded.push({
        studentId: r.student_id,
        studentName: r.student_name,
        primaryGuardianName: r.guardian_name,
        primaryGuardianPhone: r.guardian_phone,
        activeCount: r.active_count,
        pendingMakeupCount: r.pending_makeup_count,
        completedCount: r.completed_count,
        cancelledCount: r.cancelled_count,
        unassignedActiveCount: r.unassigned_active_count,
        reminderText: buildSchedulingNeededText(r),
      });
    }
    // else: student has active entitlements all assigned, or no history →
    // appears in NONE of the lists (correct per spec).
  }

  return { exhausted, makeupNeeded, schedulingNeeded };
}

function buildExhaustedText(r: {
  student_name: string;
  guardian_name: string | null;
  completed_count: number;
  cancelled_count: number;
}): string {
  const salutation = r.guardian_name ? `Yth. Bapak/Ibu ${r.guardian_name}` : "Yth. Bapak/Ibu Wali";
  return [
    `${salutation},`,
    `putra/putri Anda ${r.student_name} telah menggunakan seluruh sesi latihan yang aktif`,
    `(${r.completed_count} sesi selesai${r.cancelled_count > 0 ? `, ${r.cancelled_count} sesi dibatalkan` : ""}).`,
    `Untuk perpanjangan paket, mohon hubungi kami. Terima kasih.`,
    `(${formatTodayId()})`,
  ].join(" ");
}

function buildMakeupNeededText(r: {
  student_name: string;
  guardian_name: string | null;
  pending_makeup_count: number;
}): string {
  const salutation = r.guardian_name ? `Yth. Bapak/Ibu ${r.guardian_name}` : "Yth. Bapak/Ibu Wali";
  return [
    `${salutation},`,
    `putra/putri Anda ${r.student_name} memiliki ${r.pending_makeup_count} sesi yang menunggu makeup.`,
    `Mohon hubungi kami untuk menjadwalkan ulang sesi tersebut. Terima kasih.`,
    `(${formatTodayId()})`,
  ].join(" ");
}

function buildSchedulingNeededText(r: {
  student_name: string;
  guardian_name: string | null;
  unassigned_active_count: number;
}): string {
  const salutation = r.guardian_name ? `Yth. Bapak/Ibu ${r.guardian_name}` : "Yth. Bapak/Ibu Wali";
  return [
    `${salutation},`,
    `putra/putri Anda ${r.student_name} memiliki ${r.unassigned_active_count} sesi aktif yang belum dijadwalkan.`,
    `Mohon hubungi kami untuk informasi jadwal. Terima kasih.`,
    `(${formatTodayId()})`,
  ].join(" ");
}

// === Stage 6A: Dashboard summary ========================================

export interface DashboardSummary {
  /** The calendar date (YYYY-MM-DD) in the academy's timezone used for "today". */
  today: string;
  /** The first day (inclusive) of the current Jakarta calendar month. */
  monthStart: string;
  /** The first day of the next month (exclusive upper bound). */
  monthEnd: string;
  students: {
    /** Distinct non-archived students with an enrollment active on today's date. */
    currentlyEnrolled: number;
    /** Distinct students whose enrollment effective_from = today (academy-scoped). */
    startingToday: number;
  };
  sessions: {
    /** Today's non-cancelled (status='planned') training occurrences. */
    scheduledToday: number;
    /** Today's attendance totals, counted only for non-cancelled occurrences. */
    attendanceToday: {
      present: number;
      absent: number;
      excused: number;
      late: number;
    };
  };
  packages: {
    /** Distinct packages with ≥1 active entitlement (remaining usable sessions). */
    withUsableSessions: number;
    /** Packages with 0 active + 0 pending-makeup entitlements but completed/cancelled history. */
    exhausted: number;
  };
  entitlements: {
    /** Entitlements in 'skipped' or 'awaiting_makeup' status. */
    awaitingMakeup: number;
    /** Entitlements in 'active' status with no assigned occurrence. */
    unassignedActive: number;
  };
  finances: {
    /** SUM(submitted_amount) for status='confirmed' payments in this month. String (numeric). */
    monthPaymentTotal: string;
    /** SUM(amount) for expenses in this month. String (numeric). */
    monthExpenseTotal: string;
  };
}

/**
 * Compute the academy-local "today" as a YYYY-MM-DD string, using the
 * Intl API with the academy's stored timezone. Returns the calendar date
 * that is "now" in that timezone.
 *
 * Also computes monthStart (first day of current month, inclusive) and
 * monthEnd (first day of next month, exclusive) for monthly reporting.
 */
function computeDateBoundaries(timezone: string): { today: string; monthStart: string; monthEnd: string } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const today = `${y}-${m}-${d}`;

  // Month boundaries in the academy's calendar.
  const yearNum = parseInt(y, 10);
  const monthNum = parseInt(m, 10); // 1-12
  const monthStart = `${y}-${m}-01`;
  // First day of next month (exclusive upper bound).
  const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
  const nextYear = monthNum === 12 ? yearNum + 1 : yearNum;
  const monthEnd = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;

  return { today, monthStart, monthEnd };
}

/**
 * Get the Admin dashboard summary (read-only, academy-scoped).
 *
 * Returns counts and monetary totals for the academy. All queries are
 * parameterized and filter by academy_id. No mutations, no audit writes.
 *
 * Date basis:
 *   - "Today" = the calendar date in the academy's stored timezone.
 *   - Monthly totals use [monthStart, monthEnd) — start-inclusive,
 *     end-exclusive, on the `payment_date` / `incurred_on` DATE columns.
 *
 * Payment total: SUM(submitted_amount) WHERE status='confirmed' (the
 *   status used by the Stage 5 manual workflow; rejected/submitted are
 *   not received money; 'refunded' is dormant — refunds are recorded as
 *   expenses, not as payment status changes).
 *
 * Expense total: SUM(amount) for all categories (incl. 'refund' — money
 *   out). No join to payments to avoid allocation multiplication.
 *
 * Join-multiplication guards:
 *   - Student counts use COUNT(DISTINCT student_id).
 *   - Payment/expense totals use no JOIN (single-table SUM).
 *   - Attendance counts JOIN attendance_records→training_occurrences
 *     but each attendance row is unique per (occurrence, student) — no
 *     multiplication.
 *   - Package counts use a GROUP BY subquery on student_package_id.
 */
export async function getDashboardSummary(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<DashboardSummary> {
  requireAcademyContext(principal, academyId);

  // 1. Load the academy timezone.
  const acadResult = await db.query<{ timezone: string }>(
    `SELECT timezone FROM academies WHERE id = $1 LIMIT 1;`,
    [academyId],
  );
  const timezone = (acadResult.rows[0] as { timezone: string } | undefined)?.timezone;
  if (!timezone) {
    // Should have been caught by requireAcademyContext, but guard anyway.
    throw new Error("Academy timezone not found");
  }

  const { today, monthStart, monthEnd } = computeDateBoundaries(timezone);

  // 2. Students: currently enrolled + starting today (1 query, two aggregates).
  // Both aggregates exclude archived students. "Starting today" requires
  // effective_from = today AND archived_at IS NULL (an archived student
  // with a same-day enrollment is not counted). COUNT(DISTINCT) prevents
  // multiple enrollment records from inflating the count.
  const studentsResult = await db.query<{ enrolled: number; starting: number }>(
    `SELECT
       COUNT(DISTINCT se.student_id) FILTER (
         WHERE se.effective_from <= $2
           AND (se.effective_to IS NULL OR se.effective_to > $2)
           AND s.archived_at IS NULL
       ) AS enrolled,
       COUNT(DISTINCT se.student_id) FILTER (
         WHERE se.effective_from = $2
           AND s.archived_at IS NULL
       ) AS starting
     FROM student_enrollments se
     JOIN students s ON s.id = se.student_id
     WHERE s.academy_id = $1;`,
    [academyId, today],
  );
  const studentsRow = (studentsResult.rows[0] ?? { enrolled: 0, starting: 0 }) as { enrolled: number; starting: number };

  // 3. Today's occurrences + attendance (1 query for occurrences, 1 for attendance).
  const occResult = await db.query<{ scheduled: number }>(
    `SELECT COUNT(*)::int AS scheduled
       FROM training_occurrences
      WHERE academy_id = $1 AND occurrence_date = $2 AND status = 'planned';`,
    [academyId, today],
  );
  const scheduledToday = (occResult.rows[0] as { scheduled: number } | undefined)?.scheduled ?? 0;

  const attResult = await db.query<{ present: number; absent: number; excused: number; late: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE ar.status = 'present' AND ar.legacy_status IS DISTINCT FROM 'late')::int AS present,
       COUNT(*) FILTER (WHERE ar.status = 'absent')::int AS absent,
       COUNT(*) FILTER (WHERE ar.status = 'excused')::int AS excused,
       COUNT(*) FILTER (WHERE ar.legacy_status = 'late')::int AS late
     FROM attendance_records ar
     JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
    WHERE tocc.academy_id = $1
      AND tocc.occurrence_date = $2
      AND tocc.status = 'planned';`,
    [academyId, today],
  );
  const attRow = (attResult.rows[0] ?? { present: 0, absent: 0, excused: 0, late: 0 }) as { present: number; absent: number; excused: number; late: number };

  // 4. Package counts: usable + exhausted (1 query, GROUP BY subquery).
  const pkgResult = await db.query<{ usable: number; exhausted: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE sub.active_count > 0)::int AS usable,
       COUNT(*) FILTER (
         WHERE sub.active_count = 0
           AND sub.pending_makeup = 0
           AND (sub.completed_count + sub.cancelled_count) > 0
       )::int AS exhausted
     FROM (
       SELECT sp.id,
         COUNT(*) FILTER (WHERE e.status = 'active')::int AS active_count,
         COUNT(*) FILTER (WHERE e.status IN ('skipped', 'awaiting_makeup'))::int AS pending_makeup,
         COUNT(*) FILTER (WHERE e.status = 'completed')::int AS completed_count,
         COUNT(*) FILTER (WHERE e.status = 'cancelled')::int AS cancelled_count
         FROM student_packages sp
         JOIN students s ON s.id = sp.student_id
         JOIN session_entitlements e ON e.student_package_id = sp.id
        WHERE s.academy_id = $1
        GROUP BY sp.id
     ) sub;`,
    [academyId],
  );
  const pkgRow = (pkgResult.rows[0] ?? { usable: 0, exhausted: 0 }) as { usable: number; exhausted: number };

  // 5. Entitlement counts: awaiting makeup + unassigned active (1 query).
  const entResult = await db.query<{ awaiting: number; unassigned: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE e.status IN ('skipped', 'awaiting_makeup'))::int AS awaiting,
       COUNT(*) FILTER (WHERE e.status = 'active' AND e.assigned_occurrence_id IS NULL)::int AS unassigned
     FROM session_entitlements e
     JOIN student_packages sp ON sp.id = e.student_package_id
     JOIN students s ON s.id = sp.student_id
    WHERE s.academy_id = $1;`,
    [academyId],
  );
  const entRow = (entResult.rows[0] ?? { awaiting: 0, unassigned: 0 }) as { awaiting: number; unassigned: number };

  // 6. Monthly payment total (no JOIN — single-table SUM, status='confirmed').
  const payResult = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(submitted_amount), 0)::numeric(12,2)::text AS total
       FROM payments
      WHERE academy_id = $1
        AND status = 'confirmed'
        AND payment_date >= $2
        AND payment_date < $3;`,
    [academyId, monthStart, monthEnd],
  );
  const monthPaymentTotal = (payResult.rows[0] as { total: string } | undefined)?.total ?? "0.00";

  // 7. Monthly expense total (no JOIN — single-table SUM, all categories).
  const expResult = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::numeric(12,2)::text AS total
       FROM academy_expenses
      WHERE academy_id = $1
        AND incurred_on >= $2
        AND incurred_on < $3;`,
    [academyId, monthStart, monthEnd],
  );
  const monthExpenseTotal = (expResult.rows[0] as { total: string } | undefined)?.total ?? "0.00";

  return {
    today,
    monthStart,
    monthEnd,
    students: {
      currentlyEnrolled: studentsRow.enrolled ?? 0,
      startingToday: studentsRow.starting ?? 0,
    },
    sessions: {
      scheduledToday,
      attendanceToday: {
        present: attRow.present ?? 0,
        absent: attRow.absent ?? 0,
        excused: attRow.excused ?? 0,
        late: attRow.late ?? 0,
      },
    },
    packages: {
      withUsableSessions: pkgRow.usable ?? 0,
      exhausted: pkgRow.exhausted ?? 0,
    },
    entitlements: {
      awaitingMakeup: entRow.awaiting ?? 0,
      unassignedActive: entRow.unassigned ?? 0,
    },
    finances: {
      monthPaymentTotal,
      monthExpenseTotal,
    },
  };
}
