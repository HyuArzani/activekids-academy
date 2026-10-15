/**
 * Seed script. Creates the default academy, classes (Semangat, Membara),
 * and package plans (4-session, 8-session). Idempotent: re-running is safe
 * and uses upsert semantics keyed on stable natural keys.
 *
 * Academy timezone: Asia/Jakarta. Classes:
 *   - Semangat: Tuesday + Saturday at 15:00
 *   - Membara:  Tuesday + Saturday at 16:00
 *
 * Package plans: arbitrary session counts. Seed ships 4 and 8 only as
 * defaults — the schema supports any positive session_count.
 */

import { randomUUID } from "node:crypto";
import { loadEnv } from "@/lib/env";
import { getDb } from "@/lib/db";

// Deterministic UUIDs for seed rows so re-runs are stable and traceable.
const ACADEMY_ID = "00000000-0000-0000-0000-000000000001";
const CLASS_SEMANGAT_ID = "00000000-0000-0000-0000-000000000010";
const CLASS_MEMBARA_ID = "00000000-0000-0000-0000-000000000011";
const PLAN_4_ID = "00000000-0000-0000-0000-000000000020";
const PLAN_8_ID = "00000000-0000-0000-0000-000000000021";
const SCHEDULE_SEMANGAT_ID = "00000000-0000-0000-0000-000000000030";
const SCHEDULE_MEMBARA_ID = "00000000-0000-0000-0000-000000000031";

async function main() {
  loadEnv();
  const db = getDb();
  try {
    await db.query("BEGIN;");

    // Academy
    await db.query(
      `INSERT INTO academies (id, name, slug, timezone, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         timezone = EXCLUDED.timezone,
         updated_at = now();`,
      [ACADEMY_ID, "Futsal Academy Default", "default", "Asia/Jakarta"],
    );

    // Classes
    await db.query(
      `INSERT INTO classes (id, academy_id, name, capacity, is_active)
       VALUES ($1, $2, 'Semangat', 12, true)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         capacity = EXCLUDED.capacity,
         updated_at = now();`,
      [CLASS_SEMANGAT_ID, ACADEMY_ID],
    );
    await db.query(
      `INSERT INTO classes (id, academy_id, name, capacity, is_active)
       VALUES ($1, $2, 'Membara', 12, true)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         capacity = EXCLUDED.capacity,
         updated_at = now();`,
      [CLASS_MEMBARA_ID, ACADEMY_ID],
    );

    // Active schedule versions (effective from today; effective_to NULL).
    await db.query(
      `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
       VALUES ($1, $2, CURRENT_DATE, NULL, 'active')
       ON CONFLICT (id) DO UPDATE SET
         effective_from = EXCLUDED.effective_from,
         effective_to = EXCLUDED.effective_to,
         status = EXCLUDED.status,
         updated_at = now();`,
      [SCHEDULE_SEMANGAT_ID, CLASS_SEMANGAT_ID],
    );
    await db.query(
      `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
       VALUES ($1, $2, CURRENT_DATE, NULL, 'active')
       ON CONFLICT (id) DO UPDATE SET
         effective_from = EXCLUDED.effective_from,
         effective_to = EXCLUDED.effective_to,
         status = EXCLUDED.status,
         updated_at = now();`,
      [SCHEDULE_MEMBARA_ID, CLASS_MEMBARA_ID],
    );

    // Slots: Tuesday=2 and Saturday=6. Semangat 15:00, Membara 16:00.
    const slots: Array<{
      id: string;
      versionId: string;
      weekday: number;
      start: string;
      end: string;
    }> = [
      { id: "00000000-0000-0000-0000-000000000040", versionId: SCHEDULE_SEMANGAT_ID, weekday: 2, start: "15:00", end: "16:00" },
      { id: "00000000-0000-0000-0000-000000000041", versionId: SCHEDULE_SEMANGAT_ID, weekday: 6, start: "15:00", end: "16:00" },
      { id: "00000000-0000-0000-0000-000000000042", versionId: SCHEDULE_MEMBARA_ID, weekday: 2, start: "16:00", end: "17:00" },
      { id: "00000000-0000-0000-0000-000000000043", versionId: SCHEDULE_MEMBARA_ID, weekday: 6, start: "16:00", end: "17:00" },
    ];
    for (const s of slots) {
      await db.query(
        `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time, capacity_override)
         VALUES ($1, $2, $3, $4, $5, NULL)
         ON CONFLICT (id) DO UPDATE SET
           weekday = EXCLUDED.weekday,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           updated_at = now();`,
        [s.id, s.versionId, s.weekday, s.start, s.end],
      );
    }

    // Package plans: 4 and 8 sessions. Schema supports arbitrary counts.
    await db.query(
      `INSERT INTO package_plans (id, academy_id, name, session_count, is_active)
       VALUES ($1, $2, 'Starter 4', 4, true)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         session_count = EXCLUDED.session_count,
         updated_at = now();`,
      [PLAN_4_ID, ACADEMY_ID],
    );
    await db.query(
      `INSERT INTO package_plans (id, academy_id, name, session_count, is_active)
       VALUES ($1, $2, 'Standard 8', 8, true)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         session_count = EXCLUDED.session_count,
         updated_at = now();`,
      [PLAN_8_ID, ACADEMY_ID],
    );

    await db.query("COMMIT;");

    // Verify seed (read-only).
    const cls = await db.query(
      `SELECT c.name, c.capacity, v.id AS version_id, v.effective_from
       FROM classes c
       LEFT JOIN schedule_versions v ON v.class_id = c.id AND v.status = 'active'
       WHERE c.academy_id = $1
       ORDER BY c.name;`,
      [ACADEMY_ID],
    );
    console.info("Seeded classes:");
    for (const row of (cls.rows ?? []) as Array<{ name: string; capacity: number; version_id: string; effective_from: string }>) {
      console.info(`  - ${row.name} (capacity=${row.capacity}, version=${row.version_id.slice(0, 8)}, effective_from=${row.effective_from})`);
    }
    const plans = await db.query(
      `SELECT name, session_count FROM package_plans WHERE academy_id = $1 ORDER BY session_count;`,
      [ACADEMY_ID],
    );
    console.info("Seeded package plans:");
    for (const row of (plans.rows ?? []) as Array<{ name: string; session_count: number }>) {
      console.info(`  - ${row.name} (${row.session_count} sessions)`);
    }
    const slotsCount = await db.query(
      `SELECT s.weekday, s.start_time, c.name AS class_name
       FROM schedule_slots s
       JOIN schedule_versions v ON v.id = s.schedule_version_id
       JOIN classes c ON c.id = v.class_id
       WHERE c.academy_id = $1
       ORDER BY c.name, s.start_time;`,
      [ACADEMY_ID],
    );
    console.info("Seeded schedule slots:");
    for (const row of (slotsCount.rows ?? []) as Array<{ weekday: number; start_time: string; class_name: string }>) {
      const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][row.weekday];
      console.info(`  - ${row.class_name} / ${dayName} @ ${row.start_time}`);
    }
    console.info("SEED_OK");
  } catch (err) {
    try {
      await db.query("ROLLBACK;");
    } catch {
      // best effort
    }
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await db.close().catch(() => {});
  }
}

// Silence unused-var warning for the randomUUID import (kept for parity with
// other scripts; not needed here since seed uses fixed UUIDs).
void randomUUID;

main();
