import { Err } from "@/lib/errors";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import { getDb, type DbClient } from "@/lib/db";
import { requireAcademyContext } from "./helpers";
import { getOccurrenceRoster, type OccurrenceRosterEntry } from "./attendance";

export interface CoachOccurrence {
  id: string;
  class_id: string;
  class_name: string;
  occurrence_date: string;
  start_at: Date;
  end_at: Date;
  status: string;
  capacity: number;
}

export async function listCoachOccurrences(principal: Principal, academyId: string, db: DbClient = getDb()): Promise<CoachOccurrence[]> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "coach", academyId);
  const result = await db.query<CoachOccurrence>(
    `SELECT DISTINCT tocc.id, tocc.class_id, c.name AS class_name, tocc.occurrence_date,
            tocc.start_at, tocc.end_at, tocc.status, tocc.capacity
       FROM training_occurrences tocc
       JOIN classes c ON c.id = tocc.class_id AND c.academy_id = tocc.academy_id
       JOIN student_enrollments se ON se.class_id = c.id
         AND se.effective_from <= tocc.occurrence_date
         AND (se.effective_to IS NULL OR se.effective_to > tocc.occurrence_date)
       JOIN coach_student_assignments csa ON csa.student_id = se.student_id
         AND csa.coach_user_id = $2 AND csa.is_active = true
         AND (csa.class_id IS NULL OR csa.class_id = tocc.class_id)
       JOIN students s ON s.id = se.student_id AND s.academy_id = tocc.academy_id
      WHERE tocc.academy_id = $1
      ORDER BY tocc.start_at DESC LIMIT 250;`,
    [academyId, principal.userId],
  );
  return result.rows;
}

export async function getCoachOccurrenceRoster(principal: Principal, academyId: string, occurrenceId: string, db: DbClient = getDb()): Promise<{ occurrence: Awaited<ReturnType<typeof getOccurrenceRoster>>["occurrence"]; roster: OccurrenceRosterEntry[] }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "coach", academyId);
  const result = await getOccurrenceRoster(principal, academyId, occurrenceId, db);
  const allowed = await db.query<{ student_id: string }>(
    `SELECT DISTINCT csa.student_id FROM coach_student_assignments csa
       JOIN students s ON s.id = csa.student_id
      WHERE csa.coach_user_id = $1 AND csa.is_active = true AND s.academy_id = $2
        AND (csa.class_id IS NULL OR csa.class_id = $3);`,
    [principal.userId, academyId, result.occurrence.class_id],
  );
  const ids = new Set(allowed.rows.map((row) => row.student_id));
  const roster = result.roster.filter((student) => ids.has(student.student_id));
  if (roster.length === 0 && !allowed.rows.length) throw Err.forbidden("Coach is not assigned to this occurrence.");
  return { occurrence: result.occurrence, roster };
}
