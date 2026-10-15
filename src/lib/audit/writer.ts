/**
 * Audit log writer.
 *
 * Inserts an `audit_events` row **inside the caller's transaction** so the
 * audit record commits atomically with the mutation it describes. Callers
 * MUST pass the same `tx` they used for the mutation; never use the top-level
 * `getDb()` to write audit rows for transactional mutations.
 *
 * Sensitive field redaction: any key whose name matches `SENSITIVE_KEYS`
 * (case-insensitive substring) is replaced with `"[redacted]"` in `before`
 * and `after` JSON. Passwords, hashes, tokens, and evidence URLs are never
 * persisted through audit data.
 */

import type { TxClient } from "@/lib/db";
import { Err } from "@/lib/errors";
import { randomUUID } from "node:crypto";

const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "token",
  "secret",
  "hash",
  "credential",
  "evidence",
  "evidence_url",
  "evidence_meta",
];

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function redact(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (SENSITIVE_KEY_FRAGMENTS.some((frag) => lower.includes(frag))) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // Functions, symbols, etc. → string. Safe.
  return String(value);
}

export interface AuditInput {
  /** Must be the same tx as the mutation. */
  tx: TxClient;
  academyId: string;
  actorUserId: string | null; // null for system actions
  action: string; // stable, snake_case
  targetType: string; // table or domain concept name
  targetId: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Insert an audit row inside the given transaction. */
export async function writeAudit(input: AuditInput): Promise<void> {
  const before = input.before !== undefined ? JSON.stringify(redact(input.before)) : null;
  const after = input.after !== undefined ? JSON.stringify(redact(input.after)) : null;
  const id = randomUUID();
  try {
    await input.tx.query(
      `INSERT INTO audit_events
        (id, academy_id, actor_user_id, action, target_type, target_id, occurred_at, before, after, reason)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7::jsonb, $8::jsonb, $9)`,
      [
        id,
        input.academyId,
        input.actorUserId,
        input.action,
        input.targetType,
        input.targetId,
        before,
        after,
        input.reason ?? null,
      ],
    );
  } catch (err) {
    // Audit failure inside a tx must propagate — the caller will roll back.
    throw Err.internal("Failed to write audit record", err);
  }
}
