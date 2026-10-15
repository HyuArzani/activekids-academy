/**
 * Integration test: DB-level invariants enforced by constraints/triggers.
 *
 * CRITICAL: this test verifies constraints that the brief demands be
 * DB-enforced (not just application-enforced). Every assertion below must
 * reject bad data at the database layer (CHECK, UNIQUE, partial UNIQUE
 * index, or trigger). Domain-layer-only invariants are tested in Phase 3.
 *
 * Runs against an IN-MEMORY PgLite. The constraint types used here
 * (CHECK, UNIQUE, partial UNIQUE, BEFORE-UPDATE trigger) are standard
 * PostgreSQL features with identical behavior under PgLite, so these
 * verifications are valid proofs of DB-level enforcement. Concurrency-
 * related invariants (FOR UPDATE, SERIALIZABLE contention) are NOT proven
 * here — those require a real multi-connection PostgreSQL server.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { applyAllMigrations } from "@/lib/db/migrate";
import { createPgLiteAdapter, type DbClient } from "@/lib/db";
import { AppError } from "@/lib/errors";

let raw: PGlite;
let db: DbClient;

const ACADEMY_ID = "11111111-0000-0000-0000-000000000001";
const USER_ID_1 = "21111111-0000-0000-0000-000000000001";
const USER_ID_2 = "21111111-0000-0000-0000-000000000002";
const STUDENT_ID = "31111111-0000-0000-0000-000000000001";
const CLASS_ID = "41111111-0000-0000-0000-000000000001";

async function seedAcademyAndStudent(): Promise<void> {
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active)
     VALUES ($1, 'Test Academy', 'test', 'Asia/Jakarta', true);`,
    [ACADEMY_ID],
  );
  await db.query(
    `INSERT INTO users (id, email, status) VALUES ($1, 'p1@example.com', 'active');`,
    [USER_ID_1],
  );
  await db.query(
    `INSERT INTO users (id, email, status) VALUES ($1, 'p2@example.com', 'active');`,
    [USER_ID_2],
  );
  await db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Semangat', 12, true);`,
    [CLASS_ID, ACADEMY_ID],
  );
  await db.query(
    `INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'Adi');`,
    [STUDENT_ID, ACADEMY_ID],
  );
}

beforeEach(async () => {
  raw = new PGlite();
  await applyAllMigrations(raw);
  db = createPgLiteAdapter(raw);
  await seedAcademyAndStudent();
});

afterEach(async () => {
  await db.close().catch(() => {});
});

async function expectUniqueViolation(fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  let message = "";
  try {
    await fn();
  } catch (err) {
    threw = true;
    message = extractOriginalMessage(err);
  }
  expect(threw, "expected a uniqueness violation, but no error was thrown").toBe(true);
  // PgLite/Postgres surfaces unique violations with "unique constraint" or
  // "duplicate key" in the message.
  expect(
    /unique|duplicate/i.test(message),
    `expected unique/duplicate error, got: ${message}`,
  ).toBe(true);
}

async function expectCheckViolation(fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  let message = "";
  try {
    await fn();
  } catch (err) {
    threw = true;
    message = extractOriginalMessage(err);
  }
  expect(threw, "expected a CHECK violation, but no error was thrown").toBe(true);
  expect(
    /check|violate|constraint/i.test(message),
    `expected CHECK violation, got: ${message}`,
  ).toBe(true);
}

// The PgLiteAdapter wraps DB errors as AppError(UPSTREAM_ERROR) with the
// original error stored on `serverCause`. Tests of DB-level constraints need
// the original PostgreSQL message to verify the actual constraint fired.
function extractOriginalMessage(err: unknown): string {
  if (err instanceof AppError && err.serverCause instanceof Error) {
    return err.serverCause.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

test("users.email is UNIQUE — second row with same email is rejected", async () => {
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO users (id, email, status) VALUES ($1, 'p1@example.com', 'active');`,
      ["00000000-0000-0000-0000-000000000099"],
    );
  });
});

test("sessions.token_hash is UNIQUE — duplicate token hash rejected", async () => {
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour');`,
    ["11111111-0000-0000-0000-000000000010", USER_ID_1, "hash-abc"],
  );
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour');`,
      ["11111111-0000-0000-0000-000000000011", USER_ID_2, "hash-abc"],
    );
  });
});

test("academy_memberships (user, academy, role) is UNIQUE", async () => {
  await db.query(
    `INSERT INTO academy_memberships (id, user_id, academy_id, role)
     VALUES ($1, $2, $3, 'parent');`,
    ["11111111-0000-0000-0000-000000000020", USER_ID_1, ACADEMY_ID],
  );
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO academy_memberships (id, user_id, academy_id, role)
       VALUES ($1, $2, $3, 'parent');`,
      ["11111111-0000-0000-0000-000000000021", USER_ID_1, ACADEMY_ID],
    );
  });
});

test("users.status CHECK rejects invalid status", async () => {
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO users (id, email, status) VALUES ($1, 'bad@example.com', 'mystery');`,
      ["00000000-0000-0000-0000-000000000099"],
    );
  });
});

test("users.failed_login_count CHECK rejects negative values", async () => {
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO users (id, email, failed_login_count)
       VALUES ($1, 'neg@example.com', -1);`,
      ["00000000-0000-0000-0000-000000000099"],
    );
  });
});

// ---------------------------------------------------------------------------
// Guardian links — at most one primary per student (partial unique index)
// ---------------------------------------------------------------------------

test("at most ONE primary guardian per student — second primary rejected", async () => {
  await db.query(
    `INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship)
     VALUES ($1, $2, $3, true, 'father');`,
    ["11111111-0000-0000-0000-000000000030", USER_ID_1, STUDENT_ID],
  );
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship)
       VALUES ($1, $2, $3, true, 'mother');`,
      ["11111111-0000-0000-0000-000000000031", USER_ID_2, STUDENT_ID],
    );
  });
});

test("non-primary guardian links are allowed alongside a primary", async () => {
  await db.query(
    `INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship)
     VALUES ($1, $2, $3, true, 'father');`,
    ["11111111-0000-0000-0000-000000000030", USER_ID_1, STUDENT_ID],
  );
  // Adding a second NON-primary guardian for the same student must succeed.
  await db.query(
    `INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship)
     VALUES ($1, $2, $3, false, 'mother');`,
    ["11111111-0000-0000-0000-000000000031", USER_ID_2, STUDENT_ID],
  );
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM guardian_student_links WHERE student_id = $1;`,
    [STUDENT_ID],
  );
  expect((r.rows[0] as { c: number }).c).toBe(2);
});

// ---------------------------------------------------------------------------
// Student enrollments — at most one currently-active per student
// ---------------------------------------------------------------------------

test("at most ONE currently-active enrollment per student — second active rejected", async () => {
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
     VALUES ($1, $2, $3, CURRENT_DATE, NULL);`,
    ["11111111-0000-0000-0000-000000000040", STUDENT_ID, CLASS_ID],
  );
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
       VALUES ($1, $2, $3, CURRENT_DATE, NULL);`,
      ["11111111-0000-0000-0000-000000000041", STUDENT_ID, CLASS_ID],
    );
  });
});

test("a closed enrollment (effective_to NOT NULL) does not block a new active one", async () => {
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
     VALUES ($1, $2, $3, CURRENT_DATE - 30, CURRENT_DATE - 1);`,
    ["11111111-0000-0000-0000-000000000040", STUDENT_ID, CLASS_ID],
  );
  // New active enrollment must succeed (no overlap with the closed one in the
  // partial-unique sense).
  await db.query(
    `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
     VALUES ($1, $2, $3, CURRENT_DATE, NULL);`,
    ["11111111-0000-0000-0000-000000000041", STUDENT_ID, CLASS_ID],
  );
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM student_enrollments WHERE student_id = $1;`,
    [STUDENT_ID],
  );
  expect((r.rows[0] as { c: number }).c).toBe(2);
});

test("student_enrollments CHECK rejects effective_to < effective_from", async () => {
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO student_enrollments (id, student_id, class_id, effective_from, effective_to)
       VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE - 1);`,
      ["11111111-0000-0000-0000-000000000040", STUDENT_ID, CLASS_ID],
    );
  });
});

// ---------------------------------------------------------------------------
// Schedule versions — at most one active per class
// ---------------------------------------------------------------------------

test("at most ONE active schedule_version per class — second rejected", async () => {
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    ["11111111-0000-0000-0000-000000000050", CLASS_ID],
  );
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
       VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
      ["11111111-0000-0000-0000-000000000051", CLASS_ID],
    );
  });
});

test("a superseded version (effective_to NOT NULL) does not block a new active one", async () => {
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE - 30, CURRENT_DATE - 1, 'superseded');`,
    ["11111111-0000-0000-0000-000000000050", CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    ["11111111-0000-0000-0000-000000000051", CLASS_ID],
  );
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM schedule_versions WHERE class_id = $1;`,
    [CLASS_ID],
  );
  expect((r.rows[0] as { c: number }).c).toBe(2);
});

// ---------------------------------------------------------------------------
// Training occurrences — UNIQUE (slot, date) for idempotent generation
// ---------------------------------------------------------------------------

test("training_occurrences UNIQUE (slot, date) — duplicate generation rejected", async () => {
  const SLOT_ID = "11111111-0000-0000-0000-000000000060";
  const VER_ID = "11111111-0000-0000-0000-000000000050"; // created above? no — fresh
  // Create a fresh schedule version for this test to avoid clash with the
  // previous test's version row.
  await db.query(
    `DELETE FROM schedule_versions WHERE class_id = $1;`,
    [CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    [VER_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '15:00', '16:00');`,
    [SLOT_ID, VER_ID],
  );
  await db.query(
    `INSERT INTO training_occurrences
       (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
        occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, now(), now() + interval '1 hour', 'planned', 12);`,
    ["11111111-0000-0000-0000-000000000070", ACADEMY_ID, CLASS_ID, SLOT_ID, VER_ID],
  );
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO training_occurrences
         (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
          occurrence_date, start_at, end_at, status, capacity)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, now(), now() + interval '1 hour', 'planned', 12);`,
      ["11111111-0000-0000-0000-000000000071", ACADEMY_ID, CLASS_ID, SLOT_ID, VER_ID],
    );
  });
});

test("training_occurrences CHECK rejects end_at <= start_at", async () => {
  const SLOT_ID = "11111111-0000-0000-0000-000000000061";
  const VER_ID = "11111111-0000-0000-0000-000000000051";
  await db.query(
    `DELETE FROM schedule_versions WHERE class_id = $1;`,
    [CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    [VER_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '15:00', '16:00');`,
    [SLOT_ID, VER_ID],
  );
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO training_occurrences
         (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
          occurrence_date, start_at, end_at, status, capacity)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, now(), now(), 'planned', 12);`,
      ["11111111-0000-0000-0000-000000000072", ACADEMY_ID, CLASS_ID, SLOT_ID, VER_ID],
    );
  });
});

test("training_occurrences CHECK rejects capacity <= 0", async () => {
  const SLOT_ID = "11111111-0000-0000-0000-000000000062";
  const VER_ID = "11111111-0000-0000-0000-000000000052";
  await db.query(
    `DELETE FROM schedule_versions WHERE class_id = $1;`,
    [CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    [VER_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '15:00', '16:00');`,
    [SLOT_ID, VER_ID],
  );
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO training_occurrences
         (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
          occurrence_date, start_at, end_at, status, capacity)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, now(), now() + interval '1 hour', 'planned', 0);`,
      ["11111111-0000-0000-0000-000000000073", ACADEMY_ID, CLASS_ID, SLOT_ID, VER_ID],
    );
  });
});

// ---------------------------------------------------------------------------
// Package plans — session_count > 0
// ---------------------------------------------------------------------------

test("package_plans CHECK rejects session_count <= 0", async () => {
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO package_plans (id, academy_id, name, session_count)
       VALUES ($1, $2, 'Bad', 0);`,
      ["11111111-0000-0000-0000-000000000090", ACADEMY_ID],
    );
  });
});

// ---------------------------------------------------------------------------
// session_entitlements.original_occurrence_id immutability (BEFORE UPDATE trigger)
// ---------------------------------------------------------------------------

test("session_entitlements.original_occurrence_id is IMMUTABLE on UPDATE", async () => {
  const SLOT_ID = "11111111-0000-0000-0000-000000000063";
  const VER_ID = "11111111-0000-0000-0000-000000000053";
  const OCC_1 = "11111111-0000-0000-0000-0000000000a0";
  const OCC_2 = "11111111-0000-0000-0000-0000000000a1";
  const PLAN_ID = "11111111-0000-0000-0000-0000000000b0";
  const PKG_ID = "11111111-0000-0000-0000-0000000000b1";
  const ENT_ID = "11111111-0000-0000-0000-0000000000c0";

  await db.query(
    `DELETE FROM schedule_versions WHERE class_id = $1;`,
    [CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    [VER_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '15:00', '16:00');`,
    [SLOT_ID, VER_ID],
  );
  for (const [id, dayOffset] of [[OCC_1, 0], [OCC_2, 7]] as const) {
    await db.query(
      `INSERT INTO training_occurrences
         (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
          occurrence_date, start_at, end_at, status, capacity)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + $6::int,
               now() + interval '$6 day', now() + interval '$6 day' + interval '1 hour',
               'planned', 12);`,
      [id, ACADEMY_ID, CLASS_ID, SLOT_ID, VER_ID, dayOffset],
    );
  }
  await db.query(
    `INSERT INTO package_plans (id, academy_id, name, session_count)
     VALUES ($1, $2, 'Starter 4', 4);`,
    [PLAN_ID, ACADEMY_ID],
  );
  await db.query(
    `INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase)
     VALUES ($1, $2, $3, $4);`,
    [PKG_ID, STUDENT_ID, PLAN_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO session_entitlements
       (id, student_package_id, sequence, original_occurrence_id, assigned_occurrence_id, status)
     VALUES ($1, $2, 1, $3, $3, 'active');`,
    [ENT_ID, PKG_ID, OCC_1],
  );

  // Attempt to change original_occurrence_id — must throw.
  let threw = false;
  let message = "";
  try {
    await db.query(
      `UPDATE session_entitlements SET original_occurrence_id = $1 WHERE id = $2;`,
      [OCC_2, ENT_ID],
    );
  } catch (err) {
    threw = true;
    message = extractOriginalMessage(err);
  }
  expect(threw, "trigger must forbid changing original_occurrence_id").toBe(true);
  expect(
    /immutable|original_occurrence_id/i.test(message),
    `expected immutability error, got: ${message}`,
  ).toBe(true);

  // Verify the row's original_occurrence_id is unchanged.
  const r = await db.query(
    `SELECT original_occurrence_id FROM session_entitlements WHERE id = $1;`,
    [ENT_ID],
  );
  expect((r.rows[0] as { original_occurrence_id: string }).original_occurrence_id).toBe(OCC_1);
});

test("session_entitlements CHECK: status='skipped' requires skip_used=TRUE", async () => {
  const SLOT_ID = "11111111-0000-0000-0000-000000000064";
  const VER_ID = "11111111-0000-0000-0000-000000000054";
  const OCC = "11111111-0000-0000-0000-0000000000a2";
  const PLAN_ID = "11111111-0000-0000-0000-0000000000b2";
  const PKG_ID = "11111111-0000-0000-0000-0000000000b3";
  const ENT_ID = "11111111-0000-0000-0000-0000000000c1";

  await db.query(
    `DELETE FROM schedule_versions WHERE class_id = $1;`,
    [CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    [VER_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '15:00', '16:00');`,
    [SLOT_ID, VER_ID],
  );
  await db.query(
    `INSERT INTO training_occurrences
       (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
        occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, now(), now() + interval '1 hour', 'planned', 12);`,
    [OCC, ACADEMY_ID, CLASS_ID, SLOT_ID, VER_ID],
  );
  await db.query(
    `INSERT INTO package_plans (id, academy_id, name, session_count)
     VALUES ($1, $2, 'Starter 4', 4);`,
    [PLAN_ID, ACADEMY_ID],
  );
  await db.query(
    `INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase)
     VALUES ($1, $2, $3, $4);`,
    [PKG_ID, STUDENT_ID, PLAN_ID, CLASS_ID],
  );
  // status='skipped' + skip_used=FALSE must violate CHECK.
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO session_entitlements
         (id, student_package_id, sequence, original_occurrence_id,
          assigned_occurrence_id, status, skip_used)
       VALUES ($1, $2, 1, $3, NULL, 'skipped', false);`,
      [ENT_ID, PKG_ID, OCC],
    );
  });
});

test("session_entitlements UNIQUE (student_package_id, sequence)", async () => {
  const SLOT_ID = "11111111-0000-0000-0000-000000000065";
  const VER_ID = "11111111-0000-0000-0000-000000000055";
  const OCC = "11111111-0000-0000-0000-0000000000a3";
  const PLAN_ID = "11111111-0000-0000-0000-0000000000b4";
  const PKG_ID = "11111111-0000-0000-0000-0000000000b5";
  const ENT_1 = "11111111-0000-0000-0000-0000000000c2";
  const ENT_2 = "11111111-0000-0000-0000-0000000000c3";

  await db.query(
    `DELETE FROM schedule_versions WHERE class_id = $1;`,
    [CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, CURRENT_DATE, NULL, 'active');`,
    [VER_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '15:00', '16:00');`,
    [SLOT_ID, VER_ID],
  );
  await db.query(
    `INSERT INTO training_occurrences
       (id, academy_id, class_id, schedule_slot_id, schedule_version_id,
        occurrence_date, start_at, end_at, status, capacity)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, now(), now() + interval '1 hour', 'planned', 12);`,
    [OCC, ACADEMY_ID, CLASS_ID, SLOT_ID, VER_ID],
  );
  await db.query(
    `INSERT INTO package_plans (id, academy_id, name, session_count)
     VALUES ($1, $2, 'Starter 4', 4);`,
    [PLAN_ID, ACADEMY_ID],
  );
  await db.query(
    `INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase)
     VALUES ($1, $2, $3, $4);`,
    [PKG_ID, STUDENT_ID, PLAN_ID, CLASS_ID],
  );
  await db.query(
    `INSERT INTO session_entitlements
       (id, student_package_id, sequence, original_occurrence_id, status)
     VALUES ($1, $2, 1, $3, 'active');`,
    [ENT_1, PKG_ID, OCC],
  );
  await expectUniqueViolation(async () => {
    await db.query(
      `INSERT INTO session_entitlements
         (id, student_package_id, sequence, original_occurrence_id, status)
       VALUES ($1, $2, 1, $3, 'active');`,
      [ENT_2, PKG_ID, OCC],
    );
  });
});

// ---------------------------------------------------------------------------
// Payments — confirmed payments require reviewer info (CHECK)
// ---------------------------------------------------------------------------

test("payments CHECK: status='confirmed' requires reviewed_by + reviewed_at", async () => {
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO payments
         (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status)
       VALUES ($1, $2, $3, $4, 100.00, 'IDR', 'confirmed');`,
      [
        "11111111-0000-0000-0000-0000000000d0",
        ACADEMY_ID,
        USER_ID_1,
        STUDENT_ID,
      ],
    );
  });
});

test("payments CHECK: submitted_amount >= 0", async () => {
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO payments
         (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status)
       VALUES ($1, $2, $3, $4, -1.00, 'IDR', 'submitted');`,
      [
        "11111111-0000-0000-0000-0000000000d1",
        ACADEMY_ID,
        USER_ID_1,
        STUDENT_ID,
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Student training videos — youtube_url must match allowed host pattern
// ---------------------------------------------------------------------------

test("student_training_videos CHECK rejects non-YouTube URLs", async () => {
  await expectCheckViolation(async () => {
    await db.query(
      `INSERT INTO student_training_videos
         (id, student_id, uploaded_by, title, youtube_url, is_published)
       VALUES ($1, $2, $3, 'Bad', 'https://evil.example.com/video.mp4', true);`,
      [
        "11111111-0000-0000-0000-0000000000e0",
        STUDENT_ID,
        USER_ID_1,
      ],
    );
  });
});

test("student_training_videos accepts youtube.com and youtu.be URLs", async () => {
  await db.query(
    `INSERT INTO student_training_videos
       (id, student_id, uploaded_by, title, youtube_url, is_published)
     VALUES ($1, $2, $3, 'A', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', true);`,
    ["11111111-0000-0000-0000-0000000000e1", STUDENT_ID, USER_ID_1],
  );
  await db.query(
    `INSERT INTO student_training_videos
       (id, student_id, uploaded_by, title, youtube_url, is_published)
     VALUES ($1, $2, $3, 'B', 'https://youtu.be/dQw4w9WgXcQ', true);`,
    ["11111111-0000-0000-0000-0000000000e2", STUDENT_ID, USER_ID_1],
  );
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM student_training_videos WHERE student_id = $1;`,
    [STUDENT_ID],
  );
  expect((r.rows[0] as { c: number }).c).toBe(2);
});
