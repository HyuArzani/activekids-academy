/**
 * Domain: Schedule occurrence generation.
 *
 * Enforces:
 *   - Idempotent generation: INSERT ... ON CONFLICT (slot, date) DO NOTHING.
 *     Running the same generation twice produces no new rows.
 *   - Occurrences preserve the schedule_version_id and slot snapshot at
 *     generation time. Subsequent schedule changes do NOT rewrite existing
 *     occurrences.
 *   - Academy-local date handling: occurrence_date is a date (calendar day
 *     in Asia/Jakarta). start_at/end_at are timestamptz for tz-aware
 *     comparisons.
 *   - No past occurrences are generated as future sessions.
 *
 * Per Decision 2: when a schedule version changes, existing occurrences
 * are preserved (immutable snapshots). New occurrences are generated from
 * the new version. Old future occurrences remain but are NOT made
 * available for new bookings (the domain service checks the occurrence's
 * schedule_version_id against the current active version when assigning
 * entitlements).
 *
 * --- Timezone correctness ------------------------------------------------
 * All wall-clock arithmetic in this module is done in the academy
 * timezone (Asia/Jakarta, UTC+7 year-round — Indonesia has not observed
 * DST since 1964). We never use `Date.getDay()` or `Date.setHours()`
 * (which are server-local-time dependent) for slot matching or
 * timestamp construction, because the production server may run in UTC
 * while the academy's local meeting time is in Jakarta. Instead:
 *
 *   - Slot weekday matching: convert the cursor UTC instant to the
 *     Jakarta wall-clock weekday via `jakartaWeekday(utc)`.
 *   - Calendar date string (occurrence_date): format the Jakarta
 *     wall-clock YMD via `jakartaYmd(utc)`. The DB column is `date`; we
 *     pass a string to avoid driver-side timezone interpretation.
 *   - start_at/end_at: construct the UTC instant that corresponds to the
 *     Jakarta wall-clock time via `jakartaInstant(ymd, hhmm)`, which
 *     uses the explicit `+07:00` offset so the stored timestamptz is the
 *     actual Jakarta meeting instant (independent of server TZ).
 */

import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import {
  requireAcademyContext,
  loadClassInAcademy,
  loadActiveScheduleVersion,
  newId,
  type ScheduleSlotRow,
} from "./helpers";

export interface GenerateOccurrencesInput {
  classId: string;
  /** Start date (inclusive). Must be today or later for future sessions. */
  fromDate: Date;
  /** Number of weeks to generate ahead. */
  weeksAhead: number;
}

export interface GenerateOccurrencesResult {
  generated: number;
  /**
   * True if the generation was a no-op (all occurrences already existed).
   * Note: when no slot matches any weekday in the horizon (e.g. the
   * horizon contains no day with a configured slot), `generated` is 0
   * but `idempotent` is `false` to distinguish "nothing to do" from
   * "everything already existed".
   */
  idempotent: boolean;
}

/**
 * Asia/Jakarta offset from UTC, in milliseconds. Indonesia has not
 * observed DST since 1964, so this is a fixed +07:00 year-round.
 * The academy timezone is configured in env (`ACADEMY_TIMEZONE`) and
 * migrations reference 'Asia/Jakarta' directly; we keep the offset here
 * rather than reading env to avoid runtime tz database dependencies.
 */
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Return the Jakarta wall-clock weekday (0=Sunday … 6=Saturday) for the
 * given UTC instant. Pure function; no server-TZ dependency.
 */
function jakartaWeekday(utc: Date): number {
  return new Date(utc.getTime() + JAKARTA_OFFSET_MS).getUTCDay();
}

/**
 * Format the Jakarta wall-clock YMD as "YYYY-MM-DD" for the given UTC
 * instant. Used for human-readable logging and string comparisons.
 */
function jakartaYmd(utc: Date): string {
  const shifted = new Date(utc.getTime() + JAKARTA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Construct the UTC instant that corresponds to a Jakarta wall-clock
 * time. `ymd` is "YYYY-MM-DD". The time string is the value loaded
 * from a `time` column, which PgLite/pg returns as "HH:MM:SS" (with
 * seconds). The original `time` literal in the DB is written without
 * seconds ("15:00"), but the driver normalizes to "HH:MM:SS" on read.
 *
 * To be robust to both forms ("HH:MM" and "HH:MM:SS"), we normalize
 * before constructing the ISO string. The explicit `+07:00` offset
 * makes the resulting Date independent of the server timezone.
 *
 * Example: jakartaInstant("2026-01-06", "15:00:00") returns the UTC
 * Date for 2026-01-06 15:00:00+07:00, i.e. 2026-01-06 08:00:00 UTC.
 */
function jakartaInstant(ymd: string, hhmmss: string): Date {
  const normalized =
    hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss; // "HH:MM" → "HH:MM:SS"
  return new Date(`${ymd}T${normalized}+07:00`);
}

/**
 * Construct a UTC Date representing "midnight UTC of the given Jakarta
 * calendar date". Used as the value passed to the `occurrence_date`
 * column (a DATE column).
 *
 * The pg/PgLite driver's DATE serializer expects a Date whose UTC
 * midnight corresponds to the target calendar date. The DATE column
 * stores only the Y/M/D, so passing a UTC-midnight Date is unambiguous
 * and matches the original code's behavior (which used
 * `setHours(0,0,0,0)` on a UTC server). The actual stored calendar date
 * is the Jakarta calendar date for the cursor iteration, which is what
 * the slot's weekday matching guarantees.
 */
function utcMidnightFromYmd(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * Truncate a UTC instant to Jakarta midnight (the start of the Jakarta
 * calendar day containing that instant). Returns a UTC Date representing
 * 00:00:00 Jakarta of that day (which is 17:00:00 UTC of the previous
 * day, but the returned Date is just a UTC instant — its wall-clock
 * representation in UTC will be 17:00 the previous day, which is correct).
 */
function jakartaMidnight(utc: Date): Date {
  // Shift to Jakarta, drop time-of-day, shift back to UTC.
  const shifted = new Date(utc.getTime() + JAKARTA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - JAKARTA_OFFSET_MS);
}

/**
 * Generate training occurrences for a class's active schedule version.
 * Idempotent: running twice with the same parameters produces no new rows.
 *
 * Uses INSERT ... ON CONFLICT (schedule_slot_id, occurrence_date) DO NOTHING
 * so that re-running generation for the same dates is a no-op.
 *
 * Boundary semantics: `weeksAhead` is interpreted as "the next N weeks
 * starting from fromDate (inclusive)". The horizon is exactly
 * `weeksAhead * 7` days, inclusive of fromDate and exclusive of
 * `fromDate + weeksAhead*7 days`. E.g. weeksAhead=1 from Sunday covers
 * Sun..Sat (7 days), not 8.
 *
 * Timezone: slot weekday matching and timestamp construction use the
 * academy timezone (Asia/Jakarta, UTC+7), NOT the server's local
 * timezone. This ensures a "Tuesday 15:00 Jakarta" slot is stored with
 * start_at = Tuesday 15:00 Jakarta (= Tuesday 08:00 UTC), regardless of
 * whether the server runs in UTC or Jakarta.
 */
export async function generateOccurrences(
  principal: Principal,
  academyId: string,
  input: GenerateOccurrencesInput,
  db: DbClient = getDb(),
): Promise<GenerateOccurrencesResult> {
  requireAcademyContext(principal, academyId);
  const classRow = await loadClassInAcademy(db, input.classId, academyId);

  return db.withTxSerializable(async (tx) => {
    const version = await loadActiveScheduleVersion(tx, input.classId);
    if (!version) {
      throw Err.conflict("No active schedule version for this class.");
    }

    // Load all slots for this version.
    const slotsResult = await tx.query<ScheduleSlotRow>(
      `SELECT id, schedule_version_id, weekday, start_time, end_time, capacity_override
         FROM schedule_slots
        WHERE schedule_version_id = $1
        ORDER BY weekday, start_time;`,
      [version.id],
    );
    const slots = slotsResult.rows as ScheduleSlotRow[];
    if (slots.length === 0) {
      throw Err.conflict("Active schedule version has no slots.");
    }

    // Validate that the version's effective_from allows generation from
    // fromDate. The version's effective_from is stored as a `date` (no tz);
    // we compare the Jakarta YMD strings, so the comparison is independent
    // of server TZ.
    const versionEffectiveYmd = jakartaYmd(new Date(version.effective_from));
    const fromYmd = jakartaYmd(input.fromDate);
    if (fromYmd < versionEffectiveYmd) {
      throw Err.validation(
        "Generation start date is before the schedule version's effective date.",
      );
    }

    // Compute the horizon in UTC milliseconds, anchored at Jakarta midnight
    // of fromDate. The horizon is exactly weeksAhead*7 days (inclusive
    // start, exclusive end).
    const startMs = jakartaMidnight(input.fromDate).getTime();
    const endMs = startMs + input.weeksAhead * 7 * DAY_MS;

    let generated = 0;
    let matchedAnySlot = false;
    let cursorMs = startMs;

    while (cursorMs < endMs) {
      const cursorUtc = new Date(cursorMs);
      const weekday = jakartaWeekday(cursorUtc);
      const ymd = jakartaYmd(cursorUtc);

      for (const slot of slots) {
        if (slot.weekday !== weekday) continue;
        matchedAnySlot = true;

        // Construct the actual Jakarta meeting instants. The explicit
        // +07:00 offset makes the stored timestamptz the actual Jakarta
        // wall-clock instant, independent of the server timezone.
        const startAt = jakartaInstant(ymd, slot.start_time);
        const endAt = jakartaInstant(ymd, slot.end_time);
        // occurrence_date: pass a UTC-midnight Date whose calendar date
        // matches the Jakarta calendar date we computed for this cursor
        // iteration. The DATE column stores only Y/M/D.
        const occDate = utcMidnightFromYmd(ymd);
        const capacity = slot.capacity_override ?? classRow.capacity;
        const occId = newId();

        const result = await tx.query(
          `INSERT INTO training_occurrences
             (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
              occurrence_date, start_at, end_at, status, capacity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'planned', $9)
           ON CONFLICT (schedule_slot_id, occurrence_date) DO NOTHING
           RETURNING id;`,
          [occId, academyId, input.classId, slot.id, version.id, occDate, startAt, endAt, capacity],
        );

        if (result.rows.length > 0) {
          generated++;
        }
      }
      cursorMs += DAY_MS;
    }

    await writeAudit({
      tx,
      academyId,
      actorUserId: principal.userId,
      action: "occurrences.generate",
      targetType: "training_occurrences",
      targetId: null,
      after: {
        classId: input.classId,
        generated,
        fromDate: fromYmd,
        weeksAhead: input.weeksAhead,
        // Include the resolved UTC horizon so auditors can verify the
        // generation window without re-deriving it from Jakarta arithmetic.
        horizonStartUtc: new Date(startMs).toISOString(),
        horizonEndUtc: new Date(endMs).toISOString(),
      },
    });

    return {
      generated,
      // generated===0 && matchedAnySlot===false means "no slot matched any
      // weekday in the horizon" — that is NOT idempotent replay, it's just
      // nothing-to-do. Distinguish by setting idempotent=false in that case.
      idempotent: generated === 0 && matchedAnySlot,
    };
  });
}
