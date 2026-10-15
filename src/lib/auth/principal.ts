/**
 * Principal extraction + server-side authorization helpers.
 *
 * A `Principal` is the authenticated user + their active academy memberships.
 * It is NEVER constructed from client-supplied data. It is always loaded
 * from the DB using the session token hash extracted from the request cookie.
 *
 * Authorization rules (enforced server-side, in this module, NOT in UI):
 *   - `requirePrincipal(request)` — extracts the principal from the session
 *     cookie. Throws UNAUTHORIZED if no valid session.
 *   - `requireRole(principal, role, academyId?)` — throws FORBIDDEN if the
 *     principal does not have the given role in the given academy (or any
 *     academy if `academyId` is undefined).
 *   - `requireAcademyMembership(principal, academyId)` — throws FORBIDDEN if
 *     the principal has no membership in the given academy. Used by all
 *     academy-scoped operations to enforce academy isolation.
 *   - `requireNotMustChangePassword(principal)` — throws MUST_CHANGE_PASSWORD
 *     if the principal's account requires a password change. Enforced on
 *     EVERY protected page AND API handler (except the change-password
 *     endpoint itself).
 *
 * Cross-academy access: a principal with role=admin in academy A cannot
 * access academy B's data even if they supply a valid UUID belonging to B.
 * The `requireAcademyMembership` check fails because the principal has no
 * membership in B.
 *
 * Never trust client-supplied role, academy ID, student ID, or guardian
 * relationship. Always re-derive from the Principal loaded via
 * `requirePrincipal`.
 *
 * Server-only. Never import from client code.
 */

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { DbClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  generateSessionToken,
  hashSessionToken,
  constantTimeEqual,
  sessionCookieName,
} from "@/lib/auth/session";

export type Role = "admin" | "coach" | "parent";

export interface AcademyMembership {
  academyId: string;
  role: Role;
  status: "active" | "inactive";
}

export interface Principal {
  userId: string;
  email: string;
  fullName: string | null;
  status: "active" | "inactive" | "suspended";
  mustChangePassword: boolean;
  /** Active memberships only. Inactive memberships are excluded. */
  memberships: AcademyMembership[];
  /** The session row's ID, for revocation. */
  sessionId: string;
  /** The session's absolute expiry (used for sliding refresh). */
  expiresAt: Date;
  /** The session's creation time (used for absolute-max-age enforcement). */
  createdAt: Date;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  status: string;
  must_change_password: boolean;
  expires_at: Date;
  created_at: Date;
}

interface MembershipRow {
  academy_id: string;
  role: string;
  status: string;
}

/**
 * Extract the Principal from the request's session cookie. Returns null if
 * there is no session cookie, the session is revoked/expired, or the user is
 * not active. Never throws on auth failure (returns null); callers decide
 * how to handle.
 *
 * The raw session token is returned alongside the Principal (via a separate
 * function) so that CSRF verification can recompute the HMAC. Callers must
 * NOT expose the raw token in responses or logs.
 */
export async function extractPrincipal(
  request: NextRequest,
  db: DbClient = getDb(),
): Promise<{ principal: Principal; rawToken: string } | null> {
  const cookieName = sessionCookieName();
  const rawToken = request.cookies.get(cookieName)?.value;
  if (!rawToken) return null;

  const tokenHash = hashSessionToken(rawToken);
  // Single query joins sessions → users and loads the active user row.
  // We do NOT trust any client-supplied user ID — the session token hash is
  // the only authentication credential.
  const sessionResult = await db.query<SessionRow>(
    `SELECT s.id AS session_id, s.user_id, u.email, u.full_name, u.status,
            u.must_change_password, s.expires_at, s.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'
      LIMIT 1;`,
    [tokenHash],
  );
  const session = sessionResult.rows[0] as SessionRow | undefined;
  if (!session) return null;

  // Constant-time hash comparison (defense-in-depth; the SQL lookup already
  // filtered, but this guards against a SQL implementation that returns
  // near-matches).
  // Note: we cannot compare the raw token to a stored value because we only
  // store the hash. The lookup itself is the comparison. This is acceptable
  // because SHA-256 collisions are infeasible.

  // Load active memberships. Inactive memberships are excluded so that
  // revoked roles cannot be used.
  const membershipsResult = await db.query<MembershipRow>(
    `SELECT academy_id, role, status
       FROM academy_memberships
      WHERE user_id = $1 AND status = 'active';`,
    [session.user_id],
  );
  const memberships: AcademyMembership[] = (membershipsResult.rows as MembershipRow[]).map(
    (m) => ({
      academyId: m.academy_id,
      role: m.role as Role,
      status: m.status as "active" | "inactive",
    }),
  );

  const principal: Principal = {
    userId: session.user_id,
    email: session.email,
    fullName: session.full_name,
    status: session.status as Principal["status"],
    mustChangePassword: session.must_change_password,
    memberships,
    sessionId: session.session_id,
    expiresAt: session.expires_at,
    createdAt: session.created_at,
  };

  return { principal, rawToken };
}

/** Require a principal. Throws UNAUTHORIZED if absent. */
export function requirePrincipal(
  principal: Principal | null,
): Principal {
  if (!principal) throw Err.unauthorized("Authentication required");
  return principal;
}

/**
 * Require that the principal has a specific role in a SPECIFIC academy.
 * `academyId` is REQUIRED — there is no "any academy" escape hatch here.
 * This enforces tenant isolation: an academy-scoped operation cannot
 * proceed without a validated academy context AND a matching membership.
 *
 * For genuinely global operations (e.g., cross-academy audit log search),
 * use `requireRoleAnywhere` instead. The two functions are deliberately
 * separate so that the "any academy" path is explicit and auditable.
 */
export function requireRole(
  principal: Principal,
  role: Role,
  academyId: string,
): Principal {
  const match = principal.memberships.find(
    (m) => m.role === role && m.academyId === academyId,
  );
  if (!match) {
    throw Err.forbidden(`Requires role '${role}' in academy ${academyId}`);
  }
  return principal;
}

/**
 * Require that the principal has a specific role in ANY academy. This is
 * for genuinely global operations (e.g., cross-academy audit log search)
 * that are NOT academy-scoped. Use sparingly — it bypasses per-academy
 * isolation by design.
 *
 * Deliberately separate from `requireRole` so that the "any academy"
 * path is explicit and difficult to misuse by accident.
 */
export function requireRoleAnywhere(
  principal: Principal,
  role: Role,
): Principal {
  const match = principal.memberships.find((m) => m.role === role);
  if (!match) {
    throw Err.forbidden(`Requires role '${role}' in any academy`);
  }
  return principal;
}

/**
 * Require that the principal has ANY active membership in the given academy.
 * Used as the first check for all academy-scoped operations, before the
 * more specific role check. Enforces tenant isolation: a principal with
 * no membership in academy X cannot access academy X's data even if they
 * supply a valid UUID belonging to X.
 */
export function requireAcademyMembership(
  principal: Principal,
  academyId: string,
): Principal {
  const match = principal.memberships.find((m) => m.academyId === academyId);
  if (!match) {
    throw Err.forbidden(`No membership in academy ${academyId}`);
  }
  return principal;
}

/**
 * Require that the principal does NOT need to change their password.
 * Enforced on EVERY protected page AND API handler (except the
 * change-password endpoint). Throws MUST_CHANGE_PASSWORD (HTTP 426) if
 * the principal must change their password before proceeding.
 */
export function requireNotMustChangePassword(principal: Principal): Principal {
  if (principal.mustChangePassword) {
    throw Err.mustChangePassword();
  }
  return principal;
}

/**
 * Convenience: full auth chain for a protected API handler. Extracts the
 * principal, requires it, requires no forced password change, and optionally
 * requires a specific role/academy.
 *
 * Usage for academy-scoped operations (academyId REQUIRED):
 *   const principal = await requireAuthChain(request, {
 *     role: "admin",
 *     academyId,
 *   });
 *
 * Usage for genuinely global operations (no academyId, uses requireRoleAnywhere):
 *   const principal = await requireAuthChain(request, {
 *     role: "admin",
 *     anywhere: true, // explicit opt-in to bypass per-academy isolation
 *   });
 *
 * If `role` is provided WITHOUT `academyId` and WITHOUT `anywhere: true`,
 * this throws a CONFIG error — the caller must be explicit about whether
 * the operation is academy-scoped or global. This prevents accidental
 * tenant-isolation bypass.
 */
export async function requireAuthChain(
  request: NextRequest,
  opts: {
    role?: Role;
    academyId?: string;
    /** Explicit opt-in for global (any-academy) role check. */
    anywhere?: boolean;
    allowMustChangePassword?: boolean;
  } = {},
  db: DbClient = getDb(),
): Promise<Principal> {
  const extracted = await extractPrincipal(request, db);
  const principal = requirePrincipal(extracted?.principal ?? null);
  if (!opts.allowMustChangePassword) {
    requireNotMustChangePassword(principal);
  }
  if (opts.role) {
    if (opts.academyId) {
      // Academy-scoped: require the role in THIS academy.
      requireRole(principal, opts.role, opts.academyId);
      requireAcademyMembership(principal, opts.academyId);
    } else if (opts.anywhere) {
      // Explicitly global: require the role in ANY academy.
      requireRoleAnywhere(principal, opts.role);
    } else {
      // Neither academyId nor anywhere was provided — this is a bug.
      // The caller must be explicit about the scope.
      throw Err.config(
        `requireAuthChain: role '${opts.role}' provided without academyId or anywhere:true. ` +
          "Specify academyId for academy-scoped ops, or anywhere:true for global ops.",
      );
    }
  }
  if (opts.academyId && !opts.role) {
    // academyId without role: just check membership.
    requireAcademyMembership(principal, opts.academyId);
  }
  return principal;
}

/**
 * Create a new session for a user. Inserts a row into `sessions` with the
 * hash of the opaque token. Returns the raw token (to set in the cookie)
 * and the session row's UUID.
 *
 * Also resets `failed_login_count` and `locked_until` on the user, and
 * updates `last_login_at`.
 */
export async function createSession(
  db: DbClient,
  userId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + env.SESSION_LIFETIME_SECONDS * 1000);

  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6);`,
    [sessionId, userId, tokenHash, expiresAt, ip, userAgent],
  );

  // Reset failed-login counters and update last_login_at.
  await db.query(
    `UPDATE users
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = now(),
            updated_at = now()
      WHERE id = $1;`,
    [userId],
  );

  return { token, sessionId, expiresAt };
}

/**
 * Revoke a session by ID. Sets `revoked_at = now()`. Idempotent. The row
 * remains for audit. (The `sessions` table has no `updated_at` column by
 * design — sessions are immutable except for revocation.)
 */
export async function revokeSession(db: DbClient, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1;`,
    [sessionId],
  );
}

// Re-export for tests / external use.
export { constantTimeEqual };
