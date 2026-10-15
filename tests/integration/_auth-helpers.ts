/**
 * Test helper for auth integration tests. Sets up a fresh in-memory PgLite,
 * applies all migrations, and provides utilities for creating test users
 * and constructing NextRequest objects.
 *
 * Run under Bun (`bun test`). All tests are PgLite-backed (NOT real
 * PostgreSQL server — see Phase 1 worklog for limitations).
 */

import { PGlite } from "@electric-sql/pglite";
import { createPgLiteAdapter, __setDbForTesting, type DbClient } from "@/lib/db";
import { applyAllMigrations } from "@/lib/db/migrate";
import { hashPassword, paramsToJson } from "@/lib/auth/password";
import { randomUUID } from "node:crypto";

export const ACADEMY_A_ID = "a0000000-0000-0000-0000-000000000001";
export const ACADEMY_B_ID = "b0000000-0000-0000-0000-000000000002";

export interface TestUser {
  id: string;
  email: string;
  password: string; // plaintext, for tests only
  mustChangePassword: boolean;
  role: "admin" | "coach" | "parent";
  academyId: string;
}

let currentDb: { raw: PGlite; client: DbClient } | null = null;

/**
 * Set up a fresh in-memory PgLite with all migrations applied and the
 * singleton DbClient injected. Call in beforeEach.
 */
export async function setupTestDb(): Promise<DbClient> {
  const raw = new PGlite();
  const client = createPgLiteAdapter(raw);
  await applyAllMigrations(client);
  __setDbForTesting(client);
  currentDb = { raw, client };
  return client;
}

/** Tear down: close the PgLite instance and clear the singleton. */
export async function teardownTestDb(): Promise<void> {
  if (currentDb) {
    await currentDb.client.close().catch(() => {});
    currentDb = null;
  }
  __setDbForTesting(null);
}

/**
 * Create a test academy + user with the given role. The user has a known
 * plaintext password (hashed via Argon2id before storage).
 */
export async function createTestUser(
  db: DbClient,
  opts: {
    email: string;
    password: string;
    role: "admin" | "coach" | "parent";
    academyId?: string;
    mustChangePassword?: boolean;
    status?: "active" | "inactive" | "suspended";
  },
): Promise<TestUser> {
  const academyId = opts.academyId ?? ACADEMY_A_ID;
  const mustChange = opts.mustChangePassword ?? false;
  const status = opts.status ?? "active";

  // Ensure the academy exists.
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active)
     VALUES ($1, $2, $3, 'Asia/Jakarta', true)
     ON CONFLICT (id) DO NOTHING;`,
    [academyId, `Academy ${academyId.slice(0, 1)}`, `academy-${academyId.slice(0, 1)}`],
  );

  const userId = randomUUID();
  const hash = await hashPassword(opts.password);

  await db.query("BEGIN;");
  try {
    await db.query(
      `INSERT INTO users (id, email, status, must_change_password)
       VALUES ($1, $2, $3, $4);`,
      [userId, opts.email, status, mustChange],
    );
    await db.query(
      `INSERT INTO user_credentials (user_id, argon2id_hash, argon2_params)
       VALUES ($1, $2, $3);`,
      [userId, hash, JSON.stringify(paramsToJson())],
    );
    await db.query(
      `INSERT INTO academy_memberships (id, user_id, academy_id, role, status)
       VALUES ($1, $2, $3, $4, 'active');`,
      [randomUUID(), userId, academyId, opts.role],
    );
    await db.query("COMMIT;");
  } catch (err) {
    await db.query("ROLLBACK;").catch(() => {});
    throw err;
  }

  return {
    id: userId,
    email: opts.email,
    password: opts.password,
    mustChangePassword: mustChange,
    role: opts.role,
    academyId,
  };
}

/**
 * Construct a NextRequest for testing. The URL is `http://localhost/api/...`.
 * Sets the method, body, and headers. For cookie-based tests, use
 * `request.cookies.set(name, value)` after construction.
 */
export async function makeRequest(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  } = {},
): Promise<NextRequest> {
  // Dynamic import so the test runner picks up the Next.js version.
  const { NextRequest } = await import("next/server");
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.cookies) {
    const cookieStr = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    headers["cookie"] = cookieStr;
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return new NextRequest(`http://localhost${path}`, init) as NextRequest;
}

/** Type alias so test files don't need to import NextRequest separately. */
export type { NextRequest } from "next/server";

/** Silence unused-import warning. */
void paramsToJson;
