/**
 * Tests for the destructive-test safety check.
 *
 * These tests are UNIT tests — they test the `assertTestDatabaseSafety`
 * function itself, NOT a real PostgreSQL connection. They always run
 * (no TEST_DATABASE_URL needed).
 *
 * They verify that:
 *   - Empty TEST_DATABASE_URL is rejected.
 *   - Non-postgres:// URLs are rejected.
 *   - Database names that don't end in _test are rejected.
 *   - Forbidden database names (postgres, futsal_academy, etc.) are rejected.
 *   - Safe database names (ending in _test) are accepted.
 *   - No credentials are printed in error messages.
 */

import { test, expect } from "bun:test";
import { assertTestDatabaseSafety } from "./_helpers";

test("empty connection string is rejected", () => {
  expect(() => assertTestDatabaseSafety("")).toThrow("TEST_DATABASE_URL is not set");
});

test("non-postgres URL is rejected", () => {
  expect(() => assertTestDatabaseSafety("mysql://user:pass@localhost/db")).toThrow(
    "must be a postgres:// or postgresql:// URL",
  );
});

test("missing database name is rejected", () => {
  expect(() =>
    assertTestDatabaseSafety("postgresql://user:pass@localhost:5432/"),
  ).toThrow("must include a database name");
});

test("production-like database name is rejected", () => {
  expect(() =>
    assertTestDatabaseSafety("postgresql://user:pass@localhost:5432/futsal_academy"),
  ).toThrow("forbidden");
});

test("system database name 'postgres' is rejected", () => {
  expect(() =>
    assertTestDatabaseSafety("postgresql://user:pass@localhost:5432/postgres"),
  ).toThrow("forbidden");
});

test("database name not ending in _test is rejected", () => {
  expect(() =>
    assertTestDatabaseSafety("postgresql://user:pass@localhost:5432/my_database"),
  ).toThrow("must end in \"_test\"");
});

test("database name ending in _test is accepted", () => {
  expect(() =>
    assertTestDatabaseSafety("postgresql://user:pass@localhost:5432/futsal_academy_test"),
  ).not.toThrow();
});

test("database name ending in _TEST (case-insensitive) is accepted", () => {
  expect(() =>
    assertTestDatabaseSafety("postgresql://user:pass@localhost:5432/MyDB_TEST"),
  ).not.toThrow();
});

test("error messages do not contain credentials", () => {
  const unsafeUrl = "postgresql://myuser:mypassword123@localhost:5432/production";
  try {
    assertTestDatabaseSafety(unsafeUrl);
    expect.fail("should have thrown");
  } catch (err) {
    const msg = (err as Error).message;
    expect(msg).not.toContain("mypassword123");
    expect(msg).not.toContain("myuser");
  }
});

test("diagnostic output prints host and database name but not credentials", () => {
  // Capture console.info output.
  const originalInfo = console.info;
  let captured = "";
  console.info = (msg: string) => { captured = msg; };
  try {
    assertTestDatabaseSafety("postgresql://secretuser:secretpass@db.example.com:6543/mydb_test");
  } finally {
    console.info = originalInfo;
  }
  expect(captured).toContain("db.example.com");
  expect(captured).toContain("mydb_test");
  expect(captured).not.toContain("secretpass");
  expect(captured).not.toContain("secretuser");
});
