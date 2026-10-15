/**
 * Versioned raw-SQL migration runner (CLI). Delegates to the shared
 * adapter-neutral migration logic in src/lib/db/migrate.ts so the code
 * path is identical for CLI invocation and integration tests, and works
 * with both PgLite and real PostgreSQL.
 *
 * Adapter selection: uses `getDb()` which selects PgLite (dev/test) or
 * PgAdapter (production, if DATABASE_URL is a postgres:// URL).
 *
 * Usage:
 *   bun run --bun scripts/migrate.ts            # apply pending
 *   bun run --bun scripts/migrate.ts --status  # list applied + pending
 */

import { loadEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { getDb } from "@/lib/db";
import {
  applyAllMigrations,
  bootstrapSchemaMigrations,
  getAppliedMigrations,
  listMigrationFiles,
} from "@/lib/db/migrate";

async function main() {
  loadEnv();
  const db = getDb();
  try {
    if (process.argv.includes("--status")) {
      await bootstrapSchemaMigrations(db);
      const applied = await getAppliedMigrations(db);
      const files = await listMigrationFiles();
      console.info("Applied:");
      for (const f of files.filter((f) => applied.has(f.filename))) {
        console.info(`  ✓ ${f.filename}`);
      }
      console.info("Pending:");
      for (const f of files.filter((f) => !applied.has(f.filename))) {
        console.info(`  • ${f.filename}`);
      }
      return;
    }
    const applied = await applyAllMigrations(db);
    if (applied.length === 0) {
      console.info("No pending migrations.");
    } else {
      for (const m of applied) {
        console.info(`Applied ${m.filename}`);
      }
      console.info(`Total: ${applied.length} migration(s).`);
    }
  } finally {
    await db.close().catch(() => {});
  }
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(err.message, err.detail ?? "");
  } else {
    console.error("Migration failed:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
