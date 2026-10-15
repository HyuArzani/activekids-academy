/**
 * Domain test helper. Extends the auth test helper with domain-specific
 * setup: academy, class, schedule version, slots, package plans, and a
 * principal with admin role.
 *
 * Run under Bun (`bun test`). All tests are PgLite-backed (NOT real
 * PostgreSQL server — see Phase 1 worklog for limitations).
 */

import { PGlite } from "@electric-sql/pglite";
import { createPgLiteAdapter, __setDbForTesting, type DbClient } from "@/lib/db";
import { applyAllMigrations } from "@/lib/db/migrate";
import { hashPassword, paramsToJson } from "@/lib/auth/password";
import { randomUUID } from "node:crypto";
import type { Principal } from "@/lib/auth/principal";

export const ACADEMY_ID = "d0000000-0000-0000-0000-000000000001";
export const CLASS_ID = "d0000000-0000-0000-0000-000000000010";
export const SCHEDULE_VERSION_ID = "d0000000-0000-0000-0000-000000000020";

let currentDb: { raw: PGlite; client: DbClient } | null = null;

export async function setupDomainDb(): Promise<DbClient> {
  const raw = new PGlite();
  const client = createPgLiteAdapter(raw);
  await applyAllMigrations(client);
  __setDbForTesting(client);
  currentDb = { raw, client };
  return client;
}

export async function teardownDomainDb(): Promise<void> {
  if (currentDb) {
    await currentDb.client.close().catch(() => {});
    currentDb = null;
  }
  __setDbForTesting(null);
}

/** Build a Principal with admin role in the test academy. */
export function buildAdminPrincipal(userId: string): Principal {
  return {
    userId,
    email: "admin@domain-test.example",
    fullName: "Test Admin",
    status: "active",
    mustChangePassword: false,
    memberships: [{ academyId: ACADEMY_ID, role: "admin", status: "active" }],
    sessionId: "test-session-id",
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
  };
}

/** Build a Principal with coach role in the test academy. */
export function buildCoachPrincipal(userId: string): Principal {
  return {
    ...buildAdminPrincipal(userId),
    email: "coach@domain-test.example",
    memberships: [{ academyId: ACADEMY_ID, role: "coach", status: "active" }],
  };
}

/** Build a Principal with parent role in the test academy. */
export function buildParentPrincipal(userId: string): Principal {
  return {
    ...buildAdminPrincipal(userId),
    email: "parent@domain-test.example",
    memberships: [{ academyId: ACADEMY_ID, role: "parent", status: "active" }],
  };
}

/** Build a Principal with admin role in a DIFFERENT academy (for cross-academy tests). */
export function buildOtherAcademyPrincipal(userId: string, otherAcademyId: string): Principal {
  return {
    ...buildAdminPrincipal(userId),
    email: "other@domain-test.example",
    memberships: [{ academyId: otherAcademyId, role: "admin", status: "active" }],
  };
}

export interface DomainSetup {
  db: DbClient;
  admin: Principal;
  adminUserId: string;
  studentId: string;
  classId: string;
  scheduleVersionId: string;
  slotIds: { tue: string; sat: string };
  plan4Id: string;
  plan8Id: string;
}

/**
 * Set up the full domain test fixture: academy, class, schedule version +
 * slots (Tue 15:00, Sat 15:00), two package plans (4 and 8 sessions),
 * one admin user, and one student.
 */
export async function setupDomainFixture(): Promise<DomainSetup> {
  const db = await setupDomainDb();

  // Academy
  await db.query(
    `INSERT INTO academies (id, name, slug, timezone, is_active)
     VALUES ($1, 'Test Academy', 'test', 'Asia/Jakarta', true);`,
    [ACADEMY_ID],
  );

  // Admin user
  const adminUserId = randomUUID();
  const hash = await hashPassword("password123");
  await db.query(
    `INSERT INTO users (id, email, status, must_change_password)
     VALUES ($1, 'admin@domain-test.example', 'active', false);`,
    [adminUserId],
  );
  await db.query(
    `INSERT INTO user_credentials (user_id, argon2id_hash, argon2_params)
     VALUES ($1, $2, $3);`,
    [adminUserId, hash, JSON.stringify(paramsToJson())],
  );
  await db.query(
    `INSERT INTO academy_memberships (id, user_id, academy_id, role, status)
     VALUES ($1, $2, $3, 'admin', 'active');`,
    [randomUUID(), adminUserId, ACADEMY_ID],
  );

  // Class
  await db.query(
    `INSERT INTO classes (id, academy_id, name, capacity, is_active)
     VALUES ($1, $2, 'Test Class', 12, true);`,
    [CLASS_ID, ACADEMY_ID],
  );

  // Schedule version (active, effective from a fixed past date so tests
  // can use fixed dates without hitting the "before effective date" check)
  await db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, '2026-01-01', NULL, 'active');`,
    [SCHEDULE_VERSION_ID, CLASS_ID],
  );

  // Slots: Tuesday (2) and Saturday (6) at 15:00
  const tueSlotId = randomUUID();
  const satSlotId = randomUUID();
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '15:00', '16:00');`,
    [tueSlotId, SCHEDULE_VERSION_ID],
  );
  await db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 6, '15:00', '16:00');`,
    [satSlotId, SCHEDULE_VERSION_ID],
  );

  // Package plans
  const plan4Id = randomUUID();
  const plan8Id = randomUUID();
  await db.query(
    `INSERT INTO package_plans (id, academy_id, name, session_count, is_active)
     VALUES ($1, $2, 'Starter 4', 4, true);`,
    [plan4Id, ACADEMY_ID],
  );
  await db.query(
    `INSERT INTO package_plans (id, academy_id, name, session_count, is_active)
     VALUES ($1, $2, 'Standard 8', 8, true);`,
    [plan8Id, ACADEMY_ID],
  );

  // Student
  const studentId = randomUUID();
  await db.query(
    `INSERT INTO students (id, academy_id, full_name)
     VALUES ($1, $2, 'Test Student');`,
    [studentId, ACADEMY_ID],
  );

  const admin = buildAdminPrincipal(adminUserId);

  return {
    db,
    admin,
    adminUserId,
    studentId,
    classId: CLASS_ID,
    scheduleVersionId: SCHEDULE_VERSION_ID,
    slotIds: { tue: tueSlotId, sat: satSlotId },
    plan4Id,
    plan8Id,
  };
}
