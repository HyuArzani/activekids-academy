/**
 * PostgreSQL error classification.
 *
 * Maps `pg.DatabaseError` SQLSTATE codes to safe `AppError` instances.
 * The original error (with SQLSTATE, detail, hint, table, constraint) is
 * stored in `serverCause` for server-side logging only — NEVER exposed to
 * the client.
 *
 * SQLSTATE codes classified:
 *   40001  serialization_failure   → CONFLICT (409, retryable)
 *   40P01  deadlock_detected       → CONFLICT (409, retryable)
 *   23505  unique_violation        → CONFLICT (409)
 *   23514  check_violation         → VALIDATION_FAILED (422)
 *   23503  foreign_key_violation   → CONFLICT (409)
 *   other                          → UPSTREAM_ERROR (502)
 *
 * No automatic retry is performed. The caller (API handler) receives the
 * classified error and decides whether to retry. The `detail` field
 * indicates which errors are safe to retry ("retryable").
 *
 * Server-only. Never import from client code.
 */

import { AppError } from "@/lib/errors";

/** SQLSTATE codes we explicitly classify. */
export const SQLSTATE = {
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK_DETECTED: "40P01",
  UNIQUE_VIOLATION: "23505",
  CHECK_VIOLATION: "23514",
  FOREIGN_KEY_VIOLATION: "23503",
} as const;

/**
 * Determine whether a thrown error is a `pg.DatabaseError` and extract
 * its SQLSTATE code. Returns null for non-PostgreSQL errors.
 */
function extractSqlState(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.length >= 5) {
      return code;
    }
  }
  return null;
}

/**
 * Classify a PostgreSQL error into a safe `AppError`. The original error
 * is preserved in `serverCause` for server-side logging.
 *
 * Client-facing messages are GENERIC — they never reveal SQLSTATE codes,
 * table names, constraint names, or internal details.
 */
export function classifyPgError(err: unknown): AppError {
  const sqlState = extractSqlState(err);

  switch (sqlState) {
    case SQLSTATE.SERIALIZATION_FAILURE:
    case SQLSTATE.DEADLOCK_DETECTED:
      // Retryable: the caller can safely retry the entire operation.
      // A serialization failure means the transaction was rolled back,
      // so no side effects committed. Retrying re-executes the operation
      // from scratch.
      return new AppError({
        code: "CONFLICT",
        message: "Transaction conflict — retry the operation.",
        detail: "retryable",
        cause: err,
      });

    case SQLSTATE.UNIQUE_VIOLATION:
      return new AppError({
        code: "CONFLICT",
        message: "A record with this key already exists.",
        cause: err,
      });

    case SQLSTATE.CHECK_VIOLATION:
      return new AppError({
        code: "VALIDATION_FAILED",
        message: "Data validation constraint violated.",
        cause: err,
      });

    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return new AppError({
        code: "CONFLICT",
        message: "Referenced record does not exist.",
        cause: err,
      });

    default:
      // Unknown SQLSTATE or non-PostgreSQL error.
      return new AppError({
        code: "UPSTREAM_ERROR",
        message: "Database error",
        cause: err,
      });
  }
}

/**
 * Check if an AppError represents a retryable serialization conflict
 * (SQLSTATE 40001 or 40P01). Used by API handlers to decide whether to
 * suggest a client-side retry.
 */
export function isRetryableConflict(err: unknown): boolean {
  return err instanceof AppError && err.code === "CONFLICT" && err.detail === "retryable";
}
