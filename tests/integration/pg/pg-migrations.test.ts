/**
 * PostgreSQL integration tests: migrations, triggers, constraints.
 *
 * These tests ONLY run when TEST_DATABASE_URL is set to a real
 * postgres:// URL. When unset, ALL tests are SKIPPED.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://... NODE_ENV=test bun test tests/integration/pg/pg-migrations.test.ts
 */

import { expect } from "bun:test";
import { pgTest, setupPgDb, seedPgFixture } from "./_helpers";

pgTest("all 9 migrations apply to a fresh PostgreSQL database", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const result = await db.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename;`,
    );
    expect(result.rows.length).toBe(9);
    expect(result.rows.map((r) => r.filename)).toEqual([
      "0001_identity_and_access.sql",
      "0002_students_and_classes.sql",
      "0003_scheduling.sql",
      "0004_packages_and_entitlements.sql",
      "0005_attendance_reports_videos.sql",
      "0006_payments_and_expenses.sql",
      "0007_audit_events.sql",
      "0008_authentication_extensions.sql",
      "0009_domain_invariant_extensions.sql",
    ]);
  } finally {
    await cleanup();
  }
});

pgTest("original_occurrence_id immutability trigger fires on UPDATE (real PostgreSQL)", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    
    // Create enrollment + package + entitlement + occurrence.
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [globalThis.crypto.randomUUID(), f.studentId, f.classId]);
    const pkg = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4) RETURNING id;`, [globalThis.crypto.randomUUID(), f.studentId, f.plan4Id, f.classId]);
    const pkgId = (pkg.rows[0] as { id: string }).id;
    const occ1 = globalThis.crypto.randomUUID();
    const occ2 = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2026-01-06', '2026-01-06 15:00:00', '2026-01-06 16:00:00', 'planned', 12);`, [occ1, f.academyId, f.classId, f.tueSlotId, f.scheduleVersionId]);
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2026-01-13', '2026-01-13 15:00:00', '2026-01-13 16:00:00', 'planned', 12);`, [occ2, f.academyId, f.classId, f.tueSlotId, f.scheduleVersionId]);
    const ent = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, original_occurrence_id, assigned_occurrence_id, status) VALUES ($1, $2, 1, $3, $3, 'active') RETURNING id;`, [globalThis.crypto.randomUUID(), pkgId, occ1]);

    // Try to change original_occurrence_id → should fail.
    try {
      await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2 WHERE id = $1;`, [ent.rows[0] as { id: string }, occ2]);
      expect.fail("trigger should have blocked the UPDATE");
    } catch (err) {
      // The error should contain "immutable".
      const msg = (err as { serverCause?: { message?: string } }).serverCause?.message ?? (err as Error).message;
      expect(msg).toContain("immutable");
    }
  } finally {
    await cleanup();
  }
});

pgTest("class_id_at_purchase immutability trigger fires on UPDATE", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [globalThis.crypto.randomUUID(), f.studentId, f.classId]);
    const pkg = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1, $2, $3, $4) RETURNING id;`, [globalThis.crypto.randomUUID(), f.studentId, f.plan4Id, f.classId]);

    try {
      await db.query(`UPDATE student_packages SET class_id_at_purchase = $2 WHERE id = $1;`, [(pkg.rows[0] as { id: string }).id, globalThis.crypto.randomUUID()]);
      expect.fail("trigger should have blocked the UPDATE");
    } catch (err) {
      const msg = (err as { serverCause?: { message?: string } }).serverCause?.message ?? (err as Error).message;
      expect(msg).toContain("immutable");
    }
  } finally {
    await cleanup();
  }
});

pgTest("capacity trigger rejects over-capacity assignment", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    
    // Create a class with capacity=1.
    const smallClassId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Small', 1, true);`, [smallClassId, f.academyId]);
    const versionId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, smallClassId]);
    const slotId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '18:00', '19:00');`, [slotId, versionId]);
    const occId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2026-01-06', '2026-01-06 18:00:00', '2026-01-06 19:00:00', 'planned', 1);`, [occId, f.academyId, smallClassId, slotId, versionId]);
    // Two students.
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
    // First assignment succeeds.
    await db.query(`UPDATE session_entitlements SET original_occurrence_id = $2, assigned_occurrence_id = $2 WHERE id = $1;`, [(ent1.rows[0] as { id: string }).id, occId]);
    // Second assignment to the same occurrence → over capacity.
    try {
      await db.query(`UPDATE session_entitlements SET assigned_occurrence_id = $2 WHERE id = $1;`, [(ent2.rows[0] as { id: string }).id, occId]);
      expect.fail("trigger should have blocked over-capacity");
    } catch (err) {
      const msg = (err as { serverCause?: { message?: string } }).serverCause?.message ?? (err as Error).message;
      expect(msg).toContain("capacity");
    }
  } finally {
    await cleanup();
  }
});

pgTest("CHECK constraints reject invalid data on real PostgreSQL", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    // users.status CHECK rejects invalid status.
    try {
      await db.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'invalid');`, [globalThis.crypto.randomUUID(), "check-test@test.example"]);
      expect.fail("CHECK should reject invalid status");
    } catch (err) {
      const msg = (err as { serverCause?: { message?: string } }).serverCause?.message ?? (err as Error).message;
      expect(msg.toLowerCase()).toContain("check");
    }
  } finally {
    await cleanup();
  }
});

pgTest("seed is idempotent on real PostgreSQL", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    
    // Run seed again — should be idempotent (ON CONFLICT DO NOTHING/UPDATE).
    await seedPgFixture(db);
    const count = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM academies WHERE slug = 'pgtest';`);
    expect((count.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await cleanup();
  }
});
