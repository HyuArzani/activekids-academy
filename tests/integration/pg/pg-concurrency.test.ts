/**
 * PostgreSQL integration tests: concurrency.
 *
 * These tests verify real concurrent behavior that CANNOT be tested under
 * PgLite (single-process, single-connection):
 *   - Two competing assignments to an occurrence with capacity 1 (SERIALIZABLE
 *     should abort one with 40001).
 *   - Concurrent occurrence generation (idempotent under real concurrency).
 *   - Competing skip operations against the same package (one-skip-per-package
 *     holds under contention).
 *
 * These tests ONLY run when TEST_DATABASE_URL is set.
 */

import { expect } from "bun:test";
import { pgTest, setupPgDb, seedPgFixture } from "./_helpers";
import { PgAdapter } from "@/lib/db/pg-adapter";
import { AppError } from "@/lib/errors";
import { SQLSTATE } from "@/lib/db/pg-errors";

pgTest("concurrent capacity: only one assignment succeeds when capacity=1 (SERIALIZABLE)", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    // Create a class with capacity=1 and one occurrence.
    const smallClassId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Small', 1, true);`, [smallClassId, f.academyId]);
    const versionId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, smallClassId]);
    const slotId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '18:00', '19:00');`, [slotId, versionId]);
    const occId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2026-01-06', '2026-01-06 18:00:00', '2026-01-06 19:00:00', 'planned', 1);`, [occId, f.academyId, smallClassId, slotId, versionId]);
    // Two students + packages + entitlements.
    const s1 = globalThis.crypto.randomUUID();
    const s2 = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S1');`, [s1, f.academyId]);
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S2');`, [s2, f.academyId]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [globalThis.crypto.randomUUID(), s1, smallClassId]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [globalThis.crypto.randomUUID(), s2, smallClassId]);
    const pkg1 = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4) RETURNING id;`, [globalThis.crypto.randomUUID(), s1, f.plan4Id, smallClassId]);
    const pkg2 = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4) RETURNING id;`, [globalThis.crypto.randomUUID(), s2, f.plan4Id, smallClassId]);
    const ent1 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, 1, 'active') RETURNING id;`, [globalThis.crypto.randomUUID(), (pkg1.rows[0] as { id: string }).id]);
    const ent2 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1, $2, 1, 'active') RETURNING id;`, [globalThis.crypto.randomUUID(), (pkg2.rows[0] as { id: string }).id]);

    const ent1Id = (ent1.rows[0] as { id: string }).id;
    const ent2Id = (ent2.rows[0] as { id: string }).id;

    // Create two separate PgAdapters for concurrent transactions.
    const adapter1 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const adapter2 = new PgAdapter(process.env.TEST_DATABASE_URL!);

    // Run both assignments concurrently.
    const assign1 = adapter1.withTxSerializable(async (tx) => {
      // Lock the occurrence.
      await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [occId]);
      // Check capacity.
      const cap = await tx.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE assigned_occurrence_id = $1 AND status = 'active' AND id <> $2;`, [occId, ent1Id]);
      if ((cap.rows[0] as { c: number }).c >= 1) throw new Error("capacity full");
      // Assign.
      await tx.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [ent1Id, occId]);
      return "assigned";
    });

    const assign2 = adapter2.withTxSerializable(async (tx) => {
      await tx.query(`SELECT id FROM training_occurrences WHERE id = $1 FOR UPDATE;`, [occId]);
      const cap = await tx.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE assigned_occurrence_id = $1 AND status = 'active' AND id <> $2;`, [occId, ent2Id]);
      if ((cap.rows[0] as { c: number }).c >= 1) throw new Error("capacity full");
      await tx.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [ent2Id, occId]);
      return "assigned";
    });

    const results = await Promise.allSettled([assign1, assign2]);
    await adapter1.close();
    await adapter2.close();

    // Exactly one should succeed, the other should fail (either capacity
    // check or serialization conflict).
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    expect(succeeded).toBe(1);
    expect(failed).toBe(1);

    // Verify only one entitlement is actually assigned.
    const assigned = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE assigned_occurrence_id = $1 AND status = 'active';`, [occId]);
    expect((assigned.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await cleanup();
  }
});

pgTest("concurrent occurrence generation is idempotent under real concurrency", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    // Run two concurrent generations for the same dates.
    const adapter1 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const adapter2 = new PgAdapter(process.env.TEST_DATABASE_URL!);

    const gen1 = adapter1.withTxSerializable(async (tx) => {
      // Minimal generation: insert one occurrence, ON CONFLICT DO NOTHING.
      const occId = globalThis.crypto.randomUUID();
      await tx.query(
        `INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity)
         VALUES ($1, $2, $3, $4, $5, '2026-01-06', '2026-01-06 15:00:00', '2026-01-06 16:00:00', 'planned', 12)
         ON CONFLICT (schedule_slot_id, occurrence_date) DO NOTHING
         RETURNING id;`,
        [occId, f.academyId, f.classId, f.tueSlotId, f.scheduleVersionId],
      );
      return "ok";
    });

    const gen2 = adapter2.withTxSerializable(async (tx) => {
      const occId = globalThis.crypto.randomUUID();
      await tx.query(
        `INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity)
         VALUES ($1, $2, $3, $4, $5, '2026-01-06', '2026-01-06 15:00:00', '2026-01-06 16:00:00', 'planned', 12)
         ON CONFLICT (schedule_slot_id, occurrence_date) DO NOTHING
         RETURNING id;`,
        [occId, f.academyId, f.classId, f.tueSlotId, f.scheduleVersionId],
      );
      return "ok";
    });

    await Promise.allSettled([gen1, gen2]);
    await adapter1.close();
    await adapter2.close();

    // Verify only ONE occurrence exists for that date+slot (no duplicates).
    const count = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM training_occurrences WHERE schedule_slot_id = $1 AND occurrence_date = '2026-01-06';`,
      [f.tueSlotId],
    );
    expect((count.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await cleanup();
  }
});

pgTest("competing skip operations: only one succeeds per package (SERIALIZABLE)", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    // Setup: student, enrollment, package (4 sessions), occurrences, assign 2 entitlements.
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [globalThis.crypto.randomUUID(), f.studentId, f.classId]);
    const pkg = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4) RETURNING id;`, [globalThis.crypto.randomUUID(), f.studentId, f.plan4Id, f.classId]);
    const pkgId = (pkg.rows[0] as { id: string }).id;
    const occ1 = globalThis.crypto.randomUUID();
    const occ2 = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2026-01-06', '2026-01-06 15:00:00', '2026-01-06 16:00:00', 'planned', 12);`, [occ1, f.academyId, f.classId, f.tueSlotId, f.scheduleVersionId]);
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2026-01-13', '2026-01-13 15:00:00', '2026-01-13 16:00:00', 'planned', 12);`, [occ2, f.academyId, f.classId, f.tueSlotId, f.scheduleVersionId]);
    const ent1 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, original_occurrence_id, assigned_occurrence_id, status) VALUES ($1, $2, 1, $3, $3, 'active') RETURNING id;`, [globalThis.crypto.randomUUID(), pkgId, occ1]);
    const ent2 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, original_occurrence_id, assigned_occurrence_id, status) VALUES ($1, $2, 2, $3, $3, 'active') RETURNING id;`, [globalThis.crypto.randomUUID(), pkgId, occ2]);
    const ent1Id = (ent1.rows[0] as { id: string }).id;
    const ent2Id = (ent2.rows[0] as { id: string }).id;

    // Two concurrent skips on DIFFERENT entitlements in the SAME package.
    // The one-skip-per-package rule should allow only one.
    const adapter1 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const adapter2 = new PgAdapter(process.env.TEST_DATABASE_URL!);

    const skip1 = adapter1.withTxSerializable(async (tx) => {
      await tx.query(`SELECT id FROM student_packages WHERE id = $1 FOR UPDATE;`, [pkgId]);
      const sc = await tx.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1 AND skip_used = TRUE;`, [pkgId]);
      if ((sc.rows[0] as { c: number }).c >= 1) throw new Error("skip allowance exceeded");
      await tx.query(`UPDATE session_entitlements SET status = 'skipped', assigned_occurrence_id = NULL, skip_used = TRUE WHERE id = $1;`, [ent1Id]);
      return "skipped";
    });

    const skip2 = adapter2.withTxSerializable(async (tx) => {
      await tx.query(`SELECT id FROM student_packages WHERE id = $1 FOR UPDATE;`, [pkgId]);
      const sc = await tx.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1 AND skip_used = TRUE;`, [pkgId]);
      if ((sc.rows[0] as { c: number }).c >= 1) throw new Error("skip allowance exceeded");
      await tx.query(`UPDATE session_entitlements SET status = 'skipped', assigned_occurrence_id = NULL, skip_used = TRUE WHERE id = $1;`, [ent2Id]);
      return "skipped";
    });

    const results = await Promise.allSettled([skip1, skip2]);
    await adapter1.close();
    await adapter2.close();

    // Exactly one should succeed.
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBe(1);

    // Verify only one entitlement has skip_used=TRUE.
    const skipCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1 AND skip_used = TRUE;`, [pkgId]);
    expect((skipCount.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await cleanup();
  }
});
