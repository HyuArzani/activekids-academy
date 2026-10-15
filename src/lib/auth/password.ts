/**
 * Argon2id password hashing.
 *
 * Uses `@node-rs/argon2` (prebuilt native bindings — no native compilation
 * required). Parameters are OWASP-aligned:
 *   - algorithm: Argon2id (data-independent memory access + side-channel
 *     resistance)
 *   - memoryCost: 19456 KiB (~19 MiB) — above OWASP minimum of 15 MiB
 *   - timeCost: 2 iterations — OWASP minimum
 *   - parallelism: 1 — single-thread (conservative; suitable for serverless)
 *
 * The `hash()` function returns a single PHC-format string that encodes the
 * algorithm, version, memory cost, time cost, parallelism, salt, and hash.
 * This string is stored verbatim in `user_credentials.argon2id_hash`. The
 * `verify()` function parses the PHC string and re-derives the hash.
 *
 * The `argon2_params` JSON column is stored for documentation/future tuning
 * only — verification does not read it (the PHC string is self-describing).
 *
 * Server-only. Never import from client code. Never log the hash or the
 * plaintext password.
 */

import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id parameters. OWASP-aligned:
 *   - algorithm: Argon2id (value 2; @node-rs/argon2's Algorithm enum is a
 *     const enum, not accessible with `isolatedModules: true` — we use the
 *     numeric value directly and cast at the call site).
 *   - memoryCost: 19456 KiB (~19 MiB) — above OWASP minimum of 15 MiB
 *   - timeCost: 2 iterations — OWASP minimum
 *   - parallelism: 1 — single-thread (conservative; suitable for serverless)
 */
const ARGON2_PARAMS = {
  algorithm: 2, // Argon2id
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** Type for the `argon2_params` JSON column (documentation only). */
export interface Argon2ParamsJson {
  algorithm: "Argon2id";
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** JSON-serializable form for storage in `argon2_params`. */
export function paramsToJson(): Argon2ParamsJson {
  return {
    algorithm: "Argon2id",
    memoryCost: ARGON2_PARAMS.memoryCost,
    timeCost: ARGON2_PARAMS.timeCost,
    parallelism: ARGON2_PARAMS.parallelism,
  };
}

/**
 * Hash a plaintext password. Returns a PHC-format string. Enforces a
 * minimum length of 8 characters.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (!plain || plain.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  // Cast because Algorithm is a const enum (inaccessible with isolatedModules).
  return hash(plain, ARGON2_PARAMS as Parameters<typeof hash>[1]);
}

/**
 * Verify a plaintext password against a stored PHC-format hash. Returns
 * true on match, false otherwise. Never throws on password mismatch.
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  if (!plain || !storedHash) return false;
  try {
    return await verify(storedHash, plain);
  } catch {
    // Malformed hash or unsupported algorithm — treat as a failed verify.
    return false;
  }
}
