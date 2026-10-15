/**
 * Test preload — sets required env vars explicitly so tests don't depend
 * on `.env` being present in the working tree. Run automatically by Bun
 * via `bunfig.toml` (`test.preload`).
 *
 * The values here are DETERMINISTIC TEST VALUES — they are NOT production
 * secrets. They are acceptable for test-only use because:
 *   - The test DB is in-memory PgLite (no persistence between runs)
 *   - The session tokens are never used outside tests
 *   - The CSRF secrets are only used to verify the HMAC mechanism
 *
 * Production MUST set real secrets via environment variables.
 */

// Set required env vars BEFORE any test module imports env.ts.
// Use defineProperty to avoid overwriting values that are already set
// (e.g., by Bun's dotenv loading .env, or by the system environment).
function setIfMissing(key: string, value: string): void {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

setIfMissing("NODE_ENV", "test");
setIfMissing("ACADEMY_TIMEZONE", "Asia/Jakarta");
setIfMissing("PGLITE_DATA_DIR", "");
setIfMissing("DATABASE_URL", "");
setIfMissing(
  "SESSION_SECRET",
  "test_session_secret_deterministic_value_for_tests_only_32chars",
);
setIfMissing(
  "CSRF_SECRET",
  "test_csrf_secret_deterministic_value_for_tests_only_32chars_",
);
setIfMissing("SESSION_COOKIE_NAME", "futsal_session");
setIfMissing("CSRF_COOKIE_NAME", "futsal_csrf");
setIfMissing("SESSION_LIFETIME_SECONDS", "43200");
setIfMissing("SESSION_ABSOLUTE_MAX_SECONDS", "604800");
setIfMissing("LOGIN_RATE_LIMIT_PER_MINUTE", "10");
setIfMissing("LOGIN_RATE_LIMIT_BAN_MINUTES", "15");
setIfMissing("INITIAL_ADMIN_EMAIL", "");
// TEST_DATABASE_URL — leave empty so PgLite is used for tests. Set it to
// a real postgres:// URL to run the pg/ integration tests against a real
// PostgreSQL server.
setIfMissing("TEST_DATABASE_URL", "");
