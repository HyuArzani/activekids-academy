/**
 * Typed, validated environment configuration.
 *
 * Reads `process.env`, validates it with Zod at process start, and exports a
 * frozen `env` object that is safe to import anywhere (server-only). Never
 * read `process.env` directly in application code — go through `env`.
 *
 * This module is server-only. Importing it from client code is a bug.
 */

import { z } from "zod";
import { AppError } from "@/lib/errors";

const schema = z.object({
  // Application
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ACADEMY_TIMEZONE: z.string().default("Asia/Jakarta"),

  // PgLite (local dev / test). Empty string = in-memory DB.
  PGLITE_DATA_DIR: z.string().default(""),

  // Real PostgreSQL connection string (production). Optional in dev.
  DATABASE_URL: z.string().optional().default(""),

  // Test-only: real PostgreSQL connection string for integration tests.
  // When set to a postgres:// URL, `getDb()` returns a `PgAdapter` instead
  // of `PgLiteAdapter`. Leave empty for PgLite-based tests.
  TEST_DATABASE_URL: z.string().optional().default(""),

  // Auth secrets — required, must be ≥32 chars. In production, must NOT be a
  // known placeholder. In dev/test we accept placeholders so first-run
  // experience works; production deployment MUST replace them.
  SESSION_SECRET: z
    .string()
    .refine((v) => v.length >= 32, "SESSION_SECRET must be ≥ 32 characters"),
  CSRF_SECRET: z
    .string()
    .refine((v) => v.length >= 32, "CSRF_SECRET must be ≥ 32 characters"),

  // Cookies
  SESSION_COOKIE_NAME: z.string().default("futsal_session"),
  CSRF_COOKIE_NAME: z.string().default("futsal_csrf"),

  // Session lifetimes (seconds)
  SESSION_LIFETIME_SECONDS: z.coerce.number().int().positive().default(43200),
  SESSION_ABSOLUTE_MAX_SECONDS: z.coerce.number().int().positive().default(604800),

  // Rate limits
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_BAN_MINUTES: z.coerce.number().int().positive().default(15),

  // PostgreSQL connection pool size. Default 10 (local dev).
  // Set to 1 for serverless (each function instance handles one request;
  // multiple instances scale horizontally). Prevents connection exhaustion
  // when many serverless instances each create a pool.
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Stage 9: configurable per-entitlement normal-move limit. Positive integer
  // (>= 1). The move count is derived from COUNT(entitlement_events WHERE
  // event_type='normal_moved') — no mutable counter. Server-side only; never
  // exposed to or settable by clients.
  NORMAL_MOVE_LIMIT_PER_ENTITLEMENT: z.coerce.number().int().positive().default(2),

  // Initial admin provisioning (one-time, optional). Format validated in
  // the provisioning script, not here, to keep env parsing tolerant.
  INITIAL_ADMIN_EMAIL: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Validate and return the environment. Throws a `ConfigError` (an `AppError`)
 * on invalid configuration so callers can render a safe error response.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Don't log secrets. The issues above mention field names only, not values.
    throw new AppError({
      code: "CONFIG_INVALID",
      httpStatus: 500,
      message: "Invalid environment configuration",
      detail: issues,
    });
  }
  // Production-only: refuse placeholder secrets. The check is on prefixes
  // only; the actual secret value is never compared or logged.
  if (parsed.data.NODE_ENV === "production") {
    for (const v of [parsed.data.SESSION_SECRET, parsed.data.CSRF_SECRET] as const) {
      if (v.startsWith("dev_only_change_me") || v === "replace_with_random_64_hex_chars") {
        throw new AppError({
          code: "CONFIG_INVALID",
          httpStatus: 500,
          message: "A placeholder secret is set in production. Generate a real secret.",
        });
      }
    }
    if (!parsed.data.DATABASE_URL) {
      throw new AppError({
        code: "CONFIG_INVALID",
        httpStatus: 500,
        message: "DATABASE_URL is required in production.",
      });
    }
    // P0 fix: reject non-PostgreSQL DATABASE_URL in production.
    // Prevents silent PgLite fallback when DATABASE_URL is misconfigured
    // (e.g., a leftover SQLite `file:` URL). The app must NOT silently
    // fall back to in-memory PgLite in production — that would lose data
    // on every serverless cold-start.
    const dbUrl = parsed.data.DATABASE_URL.toLowerCase();
    if (!dbUrl.startsWith("postgres://") && !dbUrl.startsWith("postgresql://")) {
      throw new AppError({
        code: "CONFIG_INVALID",
        httpStatus: 500,
        message: "DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://) in production. PgLite fallback is not permitted in production.",
      });
    }
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

/** Convenience accessor — validates on first use. */
export const env: Env = new Proxy({} as Env, {
  get(_t, prop: string) {
    return (loadEnv() as unknown as Record<string, unknown>)[prop];
  },
});

/** True when the active runtime is production. */
export function isProd(): boolean {
  return loadEnv().NODE_ENV === "production";
}

/** True when running under `bun test`. */
export function isTest(): boolean {
  return loadEnv().NODE_ENV === "test" || process.env.BUN_TEST === "1";
}

/** Test-only: clear the cached env so the next loadEnv() call re-validates.
 * Matches the `__setDbForTesting` pattern from the db module. */
export function __resetEnvForTesting(): void {
  cached = null;
}
