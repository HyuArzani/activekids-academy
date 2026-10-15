/**
 * Integration test: database adapter (transaction commit / rollback,
 * query normalization, SERIALIZABLE tx wiring).
 *
 * Runs against an IN-MEMORY PgLite. Important caveat: PgLite is
 * single-process, so `withTxSerializable` does NOT prove real-server
 * concurrent contention behavior. It proves only that the application-level
 * transaction wiring is correct (BEGIN/COMMIT/ROLLBACK, isolation level
 * set). Real PostgreSQL integration tests are mandatory before production.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { applyAllMigrations } from "@/lib/db/migrate";
import { createPgLiteAdapter, type DbClient } from "@/lib/db";
import { AppError } from "@/lib/errors";

let raw: PGlite;
let db: DbClient;

beforeEach(async () => {
  raw = new PGlite(); // in-memory
  await applyAllMigrations(raw);
  db = createPgLiteAdapter(raw);
});

afterEach(async () => {
  await db.close().catch(() => {});
});

test("withTx commits on success — inserted row is visible after commit", async () => {
  await db.withTx(async (tx) => {
    await tx.query(
      `INSERT INTO academies (id, name, slug, timezone, is_active)
       VALUES ($1, 'Test Academy', 'test', 'Asia/Jakarta', true);`,
      ["00000000-0000-0000-0000-000000000001"],
    );
  });
  const r = await db.query<{ name: string }>(
    `SELECT name FROM academies WHERE id = $1;`,
    ["00000000-0000-0000-0000-000000000001"],
  );
  expect(r.rows.length).toBe(1);
  expect((r.rows[0] as { name: string }).name).toBe("Test Academy");
});

test("withTx rolls back on throw — no row visible after rollback", async () => {
  await expect(
    db.withTx(async (tx) => {
      await tx.query(
        `INSERT INTO academies (id, name, slug, timezone, is_active)
         VALUES ($1, 'Rollback Academy', 'rollback', 'Asia/Jakarta', true);`,
        ["00000000-0000-0000-0000-000000000002"],
      );
      throw new Error("simulated failure");
    }),
  ).rejects.toThrow("simulated failure");
  const r = await db.query<{ name: string }>(
    `SELECT name FROM academies WHERE id = $1;`,
    ["00000000-0000-0000-0000-000000000002"],
  );
  expect(r.rows.length).toBe(0);
});

test("withTxSerializable commits on success", async () => {
  await db.withTxSerializable(async (tx) => {
    await tx.query(
      `INSERT INTO academies (id, name, slug, timezone, is_active)
       VALUES ($1, 'Serializable Academy', 'serial', 'Asia/Jakarta', true);`,
      ["00000000-0000-0000-0000-000000000003"],
    );
  });
  const r = await db.query<{ name: string }>(
    `SELECT name FROM academies WHERE id = $1;`,
    ["00000000-0000-0000-0000-000000000003"],
  );
  expect(r.rows.length).toBe(1);
});

test("withTxSerializable rolls back on throw", async () => {
  await expect(
    db.withTxSerializable(async (tx) => {
      await tx.query(
        `INSERT INTO academies (id, name, slug, timezone, is_active)
         VALUES ($1, 'Should Rollback', 'should-rollback', 'Asia/Jakarta', true);`,
        ["00000000-0000-0000-0000-000000000004"],
      );
      throw new Error("rollback-please");
    }),
  ).rejects.toThrow("rollback-please");
  const r = await db.query<{ name: string }>(
    `SELECT name FROM academies WHERE id = $1;`,
    ["00000000-0000-0000-0000-000000000004"],
  );
  expect(r.rows.length).toBe(0);
});

test("query normalizes rows and rowCount", async () => {
  // Insert 3 academies
  for (let i = 0; i < 3; i++) {
    await db.query(
      `INSERT INTO academies (id, name, slug, timezone, is_active)
       VALUES ($1, $2, $3, 'Asia/Jakarta', true);`,
      [
        `00000000-0000-0000-0000-0000000000${10 + i}`,
        `Academy ${i}`,
        `slug-${i}`,
      ],
    );
  }
  const r = await db.query<{ name: string }>(
    `SELECT name FROM academies ORDER BY name;`,
  );
  expect(r.rows.length).toBe(3);
  expect(r.rowCount).toBeGreaterThanOrEqual(3);
  expect(r.rows.map((x) => (x as { name: string }).name)).toEqual([
    "Academy 0",
    "Academy 1",
    "Academy 2",
  ]);
});

test("a thrown database error is wrapped in AppError(UPSTREAM_ERROR) and never leaks SQL", async () => {
  let caught: unknown = null;
  try {
    await db.query(`SELECT * FROM nonexistent_table_xyz;`);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  const ae = caught as AppError;
  expect(ae.code).toBe("UPSTREAM_ERROR");
  expect(ae.message).not.toContain("nonexistent_table_xyz");
});

test("nested throw inside withTx does not leak a dangling open transaction", async () => {
  // After a rollback, the connection must be usable for the next call.
  await expect(
    db.withTx(async (tx) => {
      await tx.query(
        `INSERT INTO academies (id, name, slug, timezone, is_active)
         VALUES ($1, 'Leak Test', 'leak', 'Asia/Jakarta', true);`,
        ["00000000-0000-0000-0000-000000000099"],
      );
      throw new Error("intentional");
    }),
  ).rejects.toThrow("intentional");
  // Next call must work cleanly (proves no leftover BEGIN).
  await db.withTx(async (tx) => {
    await tx.query(
      `INSERT INTO academies (id, name, slug, timezone, is_active)
       VALUES ($1, 'After Leak', 'after-leak', 'Asia/Jakarta', true);`,
      ["00000000-0000-0000-0000-000000000100"],
    );
  });
  const r = await db.query<{ name: string }>(
    `SELECT name FROM academies WHERE id = $1;`,
    ["00000000-0000-0000-0000-000000000100"],
  );
  expect(r.rows.length).toBe(1);
});
