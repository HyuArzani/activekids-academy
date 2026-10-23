/**
 * Domain: Reports.
 *
 * Read-only aggregate queries for the admin Reports UI. Three report types:
 *
 *   1. Student Roster Report — all students in the academy with their
 *      enrollment, package, and entitlement status summary.
 *   2. Per-Student Attendance Report — attendance history for a single
 *      student with status breakdown.
 *   3. Monthly Financial Report — revenue + expenses + net for a date
 *      range, with payment and expense line items.
 *
 * All queries are academy-scoped and admin-role-only. No mutations.
 *
 * Server-only. Never import from client code.
 */

import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";
import { requireAcademyContext } from "./helpers";

// ============================================================================
// Student Roster Report
// ============================================================================

export interface StudentRosterEntry {
  studentId: string;
  fullName: string;
  dateOfBirth: Date | null;
  gender: string | null;
  archivedAt: Date | null;
  /** Current active enrollment (effective_to IS NULL), null if none. */
  currentClassName: string | null;
  currentClassId: string | null;
  /** Total packages purchased. */
  packageCount: number;
  /** Count of active entitlements (remaining usable sessions). */
  activeEntitlements: number;
  /** Count of completed entitlements. */
  completedEntitlements: number;
  /** Count of skipped + awaiting_makeup entitlements. */
  awaitingMakeupEntitlements: number;
  /** Last attendance date (YYYY-MM-DD), null if never attended. */
  lastAttendedDate: string | null;
  /** Last attendance status (present/absent/excused/late), null if never. */
  lastAttendedStatus: string | null;
}

export interface StudentRosterReport {
  students: StudentRosterEntry[];
  totalStudents: number;
  activeStudents: number;
  archivedStudents: number;
}

/**
 * Get the student roster report for an academy. Includes enrollment,
 * package, and entitlement summary for each student.
 *
 * Academy-scoped. Admin-role-only.
 */
export async function getStudentRosterReport(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<StudentRosterReport> {
  requireAcademyContext(principal, academyId);
  void principal; // already validated by requireAcademyContext

  const result = await db.query<StudentRosterEntry>(
    `SELECT s.id AS "studentId",
            s.full_name AS "fullName",
            s.date_of_birth AS "dateOfBirth",
            s.gender,
            s.archived_at AS "archivedAt",
            (SELECT c.name FROM student_enrollments se_inner JOIN classes c ON c.id = se_inner.class_id WHERE se_inner.student_id = s.id AND se_inner.effective_to IS NULL LIMIT 1) AS "currentClassName",
            (SELECT se_inner.class_id FROM student_enrollments se_inner WHERE se_inner.student_id = s.id AND se_inner.effective_to IS NULL LIMIT 1) AS "currentClassId",
            (SELECT COUNT(*)::int FROM student_packages sp WHERE sp.student_id = s.id) AS "packageCount",
            (SELECT COUNT(*)::int FROM session_entitlements e JOIN student_packages sp ON sp.id = e.student_package_id WHERE sp.student_id = s.id AND e.status = 'active') AS "activeEntitlements",
            (SELECT COUNT(*)::int FROM session_entitlements e JOIN student_packages sp ON sp.id = e.student_package_id WHERE sp.student_id = s.id AND e.status = 'completed') AS "completedEntitlements",
            (SELECT COUNT(*)::int FROM session_entitlements e JOIN student_packages sp ON sp.id = e.student_package_id WHERE sp.student_id = s.id AND e.status IN ('skipped', 'awaiting_makeup')) AS "awaitingMakeupEntitlements",
            to_char((SELECT tocc.occurrence_date FROM attendance_records ar JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id WHERE ar.student_id = s.id ORDER BY tocc.occurrence_date DESC LIMIT 1), 'YYYY-MM-DD') AS "lastAttendedDate",
            (SELECT ar.status FROM attendance_records ar JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id WHERE ar.student_id = s.id ORDER BY tocc.occurrence_date DESC LIMIT 1) AS "lastAttendedStatus"
       FROM students s
      WHERE s.academy_id = $1
      ORDER BY s.full_name;`,
    [academyId],
  );

  const students = result.rows as StudentRosterEntry[];
  const archivedStudents = students.filter((s) => s.archivedAt !== null).length;
  return {
    students,
    totalStudents: students.length,
    activeStudents: students.length - archivedStudents,
    archivedStudents,
  };
}

// ============================================================================
// Per-Student Attendance Report
// ============================================================================

export interface AttendanceReportEntry {
  attendanceId: string;
  occurrenceDate: string; // YYYY-MM-DD
  className: string;
  startAt: string; // ISO
  status: string;
  legacyStatus: string | null;
  notes: string | null;
  recordedAt: string; // ISO
}

export interface AttendanceReportSummary {
  total: number;
  present: number;
  absent: number;
  excused: number;
  late: number;
  /** Attendance rate = present+late / total (0 if no records). */
  attendanceRate: number;
}

export interface PerStudentAttendanceReport {
  studentId: string;
  studentName: string;
  records: AttendanceReportEntry[];
  summary: AttendanceReportSummary;
}

/**
 * Get the per-student attendance report. Returns all attendance records
 * for the student with a status breakdown summary.
 *
 * Academy-scoped (via student → academy). Admin-role-only.
 */
export async function getPerStudentAttendanceReport(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<PerStudentAttendanceReport> {
  requireAcademyContext(principal, academyId);
  void principal;

  // Verify student is in this academy (cross-academy → NOT_FOUND).
  const studentResult = await db.query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM students WHERE id = $1 AND academy_id = $2 LIMIT 1;`,
    [studentId, academyId],
  );
  const student = studentResult.rows[0] as { id: string; full_name: string } | undefined;
  if (!student) {
    throw Err.notFound("Student not found in this academy.");
  }

  const result = await db.query<AttendanceReportEntry>(
    `SELECT ar.id AS "attendanceId",
            to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS "occurrenceDate",
            c.name AS "className",
            to_char(tocc.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startAt",
            ar.status,
            ar.legacy_status AS "legacyStatus",
            ar.notes,
            to_char(ar.recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "recordedAt"
       FROM attendance_records ar
       JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
       JOIN classes c ON c.id = tocc.class_id
      WHERE ar.student_id = $1
        AND tocc.academy_id = $2
      ORDER BY tocc.occurrence_date DESC, tocc.start_at DESC;`,
    [studentId, academyId],
  );

  const records = result.rows as AttendanceReportEntry[];
  const summary: AttendanceReportSummary = {
    total: records.length,
    present: records.filter((r) => r.status === "present" && r.legacyStatus !== "late").length,
    absent: records.filter((r) => r.status === "absent").length,
    excused: records.filter((r) => r.status === "excused").length,
    late: records.filter((r) => r.legacyStatus === "late").length,
    attendanceRate: 0,
  };
  summary.attendanceRate =
    summary.total > 0
      ? Math.round(((summary.present + summary.late) / summary.total) * 100)
      : 0;

  return {
    studentId,
    studentName: student.full_name,
    records,
    summary,
  };
}

// ============================================================================
// Monthly Financial Report
// ============================================================================

export interface FinanceReportPayment {
  paymentId: string;
  studentName: string;
  amount: string;
  paymentDate: string;
  paymentMethod: string;
  status: string;
  packageName: string | null;
}

export interface FinanceReportExpense {
  expenseId: string;
  amount: string;
  category: string;
  incurredOn: string;
  note: string | null;
}

export interface FinanceReportSummary {
  totalIncome: string;
  totalExpenses: string;
  net: string;
  paymentCount: number;
  expenseCount: number;
  /** Breakdown by payment method. */
  byMethod: { method: string; count: number; total: string }[];
  /** Breakdown by expense category. */
  byCategory: { category: string; count: number; total: string }[];
}

export interface MonthlyFinanceReport {
  fromDate: string;
  toDate: string;
  payments: FinanceReportPayment[];
  expenses: FinanceReportExpense[];
  summary: FinanceReportSummary;
}

/**
 * Get the monthly financial report for an academy. Returns all payments
 * and expenses in the date range with a summary breakdown.
 *
 * Academy-scoped. Admin-role-only.
 */
export async function getMonthlyFinanceReport(
  principal: Principal,
  academyId: string,
  fromDate: string,
  toDate: string,
  db: DbClient = getDb(),
): Promise<MonthlyFinanceReport> {
  requireAcademyContext(principal, academyId);
  void principal;

  if (toDate < fromDate) {
    throw Err.validation("toDate must be on or after fromDate.");
  }

  // Fetch payments.
  const paymentsResult = await db.query<FinanceReportPayment>(
    `SELECT p.id AS "paymentId",
            s.full_name AS "studentName",
            p.submitted_amount::text AS "amount",
            to_char(p.payment_date, 'YYYY-MM-DD') AS "paymentDate",
            p.payment_method AS "paymentMethod",
            p.status,
            pp.name AS "packageName"
       FROM payments p
       JOIN students s ON s.id = p.student_id
  LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
  LEFT JOIN student_packages sp ON sp.id = pa.student_package_id
  LEFT JOIN package_plans pp ON pp.id = sp.package_plan_id
      WHERE p.academy_id = $1
        AND p.payment_date >= $2
        AND p.payment_date <= $3
      ORDER BY p.payment_date DESC, p.created_at DESC;`,
    [academyId, fromDate, toDate],
  );

  // Fetch expenses.
  const expensesResult = await db.query<FinanceReportExpense>(
    `SELECT e.id AS "expenseId",
            e.amount::text AS "amount",
            e.category,
            to_char(e.incurred_on, 'YYYY-MM-DD') AS "incurredOn",
            e.note
       FROM academy_expenses e
      WHERE e.academy_id = $1
        AND e.incurred_on >= $2
        AND e.incurred_on <= $3
      ORDER BY e.incurred_on DESC, e.created_at DESC;`,
    [academyId, fromDate, toDate],
  );

  const payments = paymentsResult.rows as FinanceReportPayment[];
  const expenses = expensesResult.rows as FinanceReportExpense[];

  // Compute summary.
  const totalIncome = payments
    .filter((p) => p.status === "confirmed")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const net = totalIncome - totalExpenses;

  // Breakdown by payment method.
  const methodMap = new Map<string, { count: number; total: number }>();
  for (const p of payments.filter((p) => p.status === "confirmed")) {
    const entry = methodMap.get(p.paymentMethod) ?? { count: 0, total: 0 };
    entry.count++;
    entry.total += Number(p.amount);
    methodMap.set(p.paymentMethod, entry);
  }
  const byMethod = Array.from(methodMap.entries()).map(([method, v]) => ({
    method,
    count: v.count,
    total: v.total.toFixed(2),
  }));

  // Breakdown by expense category.
  const categoryMap = new Map<string, { count: number; total: number }>();
  for (const e of expenses) {
    const entry = categoryMap.get(e.category) ?? { count: 0, total: 0 };
    entry.count++;
    entry.total += Number(e.amount);
    categoryMap.set(e.category, entry);
  }
  const byCategory = Array.from(categoryMap.entries()).map(([category, v]) => ({
    category,
    count: v.count,
    total: v.total.toFixed(2),
  }));

  return {
    fromDate,
    toDate,
    payments,
    expenses,
    summary: {
      totalIncome: totalIncome.toFixed(2),
      totalExpenses: totalExpenses.toFixed(2),
      net: net.toFixed(2),
      paymentCount: payments.length,
      expenseCount: expenses.length,
      byMethod,
      byCategory,
    },
  };
}
