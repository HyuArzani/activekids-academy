/**
 * Auth service: login, logout, change-password business logic.
 *
 * These functions are the boundary between the API route handlers and the
 * database. They enforce:
 *   - Input validation (email format, password length)
 *   - Rate limiting (per-email and per-IP, DB-backed)
 *   - Account lockout (after 5 failed attempts, lock for 15 minutes)
 *   - Session creation with opaque token + hash storage
 *   - Session revocation on logout (ONLY the current session)
 *   - Concurrent sessions explicitly allowed (multiple devices/browsers)
 *   - Password change revokes OTHER sessions (security precaution) but
 *     keeps the current session valid; performed transactionally
 *   - Forced password change enforcement (set must_change_password=true
 *     on provisioned accounts; cleared on successful change)
 *
 * Security notes:
 *   - Login failure messages are generic ("Invalid email or password") to
 *     prevent user enumeration. The specific reason (user not found vs
 *     wrong password vs inactive) is logged server-side only.
 *   - Timing equalization: when the email is not found, a dummy Argon2id
 *     verify is run so the response time is indistinguishable from a
 *     wrong-password attempt. This prevents timing-based user enumeration.
 *   - Password hashes are never returned in responses or logs.
 *   - Session tokens are returned only to the cookie-setter, never in JSON.
 *
 * Server-only. Never import from client code.
 */

import { randomUUID } from "node:crypto";
import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { env } from "@/lib/env";
import { hashPassword, verifyPassword, paramsToJson } from "@/lib/auth/password";
import {
  generateSessionToken,
  hashSessionToken,
} from "@/lib/auth/session";
import {
  checkRateLimit,
  recordLoginAttempt,
} from "@/lib/auth/rateLimit";
import { deriveCsrfToken } from "@/lib/auth/csrf";
import type { Principal } from "@/lib/auth/principal";

interface UserRow {
  id: string;
  email: string;
  status: string;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

interface CredentialRow {
  argon2id_hash: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  principal: Principal;
  /** The raw session token — ONLY for setting in the cookie. Never log. */
  sessionToken: string;
  /** The CSRF token — for setting in the CSRF cookie. */
  csrfToken: string;
  /** Session expiry (for cookie Max-Age). */
  expiresAt: Date;
}

/**
 * A pre-computed dummy Argon2id hash used for timing equalization. When
 * the email is not found at login, we run `verifyPassword(password,
 * DUMMY_HASH)` so the response time is indistinguishable from a real
 * wrong-password attempt. This prevents timing-based user enumeration.
 *
 * Lazily initialized on first use to avoid hashing at module load time
 * during tests that don't exercise the login-not-found path.
 */
let dummyHashCache: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHashCache) {
    dummyHashCache = await hashPassword("timing-equalization-dummy-pw");
  }
  return dummyHashCache;
}

/** Normalize email to lowercase + trim. Rejects malformed emails. */
function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  // Minimal email format check. Full validation is not the goal — the
  // DB UNIQUE constraint is the real guarantee.
  if (!trimmed || !trimmed.includes("@") || trimmed.length > 254) {
    throw Err.validation("Invalid email format");
  }
  return trimmed;
}

/** Validate password length. The actual complexity policy is "≥8 chars". */
function validatePassword(password: string): void {
  if (!password || password.length < 8) {
    throw Err.validation("Password must be at least 8 characters");
  }
}

/**
 * Attempt to log a user in. On success, returns the principal + session
 * token + CSRF token. On failure, throws a 401 (with a generic message) and
 * records the failed attempt for rate limiting.
 *
 * `ip` and `userAgent` are extracted from the request by the caller.
 *
 * Concurrent sessions: each successful login creates a NEW, independent
 * session row. Multiple active sessions per user are explicitly allowed.
 * Logging out from one session does NOT revoke others.
 */
export async function login(
  input: LoginInput,
  ip: string | null,
  userAgent: string | null,
  db: DbClient = getDb(),
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  validatePassword(input.password);

  // Rate limit: check both email and IP.
  const emailDecision = await checkRateLimit(db, email, "email");
  if (!emailDecision.allowed) {
    throw Err.rateLimited(
      `Too many login attempts for this account. Retry in ${emailDecision.retryAfterSeconds}s.`,
    );
  }
  const ipDecision = await checkRateLimit(db, ip ?? "unknown", "ip");
  if (!ipDecision.allowed) {
    throw Err.rateLimited(
      `Too many login attempts from this IP. Retry in ${ipDecision.retryAfterSeconds}s.`,
    );
  }

  // Look up the user by email. If not found, we still record a failed
  // attempt (so the rate limiter counts unknown-email attempts).
  const userResult = await db.query<UserRow>(
    `SELECT id, email, status, must_change_password, failed_login_count, locked_until
       FROM users
      WHERE email = $1
      LIMIT 1;`,
    [email],
  );
  const user = userResult.rows[0] as UserRow | undefined;

  // Generic failure message — never reveal whether the email exists.
  const invalidCredentials = () => Err.unauthorized("Invalid email or password");

  if (!user) {
    // TIMING EQUALIZATION: run a dummy Argon2id verify so the response
    // time is indistinguishable from a wrong-password attempt. Without
    // this, an attacker could enumerate emails by measuring response
    // time (user-not-found is instant; wrong-password takes ~50ms).
    await verifyPassword(input.password, await getDummyHash());
    await recordLoginAttempt(db, email, "email", false, ip, userAgent);
    await recordLoginAttempt(db, ip ?? "unknown", "ip", false, ip, userAgent);
    throw invalidCredentials();
  }

  // Check account lockout (per-user, separate from rate limiter).
  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    const retryAfter = Math.ceil((user.locked_until.getTime() - Date.now()) / 1000);
    throw Err.rateLimited(`Account locked. Retry in ${retryAfter}s.`);
  }

  // Inactive/suspended users cannot log in.
  if (user.status !== "active") {
    // Timing equalization for inactive users too.
    await verifyPassword(input.password, await getDummyHash());
    await recordLoginAttempt(db, email, "email", false, ip, userAgent);
    await recordLoginAttempt(db, ip ?? "unknown", "ip", false, ip, userAgent);
    throw invalidCredentials();
  }

  // Look up the stored hash.
  const credResult = await db.query<CredentialRow>(
    `SELECT argon2id_hash FROM user_credentials WHERE user_id = $1;`,
    [user.id],
  );
  const cred = credResult.rows[0] as CredentialRow | undefined;
  if (!cred) {
    // User exists but has no credentials — treat as invalid (shouldn't
    // happen for provisioned accounts, but defend in depth). Still run
    // a dummy verify for timing equalization.
    await verifyPassword(input.password, await getDummyHash());
    await recordLoginAttempt(db, email, "email", false, ip, userAgent);
    await recordLoginAttempt(db, ip ?? "unknown", "ip", false, ip, userAgent);
    throw invalidCredentials();
  }

  const passwordOk = await verifyPassword(input.password, cred.argon2id_hash);
  if (!passwordOk) {
    // Increment failed_login_count; lock if threshold reached.
    const newCount = user.failed_login_count + 1;
    const lockThreshold = 5;
    if (newCount >= lockThreshold) {
      const lockUntil = new Date(Date.now() + env.LOGIN_RATE_LIMIT_BAN_MINUTES * 60 * 1000);
      await db.query(
        `UPDATE users
            SET failed_login_count = $2,
                locked_until = $3,
                updated_at = now()
          WHERE id = $1;`,
        [user.id, newCount, lockUntil],
      );
    } else {
      await db.query(
        `UPDATE users SET failed_login_count = $2, updated_at = now() WHERE id = $1;`,
        [user.id, newCount],
      );
    }
    await recordLoginAttempt(db, email, "email", false, ip, userAgent);
    await recordLoginAttempt(db, ip ?? "unknown", "ip", false, ip, userAgent);
    throw invalidCredentials();
  }

  // Success: create session, reset counters, record success.
  // Each login creates a NEW session row — concurrent sessions are
  // explicitly allowed. We do NOT revoke existing sessions on login.
  const sessionToken = generateSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + env.SESSION_LIFETIME_SECONDS * 1000);

  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6);`,
    [sessionId, user.id, tokenHash, expiresAt, ip, userAgent],
  );
  await db.query(
    `UPDATE users
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = now(),
            updated_at = now()
      WHERE id = $1;`,
    [user.id],
  );
  await recordLoginAttempt(db, email, "email", true, ip, userAgent);
  await recordLoginAttempt(db, ip ?? "unknown", "ip", true, ip, userAgent);

  // Load the principal's memberships. (We can't call extractPrincipal here
  // because that reads from the cookie; we just created the session.)
  const membershipsResult = await db.query<{ academy_id: string; role: string; status: string }>(
    `SELECT academy_id, role, status FROM academy_memberships
      WHERE user_id = $1 AND status = 'active';`,
    [user.id],
  );
  const memberships = (membershipsResult.rows as { academy_id: string; role: string; status: string }[]).map(
    (m) => ({
      academyId: m.academy_id,
      role: m.role as "admin" | "coach" | "parent",
      status: m.status as "active" | "inactive",
    }),
  );

  const principal: Principal = {
    userId: user.id,
    email: user.email,
    fullName: null,
    status: user.status as Principal["status"],
    mustChangePassword: user.must_change_password,
    memberships,
    sessionId,
    expiresAt,
    createdAt: new Date(),
  };

  const csrfToken = deriveCsrfToken(sessionToken);

  return { principal, sessionToken, csrfToken, expiresAt };
}

/**
 * Revoke all OTHER active sessions for the given user, EXCEPT the current
 * session. Used after a password change as a security precaution: if an
 * attacker had stolen an old session token, the password change invalidates
 * it. The current session (the one that made the change-password request)
 * stays valid so the user is NOT logged out.
 *
 * MUST be called inside the same transaction as the password update so the
 * revocation and the password change commit atomically (or both roll back).
 */
export async function revokeOtherSessions(
  db: DbClient,
  userId: string,
  exceptSessionId: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE sessions
        SET revoked_at = now()
      WHERE user_id = $1
        AND id <> $2
        AND revoked_at IS NULL;`,
    [userId, exceptSessionId],
  );
  return result.rowCount;
}

/**
 * Change the current user's password. Clears `must_change_password` on
 * success. The caller is responsible for ensuring the principal is
 * authenticated (this function takes the principal as input).
 *
 * SECURITY BEHAVIOR (Phase 2 security review):
 *   - The password update + `must_change_password=false` + revocation of
 *     OTHER sessions are performed in a SINGLE transaction. If any step
 *     fails, all roll back (the password is NOT changed, other sessions
 *     are NOT revoked).
 *   - The CURRENT session (the one that made the request) stays valid.
 *     The user is NOT logged out for changing their password.
 *   - All OTHER sessions for this user are revoked. This is a security
 *     precaution: if an attacker had stolen an old session token, the
 *     password change invalidates it. The user can re-authenticate on
 *     other devices with the new password.
 *   - Only the CURRENT user's sessions are revoked. Other users'
 *     sessions are NEVER touched (the UPDATE is scoped by `user_id`).
 */
export async function changePassword(
  principal: Principal,
  currentPassword: string,
  newPassword: string,
  db: DbClient = getDb(),
): Promise<void> {
  validatePassword(newPassword);
  if (currentPassword === newPassword) {
    throw Err.validation("New password must differ from current password");
  }

  // Load the stored hash.
  const credResult = await db.query<CredentialRow>(
    `SELECT argon2id_hash FROM user_credentials WHERE user_id = $1;`,
    [principal.userId],
  );
  const cred = credResult.rows[0] as CredentialRow | undefined;
  if (!cred) {
    throw Err.unauthorized("No credentials on file");
  }

  const ok = await verifyPassword(currentPassword, cred.argon2id_hash);
  if (!ok) {
    throw Err.unauthorized("Current password is incorrect");
  }

  const newHash = await hashPassword(newPassword);

  // Transactional: password update + must_change_password clear +
  // other-session revocation all commit (or roll back) together.
  await db.withTx(async (tx) => {
    await tx.query(
      `UPDATE user_credentials
          SET argon2id_hash = $2,
              argon2_params = $3,
              updated_at = now()
        WHERE user_id = $1;`,
      [principal.userId, newHash, JSON.stringify(paramsToJson())],
    );
    await tx.query(
      `UPDATE users
          SET must_change_password = false,
              last_pw_change_at = now(),
              updated_at = now()
        WHERE id = $1;`,
      [principal.userId],
    );
    // Revoke all OTHER sessions for this user (not the current one).
    // Scoped by user_id — only this user's sessions are affected.
    await tx.query(
      `UPDATE sessions
          SET revoked_at = now()
        WHERE user_id = $1
          AND id <> $2
          AND revoked_at IS NULL;`,
      [principal.userId, principal.sessionId],
    );
  });
}

/**
 * Sanitize a principal for client-facing responses. Strips all sensitive
 * fields (sessionId, expiresAt internals) and returns only what the UI
 * needs to know.
 */
export function sanitizePrincipal(p: Principal): {
  userId: string;
  email: string;
  fullName: string | null;
  mustChangePassword: boolean;
  memberships: { academyId: string; role: "admin" | "coach" | "parent" }[];
} {
  return {
    userId: p.userId,
    email: p.email,
    fullName: p.fullName,
    mustChangePassword: p.mustChangePassword,
    memberships: p.memberships.map((m) => ({ academyId: m.academyId, role: m.role })),
  };
}
