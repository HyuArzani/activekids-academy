/**
 * Domain: Parent Portal read-only APIs.
 *
 * Provides secure, academy-scoped, guardian-verified reads for:
 *   - Dashboard summary (children count, upcoming sessions, recent attendance,
 *     active packages, available reports).
 *   - Children list.
 *   - Child schedule (training occurrences).
 *   - Child packages + entitlements.
 *   - Child attendance records.
 *   - Child semester reports (published only).
 *
 * Authorization: every function verifies the authenticated principal has a
 * guardian_student_links entry for the requested student. A missing or
 * revoked link returns NOT_FOUND (does not reveal whether the student exists
 * — avoids information leakage). Cross-academy access is blocked by the
 * `academy_id` filter in every query.
 *
 * Server-only. Never import from client code.
 */

import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  loadEntitlementInAcademy,
  loadStudentPackageInAcademy,
} from "./helpers";

// === Authorization helper ================================================

/**
 * Verify the principal is a guardian of the student in the academy.
 * Returns NOT_FOUND if the student doesn't exist, isn't in the academy,
 * or the principal isn't linked — does NOT reveal which condition failed.
 *
 * Does NOT filter on archived_at: archiving is a business status that
 * stops new scheduling/purchases, but does NOT revoke the guardian
 * relationship or erase historical records. Parents retain read access
 * to their archived child's historical data (attendance, reports,
 * packages, schedule). The dashboard/children-list queries separately
 * filter archived_at IS NULL because those endpoints focus on CURRENT
 * children, not historical ones.
 */
async function verifyGuardianAccess(
  db: DbClient | TxClient,
  principal: Principal,
  academyId: string,
  studentId: string,
): Promise<void> {
  const result = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
       FROM guardian_student_links gsl
       JOIN students s ON s.id = gsl.student_id
      WHERE gsl.guardian_user_id = $1
        AND gsl.student_id = $2
        AND s.academy_id = $3;`,
    [principal.userId, studentId, academyId],
  );
  if ((result.rows[0] as { c: number }).c === 0) {
    throw Err.notFound("Student not found.");
  }
}

// === Types ===============================================================

export interface ParentChildSummary {
  studentId: string;
  fullName: string;
  className: string | null;
  classId: string | null;
  enrollmentActive: boolean;
}

export interface ParentDashboardSummary {
  childrenCount: number;
  children: ParentChildSummary[];
  upcomingSessions: { studentId: string; studentName: string; occurrenceDate: string; startAt: string; className: string }[];
  recentAttendance: { studentId: string; studentName: string; occurrenceDate: string; status: string }[];
  activePackages: { studentId: string; studentName: string; packageName: string; sessionCount: number; activeEntitlements: number }[];
  availableReports: { studentId: string; studentName: string; semesterName: string; reportId: string }[];
}

// === Dashboard summary ===================================================

export async function getParentDashboardSummary(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<ParentDashboardSummary> {
  requireAcademyContext(principal, academyId);

  // 1. Children list (single query — academy-scoped, guardian-linked).
  // DISTINCT ON (s.id) prevents duplicates from overlapping enrollments.
  // enrollment_active correctly checks both effective_from and effective_to.
  const childrenResult = await db.query<{
    student_id: string; full_name: string; class_name: string | null;
    class_id: string | null; enrollment_active: boolean;
  }>(
    `SELECT DISTINCT ON (s.id) s.id AS student_id, s.full_name,
            c.name AS class_name, se.class_id,
            CASE WHEN se.id IS NOT NULL
                 AND se.effective_from <= CURRENT_DATE
                 AND (se.effective_to IS NULL OR se.effective_to > CURRENT_DATE)
                 THEN true ELSE false END AS enrollment_active
       FROM guardian_student_links gsl
       JOIN students s ON s.id = gsl.student_id
  LEFT JOIN student_enrollments se ON se.student_id = s.id
  LEFT JOIN classes c ON c.id = se.class_id
      WHERE gsl.guardian_user_id = $1
        AND s.academy_id = $2
        AND s.archived_at IS NULL
      ORDER BY s.id, se.effective_from DESC;`,
    [principal.userId, academyId],
  );
  const children = (childrenResult.rows as {
    student_id: string; full_name: string; class_name: string | null;
    class_id: string | null; enrollment_active: boolean;
  }[]).map((r) => ({
    studentId: r.student_id,
    fullName: r.full_name,
    className: r.class_name,
    classId: r.class_id,
    enrollmentActive: r.enrollment_active,
  }));

  if (children.length === 0) {
    return {
      childrenCount: 0,
      children: [],
      upcomingSessions: [],
      recentAttendance: [],
      activePackages: [],
      availableReports: [],
    };
  }

  const childIds = children.map((c) => c.studentId);
  const childNames = new Map(children.map((c) => [c.studentId, c.fullName]));

  // 2. Upcoming sessions (next 10 across all children).
  const upcomingResult = await db.query<{
    student_id: string; occurrence_date: string; start_at: string; class_name: string;
  }>(
    `SELECT sp.student_id, to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS occurrence_date,
            to_char(tocc.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start_at,
            c.name AS class_name
       FROM session_entitlements e
       JOIN student_packages sp ON sp.id = e.student_package_id
       JOIN training_occurrences tocc ON tocc.id = e.assigned_occurrence_id
       JOIN classes c ON c.id = tocc.class_id
      WHERE sp.student_id = ANY($1::uuid[])
        AND e.status = 'active'
        AND tocc.occurrence_date >= CURRENT_DATE
        AND tocc.status = 'planned'
      ORDER BY tocc.occurrence_date, tocc.start_at
      LIMIT 10;`,
    [childIds],
  );
  const upcomingSessions = (upcomingResult.rows as {
    student_id: string; occurrence_date: string; start_at: string; class_name: string;
  }[]).map((r) => ({
    studentId: r.student_id,
    studentName: childNames.get(r.student_id) ?? "",
    occurrenceDate: r.occurrence_date,
    startAt: r.start_at,
    className: r.class_name,
  }));

  // 3. Recent attendance (last 10 across all children).
  const attendanceResult = await db.query<{
    student_id: string; occurrence_date: string; status: string;
  }>(
    `SELECT ar.student_id, to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS occurrence_date, ar.status
       FROM attendance_records ar
       JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
      WHERE ar.student_id = ANY($1::uuid[])
      ORDER BY tocc.occurrence_date DESC
      LIMIT 10;`,
    [childIds],
  );
  const recentAttendance = (attendanceResult.rows as {
    student_id: string; occurrence_date: string; status: string;
  }[]).map((r) => ({
    studentId: r.student_id,
    studentName: childNames.get(r.student_id) ?? "",
    occurrenceDate: r.occurrence_date,
    status: r.status,
  }));

  // 4. Active packages (packages with ≥1 active entitlement).
  const packagesResult = await db.query<{
    student_id: string; package_name: string; session_count: number; active_count: number;
  }>(
    `SELECT sp.student_id, pp.name AS package_name, pp.session_count,
            COUNT(e.id) FILTER (WHERE e.status = 'active')::int AS active_count
       FROM student_packages sp
       JOIN package_plans pp ON pp.id = sp.package_plan_id
  LEFT JOIN session_entitlements e ON e.student_package_id = sp.id
      WHERE sp.student_id = ANY($1::uuid[])
        AND sp.status = 'active'
      GROUP BY sp.id, sp.student_id, pp.name, pp.session_count
      HAVING COUNT(e.id) FILTER (WHERE e.status = 'active') > 0
      ORDER BY sp.purchased_at DESC;`,
    [childIds],
  );
  const activePackages = (packagesResult.rows as {
    student_id: string; package_name: string; session_count: number; active_count: number;
  }[]).map((r) => ({
    studentId: r.student_id,
    studentName: childNames.get(r.student_id) ?? "",
    packageName: r.package_name,
    sessionCount: r.session_count,
    activeEntitlements: r.active_count,
  }));

  // 5. Available published reports.
  const reportsResult = await db.query<{
    student_id: string; semester_name: string; report_id: string;
  }>(
    `SELECT sr.student_id, sem.name AS semester_name, sr.id AS report_id
       FROM student_reports sr
       JOIN semesters sem ON sem.id = sr.semester_id
      WHERE sr.student_id = ANY($1::uuid[])
        AND sr.published_at IS NOT NULL
      ORDER BY sr.published_at DESC;`,
    [childIds],
  );
  const availableReports = (reportsResult.rows as {
    student_id: string; semester_name: string; report_id: string;
  }[]).map((r) => ({
    studentId: r.student_id,
    studentName: childNames.get(r.student_id) ?? "",
    semesterName: r.semester_name,
    reportId: r.report_id,
  }));

  return {
    childrenCount: children.length,
    children,
    upcomingSessions,
    recentAttendance,
    activePackages,
    availableReports,
  };
}

// === Children list =======================================================

export async function getParentChildren(
  principal: Principal,
  academyId: string,
  db: DbClient = getDb(),
): Promise<ParentChildSummary[]> {
  requireAcademyContext(principal, academyId);

  // DISTINCT ON (s.id) prevents duplicates from overlapping enrollments.
  // enrollment_active correctly checks both effective_from and effective_to.
  const result = await db.query<ParentChildSummary>(
    `SELECT DISTINCT ON (s.id) s.id AS "studentId", s.full_name AS "fullName",
            c.name AS "className", se.class_id AS "classId",
            CASE WHEN se.id IS NOT NULL
                 AND se.effective_from <= CURRENT_DATE
                 AND (se.effective_to IS NULL OR se.effective_to > CURRENT_DATE)
                 THEN true ELSE false END AS "enrollmentActive"
       FROM guardian_student_links gsl
       JOIN students s ON s.id = gsl.student_id
  LEFT JOIN student_enrollments se ON se.student_id = s.id
  LEFT JOIN classes c ON c.id = se.class_id
      WHERE gsl.guardian_user_id = $1
        AND s.academy_id = $2
        AND s.archived_at IS NULL
      ORDER BY s.id, se.effective_from DESC;`,
    [principal.userId, academyId],
  );
  return result.rows as ParentChildSummary[];
}

// === Child schedule ======================================================

export interface ChildScheduleEntry {
  entitlementId: string;
  sequence: number;
  status: string;
  /** How the current assignment was derived. See deriveMoveType for values. */
  moveType: string;
  /** Current assigned occurrence (null if skipped/awaiting makeup). */
  occurrenceId: string | null;
  occurrenceDate: string | null;
  startAt: string | null;
  className: string | null;
  attendanceStatus: string | null;
  /** Original occurrence (immutable once set; null if never assigned). */
  originalOccurrenceId: string | null;
  originalOccurrenceDate: string | null;
  originalStartAt: string | null;
  /** True when the current assignment differs from the original. */
  wasMoved: boolean;
}

/**
 * Derive a machine-readable `moveType` from the entitlement's status, the
 * latest event type, and whether the current assignment matches the original.
 *
 * Values:
 *   "original"            — active, assigned to the original occurrence, never moved.
 *   "moved"              — active, moved via a parent normal move (normal_moved event).
 *   "makeup"             — active, assigned via makeup after a skip/cancel (makeup_assigned event).
 *   "admin_corrected"    — active, reassigned via admin correction (admin_corrected event).
 *   "initial_assignment" — active, first occurrence assignment for a previously-unassigned entitlement (occurrence_assigned event).
 *   "skipped"            — skipped by the parent (skip_requested event, status='skipped').
 *   "cancelled"          — academy cancelled the occurrence (cancelled_reassigned event, status='awaiting_makeup').
 *   "excused_absence"    — excused absence recorded (excused_absence event, status='awaiting_makeup').
 *   "awaiting_makeup"    — awaiting makeup for an unspecified reason.
 *   "completed"          — status='completed'.
 *   "cancelled"          — status='cancelled' (entitlement cancelled).
 *   "unassigned"         — active but no occurrence assignment and no original.
 */
function deriveMoveType(
  status: string,
  lastEventType: string | null,
  wasMoved: boolean,
  occurrenceId: string | null,
): string {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  if (status === "awaiting_makeup") {
    if (lastEventType === "cancelled_reassigned") return "cancelled";
    if (lastEventType === "excused_absence") return "excused_absence";
    return "awaiting_makeup";
  }
  // status === 'active'
  // Active entitlements with no current occurrence assignment are "unassigned"
  // (e.g., newly purchased package where no occurrences were available). This
  // must be checked BEFORE the lastEventType classification, otherwise the
  // 'created' event (from package purchase) would fall through to "original",
  // which incorrectly implies the entitlement is assigned to its original
  // occurrence.
  if (occurrenceId === null) return "unassigned";
  if (lastEventType === "normal_moved") return "moved";
  if (lastEventType === "makeup_assigned") return "makeup";
  if (lastEventType === "admin_corrected") return "admin_corrected";
  if (lastEventType === "occurrence_assigned") return "initial_assignment";
  if (wasMoved) return "moved"; // assignment differs from original but no specific event — treat as moved
  return "original";
}

export async function getChildSchedule(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<ChildScheduleEntry[]> {
  requireAcademyContext(principal, academyId);
  await verifyGuardianAccess(db, principal, academyId, studentId);

  // Return entitlements with their assigned AND original occurrences, plus
  // the latest event type (for moveType derivation). Bounded to 30.
  // The LEFT JOIN LATERAL fetches the latest event per entitlement efficiently
  // via the entitlement_events_entitlement_idx (entitlement_id, occurred_at) index.
  const result = await db.query<{
    entitlementId: string;
    sequence: number;
    status: string;
    occurrenceId: string | null;
    occurrenceDate: string | null;
    startAt: string | null;
    className: string | null;
    attendanceStatus: string | null;
    originalOccurrenceId: string | null;
    originalOccurrenceDate: string | null;
    originalStartAt: string | null;
    lastEventType: string | null;
  }>(
    `SELECT e.id AS "entitlementId", e.sequence, e.status,
            tocc.id AS "occurrenceId",
            to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS "occurrenceDate",
            to_char(tocc.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startAt",
            c.name AS "className",
            ar.status AS "attendanceStatus",
            e.original_occurrence_id AS "originalOccurrenceId",
            to_char(orig_occ.occurrence_date, 'YYYY-MM-DD') AS "originalOccurrenceDate",
            to_char(orig_occ.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "originalStartAt",
            latest.event_type AS "lastEventType"
       FROM session_entitlements e
       JOIN student_packages sp ON sp.id = e.student_package_id
       LEFT JOIN training_occurrences tocc ON tocc.id = e.assigned_occurrence_id
       LEFT JOIN classes c ON c.id = tocc.class_id
       LEFT JOIN attendance_records ar ON ar.training_occurrence_id = tocc.id AND ar.student_id = sp.student_id
       LEFT JOIN training_occurrences orig_occ ON orig_occ.id = e.original_occurrence_id
       LEFT JOIN LATERAL (
         SELECT ee.event_type FROM entitlement_events ee
          WHERE ee.entitlement_id = e.id
          ORDER BY ee.occurred_at DESC, ee.id DESC
          LIMIT 1
       ) latest ON true
      WHERE sp.student_id = $1
      ORDER BY tocc.occurrence_date DESC NULLS LAST, e.sequence
      LIMIT 30;`,
    [studentId],
  );
  return (result.rows as (typeof result.rows)[number][]).map((r) => {
    const wasMoved =
      r.originalOccurrenceId !== null &&
      r.occurrenceId !== null &&
      r.occurrenceId !== r.originalOccurrenceId;
    const moveType = deriveMoveType(r.status, r.lastEventType, wasMoved, r.occurrenceId);
    return {
      entitlementId: r.entitlementId,
      sequence: r.sequence,
      status: r.status,
      moveType,
      occurrenceId: r.occurrenceId,
      occurrenceDate: r.occurrenceDate,
      startAt: r.startAt,
      className: r.className,
      attendanceStatus: r.attendanceStatus,
      originalOccurrenceId: r.originalOccurrenceId,
      originalOccurrenceDate: r.originalOccurrenceDate,
      originalStartAt: r.originalStartAt,
      wasMoved,
    } satisfies ChildScheduleEntry;
  });
}

// === Eligible occurrences for move/makeup (Stage 10 Phase 1) ==============

export interface EligibleOccurrenceEntry {
  id: string;
  occurrenceDate: string;
  startAt: string;
  endAt: string;
  className: string;
  capacity: number;
  activeCount: number;
  /** capacity - activeCount. Provisional — the mutation revalidates. */
  availableSeats: number;
}

/**
 * Return eligible future occurrences for a parent move/makeup action.
 *
 * Verifies: guardian ownership of the student, entitlement ownership (the
 * entitlement belongs to this student's package), academy scope, and
 * class eligibility (occurrences match the package's class_id_at_purchase).
 *
 * Returned capacity is PROVISIONAL — the mutation endpoint revalidates
 * capacity transactionally inside a SERIALIZABLE tx. A race between this
 * list and the mutation can cause the mutation to 409 "destination_full".
 */
export async function getEligibleOccurrences(
  principal: Principal,
  academyId: string,
  studentId: string,
  entitlementId: string,
  db: DbClient = getDb(),
): Promise<EligibleOccurrenceEntry[]> {
  requireAcademyContext(principal, academyId);
  await verifyGuardianAccess(db, principal, academyId, studentId);

  // Load the entitlement (academy-scoped via package → student → academy).
  const entitlement = await loadEntitlementInAcademy(db, entitlementId, academyId);

  // Verify the entitlement belongs to the URL's student.
  const pkg = await loadStudentPackageInAcademy(db, entitlement.student_package_id, academyId);
  if (pkg.student_id !== studentId) {
    throw Err.notFound("Entitlement not found for this student.");
  }

  // Query eligible occurrences: same class, planned, future, active version.
  // Does NOT filter by capacity here — the mutation revalidates. But we
  // compute activeCount + availableSeats for display.
  const result = await db.query<{
    id: string;
    occurrenceDate: string;
    startAt: string;
    endAt: string;
    className: string;
    capacity: number;
    activeCount: number;
  }>(
    `SELECT tocc.id,
            to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS "occurrenceDate",
            to_char(tocc.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startAt",
            to_char(tocc.end_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "endAt",
            c.name AS "className",
            tocc.capacity,
            (SELECT COUNT(*)::int FROM session_entitlements se
              WHERE se.assigned_occurrence_id = tocc.id AND se.status = 'active') AS "activeCount"
       FROM training_occurrences tocc
       JOIN schedule_versions sv ON sv.id = tocc.schedule_version_id
       JOIN classes c ON c.id = tocc.class_id
      WHERE tocc.academy_id = $1
        AND tocc.class_id = $2
        AND tocc.status = 'planned'
        AND tocc.start_at > now()
        AND sv.status = 'active'
        AND sv.effective_to IS NULL
      ORDER BY tocc.occurrence_date, tocc.start_at
      LIMIT 50;`,
    [academyId, pkg.class_id_at_purchase],
  );
  return (result.rows as (typeof result.rows)[number][]).map((r) => ({
    id: r.id,
    occurrenceDate: r.occurrenceDate,
    startAt: r.startAt,
    endAt: r.endAt,
    className: r.className,
    capacity: r.capacity,
    activeCount: r.activeCount,
    availableSeats: Math.max(0, r.capacity - r.activeCount),
  }));
}

// === Child packages + entitlements =======================================

export interface ChildPackageEntry {
  packageId: string;
  packageName: string;
  sessionCount: number;
  packageStatus: string;
  purchasedAt: string;
  entitlements: {
    id: string;
    sequence: number;
    status: string;
    skipUsed: boolean;
    originalOccurrenceId: string | null;
    assignedOccurrenceId: string | null;
  }[];
}

export async function getChildPackages(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<ChildPackageEntry[]> {
  requireAcademyContext(principal, academyId);
  await verifyGuardianAccess(db, principal, academyId, studentId);

  const pkgResult = await db.query<{
    package_id: string; package_name: string; session_count: number;
    package_status: string; purchased_at: string;
  }>(
    `SELECT sp.id AS package_id, pp.name AS package_name, pp.session_count,
            sp.status AS package_status,
            to_char(sp.purchased_at, 'YYYY-MM-DD') AS purchased_at
       FROM student_packages sp
       JOIN package_plans pp ON pp.id = sp.package_plan_id
      WHERE sp.student_id = $1
      ORDER BY sp.purchased_at DESC;`,
    [studentId],
  );
  const packages = pkgResult.rows as {
    package_id: string; package_name: string; session_count: number;
    package_status: string; purchased_at: string;
  }[];

  if (packages.length === 0) return [];

  const pkgIds = packages.map((p) => p.package_id);

  const entResult = await db.query<{
    student_package_id: string; id: string; sequence: number; status: string;
    skip_used: boolean; original_occurrence_id: string | null; assigned_occurrence_id: string | null;
  }>(
    `SELECT e.student_package_id, e.id, e.sequence, e.status,
            e.skip_used, e.original_occurrence_id, e.assigned_occurrence_id
       FROM session_entitlements e
      WHERE e.student_package_id = ANY($1::uuid[])
      ORDER BY e.sequence;`,
    [pkgIds],
  );
  const entitlements = entResult.rows as {
    student_package_id: string; id: string; sequence: number; status: string;
    skip_used: boolean; original_occurrence_id: string | null; assigned_occurrence_id: string | null;
  }[];

  return packages.map((p) => ({
    packageId: p.package_id,
    packageName: p.package_name,
    sessionCount: p.session_count,
    packageStatus: p.package_status,
    purchasedAt: p.purchased_at,
    entitlements: entitlements
      .filter((e) => e.student_package_id === p.package_id)
      .map((e) => ({
        id: e.id,
        sequence: e.sequence,
        status: e.status,
        skipUsed: e.skip_used,
        originalOccurrenceId: e.original_occurrence_id,
        assignedOccurrenceId: e.assigned_occurrence_id,
      })),
  }));
}

// === Child attendance ====================================================

export interface ChildAttendanceEntry {
  id: string;
  occurrenceDate: string;
  startAt: string;
  className: string;
  status: string;
  notes: string | null;
}

export async function getChildAttendance(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<ChildAttendanceEntry[]> {
  requireAcademyContext(principal, academyId);
  await verifyGuardianAccess(db, principal, academyId, studentId);

  // Bounded to 50 most recent — no unlimited history.
  const result = await db.query<ChildAttendanceEntry>(
    `SELECT ar.id,
            to_char(tocc.occurrence_date, 'YYYY-MM-DD') AS "occurrenceDate",
            to_char(tocc.start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startAt",
            c.name AS "className",
            ar.status, ar.notes
       FROM attendance_records ar
       JOIN training_occurrences tocc ON tocc.id = ar.training_occurrence_id
       JOIN classes c ON c.id = tocc.class_id
      WHERE ar.student_id = $1
      ORDER BY tocc.occurrence_date DESC
      LIMIT 50;`,
    [studentId],
  );
  return result.rows as ChildAttendanceEntry[];
}

// === Child semester reports (published only) ============================

export interface ChildReportEntry {
  id: string;
  semesterName: string;
  semesterStartDate: string;
  semesterEndDate: string;
  body: string;
  publishedAt: string;
}

export async function getChildReports(
  principal: Principal,
  academyId: string,
  studentId: string,
  db: DbClient = getDb(),
): Promise<ChildReportEntry[]> {
  requireAcademyContext(principal, academyId);
  await verifyGuardianAccess(db, principal, academyId, studentId);

  const result = await db.query<ChildReportEntry>(
    `SELECT sr.id,
            sem.name AS "semesterName",
            to_char(sem.start_date, 'YYYY-MM-DD') AS "semesterStartDate",
            to_char(sem.end_date, 'YYYY-MM-DD') AS "semesterEndDate",
            sr.body,
            to_char(sr.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "publishedAt"
       FROM student_reports sr
       JOIN semesters sem ON sem.id = sr.semester_id
      WHERE sr.student_id = $1
        AND sr.published_at IS NOT NULL
      ORDER BY sem.start_date DESC;`,
    [studentId],
  );
  return result.rows as ChildReportEntry[];
}
