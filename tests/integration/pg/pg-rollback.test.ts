/**
 * PostgreSQL integration tests: transaction rollback + SQLSTATE error
 * classification.
 *
 * These tests ONLY run when TEST_DATABASE_URL is set.
 */

import { expect, test } from "bun:test";
import { pgTest, setupPgDb, seedPgFixture } from "./_helpers";
import { AppError } from "@/lib/errors";
import { SQLSTATE, isRetryableConflict } from "@/lib/db/pg-errors";

pgTest("withTxSerializable rolls back on throw — no partial changes", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);

    // Insert a student, then throw inside the transaction.
    const studentId = globalThis.crypto.randomUUID();
    try {
      await db.withTxSerializable(async (tx) => {
        await tx.query(
          `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Rollback Student');`,
          [studentId, f.academyId],
        );
        throw new Error("intentional rollback");
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("intentional rollback");
    }

    // Verify the student was NOT inserted (transaction rolled back).
    const result = await db.query(`SELECT id FROM students WHERE id = $1;`, [studentId]);
    expect(result.rows.length).toBe(0);
  } finally {
    await cleanup();
  }
});

pgTest("UNIQUE violation (23505) is classified as CONFLICT", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    // Insert a class.
    const classId = globalThis.crypto.randomUUID();
    await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1, $2, 'Unique Class', 10);`, [classId, f.academyId]);
    // Try to insert a student with a duplicate email.
    try {
      await db.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active');`, [globalThis.crypto.randomUUID(), "pg-admin@test.example"]);
      expect.fail("should have thrown CONFLICT");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("CONFLICT");
      // Verify the SQLSTATE is preserved in serverCause.
      const cause = (err as AppError).serverCause as { code?: string };
      expect(cause?.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    }
  } finally {
    await cleanup();
  }
});

pgTest("CHECK violation (23514) is classified as VALIDATION_FAILED", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    try {
      await db.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'bogus');`, [globalThis.crypto.randomUUID(), "check@test.example"]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("VALIDATION_FAILED");
      const cause = (err as AppError).serverCause as { code?: string };
      expect(cause?.code).toBe(SQLSTATE.CHECK_VIOLATION);
    }
  } finally {
    await cleanup();
  }
});

pgTest("FK violation (23503) is classified as CONFLICT", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    // Try to insert a student with a non-existent academy_id.
    try {
      await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'FK Test');`, [globalThis.crypto.randomUUID(), globalThis.crypto.randomUUID()]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("CONFLICT");
      const cause = (err as AppError).serverCause as { code?: string };
      expect(cause?.code).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
    }
  } finally {
    await cleanup();
  }
});

test("isRetryableConflict identifies 40001/40P01 errors (unit test, no PG needed)", async () => {
  // Unit test — doesn't need a real DB.
  const retryable = new AppError({
    code: "CONFLICT",
    message: "Transaction conflict",
    detail: "retryable",
  });
  expect(isRetryableConflict(retryable)).toBe(true);

  const nonRetryable = new AppError({
    code: "CONFLICT",
    message: "A record with this key already exists",
  });
  expect(isRetryableConflict(nonRetryable)).toBe(false);
});
