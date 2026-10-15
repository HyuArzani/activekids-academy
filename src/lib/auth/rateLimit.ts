/**
 * DB-backed rate limiting for login attempts.
 *
 * Why DB-backed (not in-memory):
 *   The Phase 2 brief requires rate limiting that "remains effective across
 *   multiple serverless instances; do not rely solely on in-memory counters."
 *   In-memory counters are per-process and do not survive serverless instance
 *   recycling. The `login_attempts` table (migration 0008) is the shared
 *   source of truth across all instances.
 *
 * Design:
 *   - Each login attempt (successful or failed) is recorded with its
 *     identifier (lowercased email or IP), the timestamp, and the outcome.
 *   - `checkRateLimit(identifier)` counts attempts in the last `windowSeconds`
 *     and returns whether the limit is exceeded plus a `retryAfter` seconds
 *     hint.
 *   - Two thresholds: per-email (stricter, protects a specific account) and
 *     per-IP (looser, allows multiple users behind one NAT).
 *   - Cleanup: rows older than 1 day are deleted lazily on each check
 *     (probabilistically — 1 in 100 calls triggers cleanup) to bound table
 *     growth without a separate cron.
 *
 * The check is NOT a lock — it returns a decision; the caller must still
 * enforce it. The record is always inserted AFTER the attempt, regardless of
 * the rate-limit decision (so a rejected attempt still counts toward the
 * next window's rate limit).
 *
 * Server-only. Never import from client code.
 */

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { DbClient } from "@/lib/db";
import { env } from "@/lib/env";
import { isRetryableConflict } from "@/lib/db/pg-errors";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** The identifier type that triggered the block, for logging. */
  blockedBy: "email" | "ip" | null;
}

const EMAIL_WINDOW_SECONDS = 15 * 60; // 15 minutes
const EMAIL_MAX_ATTEMPTS = 5;
const IP_WINDOW_SECONDS = 15 * 60; // 15 minutes
const IP_MAX_ATTEMPTS = 20;

/**
 * Check whether a login attempt is allowed for the given identifier.
 * Reads recent attempts from the DB. Does NOT record the new attempt
 * (the caller records it after the attempt completes).
 */
export async function checkRateLimit(
  db: DbClient,
  identifier: string,
  identifierType: "email" | "ip",
): Promise<RateLimitDecision> {
  const windowSeconds = identifierType === "email" ? EMAIL_WINDOW_SECONDS : IP_WINDOW_SECONDS;
  const maxAttempts = identifierType === "email" ? EMAIL_MAX_ATTEMPTS : IP_MAX_ATTEMPTS;

  const result = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
       FROM login_attempts
      WHERE identifier = $1
        AND attempted_at > now() - ($2 || ' seconds')::interval;`,
    [identifier, String(windowSeconds)],
  );
  const count = (result.rows[0] as { c: number } | undefined)?.c ?? 0;

  if (count >= maxAttempts) {
    // Find the oldest attempt in the window to compute retry-after.
    const oldest = await db.query<{ oldest: Date }>(
      `SELECT MIN(attempted_at) AS oldest
         FROM login_attempts
        WHERE identifier = $1
          AND attempted_at > now() - ($2 || ' seconds')::interval;`,
      [identifier, String(windowSeconds)],
    );
    const oldestDate = (oldest.rows[0] as { oldest: Date } | undefined)?.oldest;
    const retryAfter = oldestDate
      ? Math.max(
          1,
          Math.ceil(
            (oldestDate.getTime() + windowSeconds * 1000 - Date.now()) / 1000,
          ),
        )
      : windowSeconds;
    return {
      allowed: false,
      retryAfterSeconds: retryAfter,
      blockedBy: identifierType,
    };
  }

  // Probabilistic cleanup: 1 in 100 checks deletes old rows.
  if (Math.random() < 0.01) {
    await cleanupOldAttempts(db).catch(() => {
      // best effort; don't fail the login because cleanup failed
    });
  }

  return { allowed: true, retryAfterSeconds: 0, blockedBy: null };
}

/**
 * Record a login attempt. Always called AFTER the attempt completes,
 * regardless of outcome. The `succeeded` flag is for audit/reporting; it
 * does not affect the rate-limit count (both successful and failed
 * attempts count toward the window).
 */
export async function recordLoginAttempt(
  db: DbClient,
  identifier: string,
  identifierType: "email" | "ip",
  succeeded: boolean,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO login_attempts (id, identifier, identifier_type, attempted_at, succeeded, ip, user_agent)
     VALUES ($1, $2, $3, now(), $4, $5, $6);`,
    [randomUUID(), identifier, identifierType, succeeded, ip, userAgent],
  );
}

/**
 * Delete login_attempts rows older than 1 day. Called lazily from
 * `checkRateLimit`. Safe to run concurrently (DELETE is idempotent).
 */
export async function cleanupOldAttempts(db: DbClient): Promise<number> {
  const result = await db.query(
    `DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 day';`,
  );
  return result.rowCount;
}

/** Read the configured rate-limit thresholds (for tests / introspection). */
export function rateLimitThresholds() {
  return {
    email: { windowSeconds: EMAIL_WINDOW_SECONDS, maxAttempts: EMAIL_MAX_ATTEMPTS },
    ip: { windowSeconds: IP_WINDOW_SECONDS, maxAttempts: IP_MAX_ATTEMPTS },
    loginPerMinute: env.LOGIN_RATE_LIMIT_PER_MINUTE,
    loginBanMinutes: env.LOGIN_RATE_LIMIT_BAN_MINUTES,
  };
}

// === Registration-specific rate limiting (separate from login) ==========
// Uses the same login_attempts table but with a 'reg:'-prefixed identifier
// so registration attempts do NOT count toward login IP limits.
// The check-and-record is ATOMIC (SERIALIZABLE tx) — concurrent requests
// from the same IP cannot all pass before any records.

const REG_WINDOW_SECONDS = 15 * 60; // 15 minutes
const REG_MAX_ATTEMPTS = 5; // Stricter than login (5 per 15 min vs 20)
const REG_MAX_RETRIES = 3; // Bounded retry for serialization failures

/**
 * Identifier used for the small, independent GLOBAL fallback bucket when
 * no trusted client-IP metadata is available (rare on Netlify —
 * `x-nf-client-connection-ip` is platform-set). See registration.ts.
 *
 * The string deliberately starts with `__` so it cannot collide with any
 * real IPv4/IPv6 value. It is passed as the `ip` argument to
 * `checkAndRecordRegistrationRateLimit`, which prepends `reg:` —
 * producing `reg:__no_trusted_ip__` in the `login_attempts` table.
 */
export const REGISTRATION_NO_TRUSTED_IP_BUCKET = "__no_trusted_ip__";

/**
 * Small, independent global cap applied when no trusted client-IP
 * metadata is available. Smaller than the per-IP registration cap so
 * abuse is bounded, but generous enough to absorb the rare legitimate
 * request that lands in this bucket (e.g., a misconfigured deployment).
 *
 * Trade-off (see Phase B3.4.1 report):
 *   - Rejecting all no-trusted-IP requests is too aggressive — it would
 *     break the dev environment (direct, no proxy) and be hostile to
 *     legitimate users on a misconfigured deployment.
 *   - Skipping rate limiting entirely (the old behavior) leaves the
 *     door open to unbounded abuse when trusted IP metadata is missing.
 *   - A small, independent global cap bounds abuse without rejecting
 *     legitimate users and without letting an attacker lock out real
 *     per-IP users (the per-IP path is unaffected). The window is short
 *     (15 min) so even if an attacker exhausts the bucket, legitimate
 *     users can retry shortly after.
 */
const REG_NO_TRUSTED_IP_MAX_ATTEMPTS = 10;

/**
 * Atomically check AND record a registration rate-limit attempt.
 * INSERTs the attempt, then COUNTs all attempts in the window (including
 * the just-inserted one) in a single SERIALIZABLE transaction. Concurrent
 * requests serialize — each COUNT sees all previous INSERTs.
 *
 * Uses a 'reg:'-prefixed identifier so registration attempts do NOT
 * interfere with login IP rate limiting.
 *
 * The `maxAttempts` parameter is OPTIONAL and defaults to the standard
 * per-IP registration cap (REG_MAX_ATTEMPTS). Callers applying the
 * global no-trusted-IP fallback pass a smaller, independent cap
 * (REG_NO_TRUSTED_IP_MAX_ATTEMPTS).
 *
 * If the SERIALIZABLE transaction aborts with SQLSTATE 40001/40P01
 * (serialization failure), the ENTIRE transaction is retried up to
 * REG_MAX_RETRIES times. Each retry re-runs the INSERT + COUNT from
 * scratch (the failed INSERT was rolled back, so it doesn't count).
 * Only serialization failures are retried — validation, authorization,
 * and business errors propagate immediately.
 *
 * After exhausting retries, the last error propagates to the caller
 * (mapped to 409 + Retry-After by the API handler). The rate-limit
 * attempt is NOT recorded (the final tx was rolled back), so the
 * client's retry will run a fresh check.
 *
 * Returns `allowed: true` if under the limit, `allowed: false` if
 * exceeded (with retryAfterSeconds). The attempt is ALWAYS recorded
 * (even if rejected), so it counts toward the next window.
 */
export async function checkAndRecordRegistrationRateLimit(
  db: DbClient,
  ip: string,
  maxAttempts: number = REG_MAX_ATTEMPTS,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const identifier = `reg:${ip}`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= REG_MAX_RETRIES; attempt++) {
    try {
      return await db.withTxSerializable(async (tx) => {
        // INSERT the attempt (always — counts toward the window even if rejected).
        await tx.query(
          `INSERT INTO login_attempts (id, identifier, identifier_type, attempted_at, succeeded, ip, user_agent)
           VALUES ($1, $2, 'ip', now(), true, $3, null);`,
          [randomUUID(), identifier, ip],
        );

        // COUNT all attempts in the window (including the just-inserted one).
        const countResult = await tx.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c
             FROM login_attempts
            WHERE identifier = $1
              AND identifier_type = 'ip'
              AND attempted_at > now() - ($2 || ' seconds')::interval;`,
          [identifier, String(REG_WINDOW_SECONDS)],
        );
        const count = (countResult.rows[0] as { c: number } | undefined)?.c ?? 0;

        if (count > maxAttempts) {
          // Find the oldest attempt for retry-after.
          const oldest = await tx.query<{ oldest: Date }>(
            `SELECT MIN(attempted_at) AS oldest
               FROM login_attempts
              WHERE identifier = $1
                AND identifier_type = 'ip'
                AND attempted_at > now() - ($2 || ' seconds')::interval;`,
            [identifier, String(REG_WINDOW_SECONDS)],
          );
          const oldestDate = (oldest.rows[0] as { oldest: Date } | undefined)?.oldest;
          const retryAfter = oldestDate
            ? Math.max(1, Math.ceil((oldestDate.getTime() + REG_WINDOW_SECONDS * 1000 - Date.now()) / 1000))
            : REG_WINDOW_SECONDS;
          return { allowed: false, retryAfterSeconds: retryAfter };
        }

        return { allowed: true, retryAfterSeconds: 0 };
      });
    } catch (err) {
      // Only retry serialization failures (40001/40P01).
      // All other errors (validation, auth, business) propagate immediately.
      if (!isRetryableConflict(err)) {
        throw err;
      }
      lastErr = err;
      // Continue to next retry attempt.
    }
  }

  // Retries exhausted — surface the last serialization failure.
  // The API handler maps this to 409 + Retry-After.
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Rate-limit check failed after retries.");
}

/** Read the registration rate-limit thresholds (for tests / introspection). */
export function registrationRateLimitThresholds() {
  return {
    // Per-trusted-IP path (the normal path on Netlify and Caddy).
    perIp: { windowSeconds: REG_WINDOW_SECONDS, maxAttempts: REG_MAX_ATTEMPTS },
    // Independent global fallback when no trusted IP is available.
    // Same window as per-IP for simplicity; smaller cap.
    noTrustedIp: {
      windowSeconds: REG_WINDOW_SECONDS,
      maxAttempts: REG_NO_TRUSTED_IP_MAX_ATTEMPTS,
    },
  };
}
