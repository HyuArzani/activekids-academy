/**
 * PostgreSQL integration test helpers.
 *
 * These tests ONLY run when `TEST_DATABASE_URL` is set to a real
 * `postgres://` or `postgresql://` URL. When unset, ALL tests in the
 * `pg/` directory are SKIPPED (not passed, not failed) — they are NOT
 * substituted with PgLite.
 *
 * ## Destructive-test safety
 *
 * Before any destructive SQL (DROP TABLE) executes, `assertTestDatabaseSafety`
 * checks the database name. It MUST:
 *   - End in `_test` (e.g., `futsal_academy_test`)
 *   - NOT be `postgres`, `template1`, or any production-like name
 *
 * `DATABASE_URL` is NEVER used as a fallback for destructive tests.
 * Only `TEST_DATABASE_URL` is accepted.
 *
 * ## Unified migration runner
 *
 * Uses `applyAllMigrations` from `@/lib/db/migrate` — the same code path
 * as the CLI runner (`scripts/migrate.ts`) and the PgLite tests. No
 * duplicated inline migration logic.
 *
 * To run these tests:
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/futsal_academy_test \
 *     NODE_ENV=test bun test tests/integration/pg/
 */

import { Pool } from "pg";
import { applyAllMigrations } from "@/lib/db/migrate";
import { PgAdapter } from "@/lib/db/pg-adapter";
import { __setDbForTesting, type DbClient } from "@/lib/db";
import { randomUUID } from "node:crypto";

// === Safety check =========================================================

/**
 * Parse a PostgreSQL connection string and return the database name,
 * host, and port — WITHOUT credentials.
 */
function parseConnectionString(connectionString: string): {
  databaseName: string;
  host: string;
  port: string;
} {
  const url = new URL(connectionString);
  const databaseName = url.pathname.replace(/^\//, "");
  return {
    databaseName,
    host: url.hostname,
    port: url.port || "5432",
  };
}

/** Names that are always rejected (too dangerous for destructive tests). */
const FORBIDDEN_DATABASE_NAMES = new Set([
  "postgres",
  "template0",
  "template1",
  "futsal_academy",
  "production",
  "main",
  "primary",
]);

/**
 * Assert that the TEST_DATABASE_URL points to a database whose name
 * is clearly a test database (ends in `_test`). Reject production-like
 * names and system databases.
 *
 * Prints the host and database name for diagnostics. NEVER prints
 * credentials (user, password).
 *
 * @throws if the database name is unsafe for destructive tests.
 */
export function assertTestDatabaseSafety(connectionString: string): void {
  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Destructive PostgreSQL tests are skipped. " +
        "Set TEST_DATABASE_URL to a postgres:// URL pointing to a test database " +
        "(name must end in _test).",
    );
  }

  const lower = connectionString.toLowerCase();
  if (!lower.startsWith("postgres://") && !lower.startsWith("postgresql://")) {
    throw new Error(
      `TEST_DATABASE_URL must be a postgres:// or postgresql:// URL. Got: ${connectionString.replace(/\/\/[^@]+@/, "//<credentials>@")}`,
    );
  }

  const { databaseName, host, port } = parseConnectionString(connectionString);

  if (!databaseName) {
    throw new Error(
      `TEST_DATABASE_URL must include a database name in the path. ` +
        `Got: host=${host}, port=${port}, no database name.`,
    );
  }

  // Check forbidden names.
  if (FORBIDDEN_DATABASE_NAMES.has(databaseName.toLowerCase())) {
    throw new Error(
      `TEST_DATABASE_URL points to database "${databaseName}" on ${host}:${port}. ` +
        `This name is forbidden for destructive tests (too similar to a production database). ` +
        `Use a database name ending in "_test" (e.g., "futsal_academy_test").`,
    );
  }

  // Check that the name ends in _test.
  if (!databaseName.toLowerCase().endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL points to database "${databaseName}" on ${host}:${port}. ` +
        `The database name must end in "_test" for destructive tests. ` +
        `Got: "${databaseName}". Rename the database or use a different one.`,
    );
  }

  // Print diagnostics (no credentials).
  console.info(
    `[pg-tests] Using test database: ${databaseName} on ${host}:${port}`,
  );
}

// === Test conditional execution ==========================================

/** True when a real PostgreSQL TEST_DATABASE_URL is available. */
export const hasTestDb =
  !!process.env.TEST_DATABASE_URL &&
  (process.env.TEST_DATABASE_URL.startsWith("postgres://") ||
    process.env.TEST_DATABASE_URL.startsWith("postgresql://"));

/**
 * `test` when PG is available, `test.skip` otherwise. Tests using this
 * are SKIPPED (not passed) when no PostgreSQL server is configured.
 */
export const pgTest = hasTestDb ? (await import("bun:test")).test : (await import("bun:test")).test.skip;

/** The TEST_DATABASE_URL (only valid when hasTestDb is true). */
export const testDbUrl = process.env.TEST_DATABASE_URL ?? "";

// === Database setup =======================================================

/**
 * Drop all tables in the test database. Used at the start of each test
 * file to ensure a clean state. Also drops functions and the
 * schema_migrations table so migrations re-apply from scratch.
 *
 * GUARDED: calls `assertTestDatabaseSafety` before executing ANY SQL.
 */
export async function dropAllTables(connectionString: string): Promise<void> {
  assertTestDatabaseSafety(connectionString);

  const pool = new Pool({ connectionString, max: 1 });
  try {
    // Drop all tables in the public schema. CASCADE handles FK dependencies.
    await pool.query(`
      DO $$ BEGIN
        DECLARE r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
          FOR r IN (SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace) LOOP
            EXECUTE 'DROP FUNCTION IF EXISTS ' || quote_ident(r.proname) || '() CASCADE';
          END LOOP;
        END;
      END $$;
    `);
  } finally {
    await pool.end();
  }
}

/**
 * Create a fresh PgAdapter with all migrations applied via the unified
 * migration runner (`applyAllMigrations` from `@/lib/db/migrate`).
 *
 * Drops all existing tables first (via `dropAllTables` — guarded by the
 * safety check), then applies all 9 migrations through the PgAdapter.
 * Sets the global singleton so `getDb()` returns the PgAdapter for
 * domain services that call `getDb()` internally.
 *
 * Returns the adapter and a cleanup function.
 */
export async function setupPgDb(): Promise<{
  db: DbClient;
  cleanup: () => Promise<void>;
}> {
  await dropAllTables(testDbUrl);

  const db = new PgAdapter(testDbUrl);
  __setDbForTesting(db);

  // Apply all migrations through the unified runner — same code path
  // as the CLI (`scripts/migrate.ts`) and the PgLite tests.
  await applyAllMigrations(db);

  return {
    db,
    cleanup: async () => {
      await db.close();
      __setDbForTesting(null);
    },
  };
}

/** Seed a minimal academy + admin + class + schedule + plans for domain tests. */
export async function seedPgFixture(db: DbClient): Promise<{
  academyId: string;
  adminUserId: string;
  classId: string;
  scheduleVersionId: string;
  tueSlotId: string;
  satSlotId: string;
  plan4Id: string;
  plan8Id: string;
  studentId: string;
}> {
  const academyId = randomUUID();
  const adminUserId = randomUUID();
  const classId = randomUUID();
  const scheduleVersionId = randomUUID();
  const tueSlotId = randomUUID();
  const satSlotId = randomUUID();
  const plan4Id = randomUUID();
  const plan8Id = randomUUID();
  const studentId = randomUUID();

  await db.query(`INSERT INTO academies (id, name, slug, timezone, is_active) VALUES ($1, 'PG Test Academy', 'pgtest', 'Asia/Jakarta', true);`, [academyId]);
  await db.query(`INSERT INTO users (id, email, status, must_change_password) VALUES ($1, 'pg-admin@test.example', 'active', false);`, [adminUserId]);
  await db.query(`INSERT INTO academy_memberships (id, user_id, academy_id, role, status) VALUES ($1, $2, $3, 'admin', 'active');`, [randomUUID(), adminUserId, academyId]);
  await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'PG Class', 12, true);`, [classId, academyId]);
  await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [scheduleVersionId, classId]);
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '15:00', '16:00');`, [tueSlotId, scheduleVersionId]);
  await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 6, '15:00', '16:00');`, [satSlotId, scheduleVersionId]);
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count, is_active) VALUES ($1, $2, 'PG Starter 4', 4, true);`, [plan4Id, academyId]);
  await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count, is_active) VALUES ($1, $2, 'PG Standard 8', 8, true);`, [plan8Id, academyId]);
  await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'PG Student');`, [studentId, academyId]);

  return { academyId, adminUserId, classId, scheduleVersionId, tueSlotId, satSlotId, plan4Id, plan8Id, studentId };
}
