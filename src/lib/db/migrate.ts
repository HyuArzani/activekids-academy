/**
 * Reusable migration logic — adapter-neutral. Works with any `TxClient`
 * (PgLiteAdapter, PgAdapter, or any other `DbClient` implementation).
 *
 * Both the CLI runner (scripts/migrate.ts) and integration tests use this
 * so the code path is identical for PgLite and real PostgreSQL.
 *
 * The runner creates `schema_migrations` if absent, validates checksums of
 * already-applied files, and applies each pending migration inside its own
 * transaction (BEGIN/COMMIT/ROLLBACK).
 *
 * The same migration files, checksums, history table, and transaction
 * semantics are used for both adapters. No adapter-specific code here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "@/lib/errors";
import type { TxClient } from "@/lib/db";

// Resolve from process.cwd() so both CLI scripts and tests find the same
// migrations directory regardless of where the importing module lives.
const MIGRATIONS_DIR = join(process.cwd(), "migrations");

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

/**
 * Split a SQL string into individual statements. Required because both
 * PgLite and the `pg` driver reject multi-statement SQL when using the
 * extended query protocol (parameterized `query()`). The splitter
 * respects:
 *   - line comments (`--` to end of line)
 *   - block comments (slash-asterisk … asterisk-slash)
 *   - single-quoted strings (`'…'`), including `''` escaping
 *   - dollar-quoted strings (`$$…$$` or `$tag$…$tag$`), used by PL/pgSQL
 *     function bodies.
 *
 * Returns trimmed, non-empty statements with their trailing `;` preserved.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string | undefined;
    const next = sql[i + 1] as string | undefined;
    if (ch === undefined) break;

    // Line comment
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        current += sql[i];
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      current += "/*";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        current += sql[i];
        i++;
      }
      if (i < sql.length) {
        current += "*/";
        i += 2;
      }
      continue;
    }
    // Dollar-quoted string ($$ or $tag$)
    if (ch === "$") {
      const m = /^\$(\w*)\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        current += tag;
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx === -1) {
          // Unterminated — append rest, do not error.
          current += sql.slice(i);
          i = sql.length;
        } else {
          current += sql.slice(i, closeIdx + tag.length);
          i = closeIdx + tag.length;
        }
        continue;
      }
    }
    // Single-quoted string
    if (ch === "'") {
      current += "'";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          current += "'";
          i++;
          break;
        }
        current += sql[i];
        i++;
      }
      continue;
    }
    // Statement separator
    if (ch === ";") {
      current += ";";
      i++;
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
    i++;
  }
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

export async function listMigrationFiles(): Promise<MigrationFile[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((filename) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { filename, sql, checksum };
  });
}

/**
 * Create the `schema_migrations` table if it does not exist. Idempotent.
 * Works with any `TxClient` (PgLite or real PostgreSQL).
 */
export async function bootstrapSchemaMigrations(tx: TxClient): Promise<void> {
  for (const stmt of splitSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `)) {
    await tx.query(stmt);
  }
}

export interface AppliedMigration {
  filename: string;
  checksum: string;
}

/**
 * Get the map of applied migrations (filename → checksum) from the
 * `schema_migrations` table. Works with any `TxClient`.
 */
export async function getAppliedMigrations(tx: TxClient): Promise<Map<string, string>> {
  const result = await tx.query<{ filename: string; checksum: string }>(
    "SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC;",
  );
  const rows = (result.rows ?? []) as unknown as AppliedMigration[];
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

/**
 * Apply a single migration file inside its own transaction (BEGIN/COMMIT/
 * ROLLBACK). Works with any `TxClient`.
 */
export async function applyMigrationFile(tx: TxClient, m: MigrationFile): Promise<void> {
  await tx.query("BEGIN;");
  try {
    for (const stmt of splitSql(m.sql)) {
      await tx.query(stmt);
    }
    await tx.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2);",
      [m.filename, m.checksum],
    );
    await tx.query("COMMIT;");
  } catch (err) {
    try {
      await tx.query("ROLLBACK;");
    } catch {
      // best effort
    }
    throw err;
  }
}

/**
 * Apply all pending migrations. Validates checksums of already-applied
 * files (tamper detection). Returns the list of migrations applied in
 * this call.
 *
 * Adapter-neutral: works with PgLiteAdapter, PgAdapter, or any other
 * `DbClient` / `TxClient` implementation. The same migration files,
 * checksums, history table, and transaction semantics are used for
 * both adapters.
 */
export async function applyAllMigrations(tx: TxClient): Promise<MigrationFile[]> {
  await bootstrapSchemaMigrations(tx);
  const applied = await getAppliedMigrations(tx);
  const files = await listMigrationFiles();

  for (const f of files) {
    const prev = applied.get(f.filename);
    if (prev !== undefined && prev !== f.checksum) {
      throw new AppError({
        code: "CONFIG_INVALID",
        message: `Migration ${f.filename} checksum mismatch — file was modified after being applied.`,
      });
    }
  }

  const pending = files.filter((f) => !applied.has(f.filename));
  for (const f of pending) {
    await applyMigrationFile(tx, f);
  }
  return pending;
}
