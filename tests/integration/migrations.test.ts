/**
 * Integration test: migration runner.
 *
 * Verifies against an IN-MEMORY PgLite instance (NOT a real PostgreSQL
 * server). The same SQL applies under real PostgreSQL — but concurrency,
 * locking, and full-extension behavior is NOT equivalent. Real PostgreSQL
 * integration tests remain mandatory before production deployment.
 *
 * Covers:
 *   - All 7 migrations apply cleanly to a fresh PgLite.
 *   - `schema_migrations` table is bootstrapped and tracks applied files.
 *   - Re-running applyAllMigrations is idempotent (no duplicate applies).
 *   - All expected tables exist post-migration.
 *   - Checksum tamper detection: modifying a previously-applied file's
 *     checksum raises a CONFIG_INVALID error.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createPgLiteAdapter, type DbClient } from "@/lib/db";
import { applyAllMigrations, bootstrapSchemaMigrations, getAppliedMigrations, listMigrationFiles, applyMigrationFile } from "@/lib/db/migrate";
import { AppError } from "@/lib/errors";

let raw: PGlite;
let db: DbClient;

beforeEach(async () => {
  raw = new PGlite(); // in-memory
  db = createPgLiteAdapter(raw);
});

afterEach(async () => {
  await db.close().catch(() => {});
});

test("all migrations apply to a fresh PgLite and record 16 rows", async () => {
  const applied = await applyAllMigrations(db);
  expect(applied.length).toBe(16);
  const recorded = await getAppliedMigrations(db);
  expect(recorded.size).toBe(16);
  expect(Array.from(recorded.keys())).toEqual([
    "0001_identity_and_access.sql",
    "0002_students_and_classes.sql",
    "0003_scheduling.sql",
    "0004_packages_and_entitlements.sql",
    "0005_attendance_reports_videos.sql",
    "0006_payments_and_expenses.sql",
    "0007_audit_events.sql",
    "0008_authentication_extensions.sql",
    "0009_domain_invariant_extensions.sql",
    "0010_payment_manual_workflow.sql",
    "0011_payment_notes.sql",
    "0012_cms_landing_pages.sql",
    "0013_registration_applications.sql",
    "0014_student_training_video_extensions.sql",
    "0015_registration_guardian_resolution.sql",
    "0016_scheduling_mutations.sql",
  ]);
});

test("re-running applyAllMigrations is idempotent (no new applies)", async () => {
  await applyAllMigrations(db);
  const secondRun = await applyAllMigrations(db);
  expect(secondRun.length).toBe(0);
});

test("all expected tables exist post-migration", async () => {
  await applyAllMigrations(db);
  const expected = [
    "academies",
    "users",
    "user_credentials",
    "sessions",
    "academy_memberships",
    "students",
    "classes",
    "student_enrollments",
    "guardian_student_links",
    "coach_student_assignments",
    "schedule_versions",
    "schedule_slots",
    "training_occurrences",
    "package_plans",
    "student_packages",
    "session_entitlements",
    "entitlement_events",
    "semesters",
    "attendance_records",
    "student_reports",
    "student_training_videos",
    "payments",
    "payment_allocations",
    "academy_expenses",
    "audit_events",
  ];
  for (const t of expected) {
    const r = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists;`,
      [t],
    );
    const exists = (r.rows[0] as { exists: boolean }).exists;
    expect(exists, `table ${t} should exist`).toBe(true);
  }
});

test("checksum tamper detection rejects a modified applied file", async () => {
  await applyAllMigrations(db);
  // Simulate tampering: overwrite the stored checksum of an applied
  // migration with a wrong value. Re-running applyAllMigrations must detect
  // the mismatch (stored != file-on-disk) and throw CONFIG_INVALID.
  await db.query(
    "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1;",
    ["0001_identity_and_access.sql", "tampered-checksum-not-the-real-one"],
  );
  let threw = false;
  try {
    await applyAllMigrations(db);
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("CONFIG_INVALID");
  }
  expect(threw, "checksum mismatch must throw").toBe(true);
});

test("bootstrapSchemaMigrations is idempotent — calling twice does not error", async () => {
  await bootstrapSchemaMigrations(db);
  await bootstrapSchemaMigrations(db);
  const r = await db.query<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_name = 'schema_migrations';",
  );
  expect((r.rows[0] as { c: number }).c).toBe(1);
});

test("applyMigrationFile writes the migration row atomically with the SQL", async () => {
  await bootstrapSchemaMigrations(db);
  const files = await listMigrationFiles();
  const first = files[0];
  if (!first) throw new Error("no migration files found");
  await applyMigrationFile(db, first);
  const recorded = await getAppliedMigrations(db);
  expect(recorded.has(first.filename)).toBe(true);
  expect(recorded.get(first.filename)).toBe(first.checksum);
});

test("listMigrationFiles returns files in lexical order", async () => {
  const files = await listMigrationFiles();
  const names = files.map((f) => f.filename);
  const sorted = [...names].sort();
  expect(names).toEqual(sorted);
});
