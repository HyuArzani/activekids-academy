/**
 * Initial admin provisioning script.
 *
 * Creates the very first admin user for an academy. There is NO public
 * endpoint for this — it must be run from the server's trusted environment.
 *
 * Usage:
 *   INITIAL_ADMIN_EMAIL=admin@example.com bun run scripts/provision-admin.ts
 *
 * The script:
 *   1. Reads INITIAL_ADMIN_EMAIL from env (required).
 *   2. Prompts for the initial password on an interactive TTY (hidden input).
 *   3. Requires the seeded academy (slug="default") to exist.
 *   4. If the user doesn't exist, creates them with
 *      `must_change_password=true` (so the admin is forced to set a
 *      fresh password on first login).
 *   5. If the user already exists, prints a warning and does NOT
 *      overwrite their password (idempotent for safety).
 *   6. Creates an `academy_memberships` row with role='admin' if one
 *      doesn't already exist.
 *
 * Security:
 *   - Never logs the password (plaintext or hash).
 *   - The password is hashed with Argon2id before storage.
 *   - `must_change_password=true` forces a fresh password on first
 *     login, so even if the provisioning password leaks, the admin must
 *     change it before using the account.
 *   - If the user already exists, the script does NOT update their
 *     password (prevents an attacker who runs the script from
 *     hijacking an existing admin account).
 */

import { randomUUID } from "node:crypto";
import { loadEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import { hashPassword, paramsToJson } from "@/lib/auth/password";
import { AppError } from "@/lib/errors";

const ACADEMY_SLUG = "default";

async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new AppError({ code: "CONFIG_INVALID", message: "Admin provisioning requires an interactive TTY for hidden password input." });
  }
  process.stdout.write("Enter initial admin password (min 8 chars): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let answer = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Provisioning cancelled."));
          return;
        }
        if (char.charCodeAt(0) === 13 || char.charCodeAt(0) === 10) {
          cleanup();
          process.stdout.write("\n");
          resolve(answer);
          return;
        }
        if (char === "\u007f" || char.charCodeAt(0) === 8) answer = answer.slice(0, -1);
        else answer += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const env = loadEnv();
  const email = env.INITIAL_ADMIN_EMAIL.trim().toLowerCase();
  if (!email) throw new AppError({ code: "CONFIG_INVALID", message: "INITIAL_ADMIN_EMAIL env var is required." });
  if (!env.DATABASE_URL || !/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) {
    throw new AppError({ code: "CONFIG_INVALID", message: "Admin provisioning requires DATABASE_URL targeting PostgreSQL; PgLite fallback is disabled." });
  }
  if (env.TEST_DATABASE_URL.trim()) {
    throw new AppError({ code: "CONFIG_INVALID", message: "Unset TEST_DATABASE_URL before provisioning an Admin; it takes precedence over DATABASE_URL." });
  }

  const password = await promptPassword();
  if (password.length < 8) throw new AppError({ code: "VALIDATION_FAILED", message: "Password must be at least 8 characters." });

  const db = getDb();
  try {
    const academyResult = await db.query<{ id: string }>("SELECT id FROM academies WHERE slug = $1 AND is_active = true LIMIT 1;", [ACADEMY_SLUG]);
    const academyId = academyResult.rows[0]?.id;
    if (!academyId) throw new AppError({ code: "CONFIG_INVALID", message: "Seed the target PostgreSQL database before provisioning an Admin." });

    const hash = await hashPassword(password);
    const result = await db.withTxSerializable(async (tx) => {
      const existing = await tx.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE;", [email]);
      let userId = existing.rows[0]?.id;
      if (!userId) {
        userId = randomUUID();
        await tx.query("INSERT INTO users (id, email, status, must_change_password) VALUES ($1, $2, 'active', true);", [userId, email]);
        await tx.query("INSERT INTO user_credentials (user_id, argon2id_hash, argon2_params) VALUES ($1, $2, $3);", [userId, hash, JSON.stringify(paramsToJson())]);
      }
      const membership = await tx.query(
        `INSERT INTO academy_memberships (id, user_id, academy_id, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')
         ON CONFLICT (user_id, academy_id, role) DO NOTHING RETURNING id;`,
        [randomUUID(), userId, academyId],
      );
      return { createdUser: !existing.rows[0], createdMembership: membership.rowCount > 0 };
    });
    console.info(result.createdUser ? "Created initial Admin user." : "User already exists; password was not changed.");
    console.info(result.createdMembership ? "Created Admin academy membership." : "Admin membership already exists.");
    console.info("PROVISION_OK — log in and change the initial password.");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(err.message, err.detail ?? "");
  } else {
    console.error("Provision failed:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
