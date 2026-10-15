/**
 * Idempotency helper for parent scheduling mutations (Stage 9).
 *
 * Computes a canonical body hash from the request's semantic inputs so that:
 *   - Same key + same semantic request → replay (return stored result).
 *   - Same key + different operation/destination/source/reason → 409
 *     idempotency_key_reuse (non-retryable).
 *
 * Server-only. Never imported from client code.
 */

import { createHash } from "node:crypto";

/** Stable, key-sorted JSON serialization (excludes the idempotencyKey field). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k !== "idempotencyKey").sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Canonical payload fields for a parent scheduling mutation. */
export interface CanonicalPayload {
  operation: "move" | "skip" | "makeup";
  academyId: string;
  studentId: string;
  entitlementId: string;
  destinationOccurrenceId: string | null;
  expectedCurrentOccurrenceId: string | null;
  reason: string | null;
}

/** Compute the SHA-256 body hash for an idempotent parent mutation. */
export function computeEntitlementBodyHash(payload: CanonicalPayload): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}
