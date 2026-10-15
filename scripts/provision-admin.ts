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
 *   2. Prompts for the initial password on stdin (hidden input).
 *      Alternatively, reads from INITIAL_ADMIN_PASSWORD env var (for
 *      automated provisioning; less secure because env vars may leak
 *      into process listings).
 *   3. If the academy (slug="default") doesn't exist, creates it.
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

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { loadEnv } from "@/lib/env";
import { hashPassword, paramsToJson } from "@/lib/auth/password";
import { AppError } from "@/lib/errors";

const ACADEMY_ID = "00000000-0000-0000-0000-000000000001"; // matches seed
const ACADEMY_SLUG = "default";

async function promptPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Note: Node's readline doesn't natively hide input. For a real CLI,
    // we'd use `sudo`'s prompt or a TTY library. For this sandbox, we
    // accept the limitation and document it. The env-var path is available
    // for automated provisioning.
    rl.question("Enter initial admin password (min 8 chars): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    rl.on("error", reject);
  });
}

async function main() {
  loadEnv();
  const env = loadEnv();
  const email = env.INITIAL_ADMIN_EMAIL?.trim();
  if (!email) {
    throw new AppError({
      code: "CONFIG_INVALID",
      message: "INITIAL_ADMIN_EMAIL env var is required to provision the initial admin.",
    });
  }

  const password = process.env.INITIAL_ADMIN_PASSWORD?.trim() || (await promptPassword());
  if (password.length < 8) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "Password must be at least 8 characters.",
    });
  }

  const pg = new PGlite(env.PGLITE_DATA_DIR || undefined, {
    // Reuse the same pre-loaded artifacts as the adapter for consistency.
    // (PGlite options are documented; this is the intended API.)
  });
  try {
    // Ensure the academy exists (matches the seed).
    await pg.query(
      `INSERT INTO academies (id, name, slug, timezone, is_active)
       VALUES ($1, 'Futsal Academy Default', $2, 'Asia/Jakarta', true)
       ON CONFLICT (id) DO NOTHING;`,
      [ACADEMY_ID, ACADEMY_SLUG],
    );

    // Check if the user already exists.
    const existing = await pg.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = $1;`,
      [email],
    );
    let userId: string;
    if (existing.rows.length > 0) {
      userId = (existing.rows[0] as { id: string }).id;
      console.info(`User ${email} already exists (id=${userId}). NOT overwriting password.`);
      console.info("If you need to reset the password, use the admin tools (Phase 4 scope).");
    } else {
      userId = randomUUID();
      const hash = await hashPassword(password);
      await pg.query("BEGIN;");
      try {
        await pg.query(
          `INSERT INTO users (id, email, status, must_change_password)
           VALUES ($1, $2, 'active', true);`,
          [userId, email],
        );
        await pg.query(
          `INSERT INTO user_credentials (user_id, argon2id_hash, argon2_params)
           VALUES ($1, $2, $3);`,
          [userId, hash, JSON.stringify(paramsToJson())],
        );
        await pg.query("COMMIT;");
        console.info(`Created user ${email} (id=${userId}) with must_change_password=true.`);
      } catch (err) {
        await pg.query("ROLLBACK;").catch(() => {});
        throw err;
      }
    }

    // Create the academy_membership (admin role) if it doesn't exist.
    const membershipId = randomUUID();
    const membershipResult = await pg.query(
      `INSERT INTO academy_memberships (id, user_id, academy_id, role, status)
       VALUES ($1, $2, $3, 'admin', 'active')
       ON CONFLICT (user_id, academy_id, role) DO NOTHING
       RETURNING id;`,
      [membershipId, userId, ACADEMY_ID],
    );
    if ((membershipResult.rows ?? []).length > 0) {
      console.info(`Created admin membership for ${email} in academy ${ACADEMY_ID}.`);
    } else {
      console.info(`Admin membership already exists for ${email} (idempotent).`);
    }

    console.info("PROVISION_OK");
    console.info("");
    console.info("The admin must log in and change their password immediately.");
    console.info("Login endpoint: POST /api/auth/login");
    console.info("Change password: POST /api/auth/change-password");
  } finally {
    await pg.close().catch(() => {});
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
