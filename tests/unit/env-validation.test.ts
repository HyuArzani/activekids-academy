/**
 * Tests for production environment validation (Phase A3 P0 fix).
 *
 * Verifies that `loadEnv()` rejects a non-PostgreSQL `DATABASE_URL` in
 * production, preventing the silent PgLite fallback that would lose data
 * on every serverless cold-start.
 *
 * These are unit tests — no database connection, no server, no secrets.
 * They manipulate `process.env` directly (saved/restored around each test).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { __resetEnvForTesting } from "@/lib/env";

// Save the original env so we can restore it after each test.
const originalEnv = { ...process.env };

beforeEach(() => {
  // Clear potentially-interfering env vars. We set a clean production env
  // for each test, then restore the original after.
  __resetEnvForTesting();
  delete process.env.NODE_ENV;
  delete process.env.DATABASE_URL;
  delete process.env.SESSION_SECRET;
  delete process.env.CSRF_SECRET;
  delete process.env.DB_POOL_MAX;
});

afterEach(() => {
  // Restore the original environment.
  __resetEnvForTesting();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

// === P0: Production rejects non-PostgreSQL DATABASE_URL ===================

test("Production rejects file: DATABASE_URL (prevents silent PgLite fallback)", async () => {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "file:/path/to/db";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  // Clear the module cache so loadEnv re-validates.
  const envModule = await import("@/lib/env");
  // Accessing `env` triggers loadEnv() which should throw.
  expect(() => envModule.isProd()).toThrow(/DATABASE_URL must be a PostgreSQL/);
});

test("Production rejects empty DATABASE_URL", async () => {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  expect(() => envModule.isProd()).toThrow(/DATABASE_URL is required/);
});

test("Production rejects sqlite: DATABASE_URL", async () => {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "sqlite::memory:";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  expect(() => envModule.isProd()).toThrow(/DATABASE_URL must be a PostgreSQL/);
});

test("Production accepts postgres:// DATABASE_URL", async () => {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgres://user:pass@host:5432/db";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  expect(envModule.isProd()).toBe(true);
});

test("Production accepts postgresql:// DATABASE_URL", async () => {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db?sslmode=require";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  expect(envModule.isProd()).toBe(true);
});

test("Production rejects placeholder SESSION_SECRET", async () => {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgres://user:pass@host:5432/db";
  process.env.SESSION_SECRET = "replace_with_random_64_hex_chars";
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  expect(() => envModule.isProd()).toThrow(/placeholder secret/);
});

test("Production rejects the committed environment-template secret", async () => {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgres://user:***@host:5432/db";
  process.env.SESSION_SECRET = "replace_with_random_secret_at_least_32_chars";
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  expect(() => envModule.isProd()).toThrow(/placeholder secret/);
});
test("Development accepts non-PostgreSQL DATABASE_URL (PgLite fallback OK in dev)", async () => {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = "file:/path/to/db";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  expect(envModule.isProd()).toBe(false);
});

// === P1: DB_POOL_MAX is configurable ====================================

test("DB_POOL_MAX defaults to 10 when not set", async () => {
  process.env.NODE_ENV = "development";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  const env = envModule.env;
  expect(env.DB_POOL_MAX).toBe(10);
});

test("DB_POOL_MAX can be set to 1 for serverless", async () => {
  process.env.NODE_ENV = "development";
  process.env.DB_POOL_MAX = "1";
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.CSRF_SECRET = "b".repeat(64);
  const envModule = await import("@/lib/env");
  const env = envModule.env;
  expect(env.DB_POOL_MAX).toBe(1);
});
