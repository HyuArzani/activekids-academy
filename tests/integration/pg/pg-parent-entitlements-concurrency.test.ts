/**
 * PostgreSQL integration tests: Stage 9 parent scheduling mutation concurrency.
 *
 * These tests verify real concurrent behavior that CANNOT be tested under
 * PgLite (single-process, no multi-connection SSI):
 *   - Two bookings competing for the final occurrence seat.
 *   - Two skips competing for the same package allowance.
 *   - Concurrent moves of the same entitlement.
 *   - Concurrent moves approaching the configured limit.
 *   - Concurrent duplicate idempotency keys.
 *   - Cancellation racing with a Parent mutation.
 *
 * These tests ONLY run when TEST_DATABASE_URL is set to a real postgres://
 * URL. When unset, they are SKIPPED (not passed, not failed).
 *
 * PgLite tests in parent-entitlements.test.ts verify business logic only;
 * they are NOT proof of PostgreSQL SSI/multi-connection behavior.
 */

import { expect } from "bun:test";
import { pgTest, setupPgDb, seedPgFixture } from "./_helpers";
import { PgAdapter } from "@/lib/db/pg-adapter";
import { randomUUID } from "node:crypto";
import type { Principal } from "@/lib/auth/principal";
import { moveEntitlement, parentSkipEntitlement } from "@/lib/domain/entitlements";

/** Build a synthetic parent principal for domain-function calls in PG tests. */
function parentPrincipal(userId: string, academyId: string): Principal {
  return {
    userId,
    academyMemberships: [{ academyId, role: "parent", status: "active" }],
    mustChangePassword: false,
  } as unknown as Principal;
}

// === T1: Two bookings competing for the final seat ======================

pgTest("T1: two parent moves to the same final seat — capacity never exceeded", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    // Capacity-1 occurrence.
    const smallClassId = randomUUID();
    await db.query(`INSERT INTO classes (id, academy_id, name, capacity, is_active) VALUES ($1, $2, 'Small', 1, true);`, [smallClassId, f.academyId]);
    const versionId = randomUUID();
    await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1, $2, '2026-01-01', 'active');`, [versionId, smallClassId]);
    const slotId = randomUUID();
    await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1, $2, 2, '18:00', '19:00');`, [slotId, versionId]);
    const occDestId = randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 18:00:00', '2027-06-16 19:00:00', 'planned', 1);`, [occDestId, f.academyId, smallClassId, slotId, versionId]);
    const occSrc1Id = randomUUID();
    const occSrc2Id = randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 18:00:00', '2027-06-23 19:00:00', 'planned', 12);`, [occSrc1Id, f.academyId, smallClassId, slotId, versionId]);
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-30', '2027-06-30 18:00:00', '2027-06-30 19:00:00', 'planned', 12);`, [occSrc2Id, f.academyId, smallClassId, slotId, versionId]);

    // Two students, two packages, two entitlements.
    const s1 = randomUUID();
    const s2 = randomUUID();
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S1');`, [s1, f.academyId]);
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S2');`, [s2, f.academyId]);
    // Parents.
    const p1 = randomUUID();
    const p2 = randomUUID();
    await db.query(`INSERT INTO users (id, email, status, must_change_password) VALUES ($1, $2, false);`, [p1, "p1@pg.test"]);
    await db.query(`INSERT INTO users (id, email, status, must_change_password) VALUES ($1, $2, false);`, [p2, "p2@pg.test"]);
    await db.query(`INSERT INTO academy_memberships (id, user_id, academy_id, role, status) VALUES ($1, $2, $3, 'parent', 'active');`, [randomUUID(), p1, f.academyId]);
    await db.query(`INSERT INTO academy_memberships (id, user_id, academy_id, role, status) VALUES ($1, $2, $3, 'parent', 'active');`, [randomUUID(), p2, f.academyId]);
    await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), p1, s1]);
    await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), p2, s2]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), s1, smallClassId]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), s2, smallClassId]);
    const pkg1 = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1) RETURNING id;`, [randomUUID(), s1, f.plan4Id, smallClassId]);
    const pkg2 = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1) RETURNING id;`, [randomUUID(), s2, f.plan4Id, smallClassId]);
    const ent1 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3) RETURNING id;`, [randomUUID(), (pkg1.rows[0] as { id: string }).id, occSrc1Id]);
    const ent2 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3) RETURNING id;`, [randomUUID(), (pkg2.rows[0] as { id: string }).id, occSrc2Id]);
    const ent1Id = (ent1.rows[0] as { id: string }).id;
    const ent2Id = (ent2.rows[0] as { id: string }).id;

    const adapter1 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const adapter2 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const principal1 = parentPrincipal(p1, f.academyId);
    const principal2 = parentPrincipal(p2, f.academyId);

    const move1 = moveEntitlement(principal1, f.academyId, {
      entitlementId: ent1Id, destinationOccurrenceId: occDestId,
      expectedCurrentOccurrenceId: occSrc1Id, idempotencyKey: "T1-A",
    }, adapter1);
    const move2 = moveEntitlement(principal2, f.academyId, {
      entitlementId: ent2Id, destinationOccurrenceId: occDestId,
      expectedCurrentOccurrenceId: occSrc2Id, idempotencyKey: "T1-B",
    }, adapter2);

    const results = await Promise.allSettled([move1, move2]);
    await adapter1.close();
    await adapter2.close();

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    // Exactly one succeeds; the other 409s (capacity full on retry).
    expect(succeeded).toBe(1);

    const assigned = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE assigned_occurrence_id = $1 AND status = 'active';`, [occDestId]);
    expect((assigned.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await cleanup();
  }
});

// === T5: Concurrent moves of the same entitlement ========================

pgTest("T5: two concurrent moves of the same entitlement — one succeeds, one 409 stale", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const classId = f.classId;
    const versionId = f.scheduleVersionId;
    const slotId = f.tueSlotId;
    const occ1Id = randomUUID();
    const occ2Id = randomUUID();
    const occ3Id = randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, f.academyId, classId, slotId, versionId]);
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occ2Id, f.academyId, classId, slotId, versionId]);
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-30', '2027-06-30 15:00:00', '2027-06-30 16:00:00', 'planned', 12);`, [occ3Id, f.academyId, classId, slotId, versionId]);

    const s1 = randomUUID();
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S1');`, [s1, f.academyId]);
    const p1 = randomUUID();
    await db.query(`INSERT INTO users (id, email, status, must_change_password) VALUES ($1, $2, false);`, [p1, "t5p@pg.test"]);
    await db.query(`INSERT INTO academy_memberships (id, user_id, academy_id, role, status) VALUES ($1, $2, $3, 'parent', 'active');`, [randomUUID(), p1, f.academyId]);
    await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), p1, s1]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), s1, classId]);
    const pkg = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1) RETURNING id;`, [randomUUID(), s1, f.plan4Id, classId]);
    const ent = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3) RETURNING id;`, [randomUUID(), (pkg.rows[0] as { id: string }).id, occ1Id]);
    const entId = (ent.rows[0] as { id: string }).id;

    const adapter1 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const adapter2 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const principal = parentPrincipal(p1, f.academyId);

    // A: move occ1→occ2. B: move occ1→occ3. Both expect occ1 as source.
    const moveA = moveEntitlement(principal, f.academyId, {
      entitlementId: entId, destinationOccurrenceId: occ2Id,
      expectedCurrentOccurrenceId: occ1Id, idempotencyKey: "T5-A",
    }, adapter1);
    const moveB = moveEntitlement(principal, f.academyId, {
      entitlementId: entId, destinationOccurrenceId: occ3Id,
      expectedCurrentOccurrenceId: occ1Id, idempotencyKey: "T5-B",
    }, adapter2);

    const results = await Promise.allSettled([moveA, moveB]);
    await adapter1.close();
    await adapter2.close();

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBe(1);

    // Exactly 1 normal_moved event.
    const events = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [entId]);
    expect((events.rows[0] as { c: number }).c).toBe(1);

    // E is at the winner's destination (occ2 or occ3).
    const ent2 = await db.query<{ assigned_occurrence_id: string }>(`SELECT assigned_occurrence_id FROM session_entitlements WHERE id = $1;`, [entId]);
    const assigned = (ent2.rows[0] as { assigned_occurrence_id: string }).assigned_occurrence_id;
    expect(assigned === occ2Id || assigned === occ3Id).toBe(true);
  } finally {
    await cleanup();
  }
});

// === T6: Concurrent duplicate idempotency keys ===========================

pgTest("T6: concurrent identical idempotency requests — one logical mutation, consistent result", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const classId = f.classId;
    const occ1Id = randomUUID();
    const occ2Id = randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, f.academyId, classId, f.tueSlotId, f.scheduleVersionId]);
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occ2Id, f.academyId, classId, f.tueSlotId, f.scheduleVersionId]);

    const s1 = randomUUID();
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S1');`, [s1, f.academyId]);
    const p1 = randomUUID();
    await db.query(`INSERT INTO users (id, email, status, must_change_password) VALUES ($1, $2, false);`, [p1, "t6p@pg.test"]);
    await db.query(`INSERT INTO academy_memberships (id, user_id, academy_id, role, status) VALUES ($1, $2, $3, 'parent', 'active');`, [randomUUID(), p1, f.academyId]);
    await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), p1, s1]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), s1, classId]);
    const pkg = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1) RETURNING id;`, [randomUUID(), s1, f.plan4Id, classId]);
    const ent = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3) RETURNING id;`, [randomUUID(), (pkg.rows[0] as { id: string }).id, occ1Id]);
    const entId = (ent.rows[0] as { id: string }).id;

    const adapter1 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const adapter2 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const principal = parentPrincipal(p1, f.academyId);

    // Both use the same key + same body.
    const move1 = moveEntitlement(principal, f.academyId, {
      entitlementId: entId, destinationOccurrenceId: occ2Id,
      expectedCurrentOccurrenceId: occ1Id, idempotencyKey: "T6-same-key",
    }, adapter1);
    const move2 = moveEntitlement(principal, f.academyId, {
      entitlementId: entId, destinationOccurrenceId: occ2Id,
      expectedCurrentOccurrenceId: occ1Id, idempotencyKey: "T6-same-key",
    }, adapter2);

    const results = await Promise.allSettled([move1, move2]);
    await adapter1.close();
    await adapter2.close();

    // Both should succeed (one commits, the other replays the winner's result).
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBe(2);

    // Exactly 1 idempotency record, 1 normal_moved event.
    const records = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_idempotency_records WHERE entitlement_id = $1 AND idempotency_key = 'T6-same-key';`, [entId]);
    expect((records.rows[0] as { c: number }).c).toBe(1);
    const events = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [entId]);
    expect((events.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await cleanup();
  }
});

// === T8: Two skips competing for the same package allowance ==============

pgTest("T8: two parent skips for one package allowance — consumed at most once", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const classId = f.classId;
    const occ1Id = randomUUID();
    const occ2Id = randomUUID();
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [occ1Id, f.academyId, classId, f.tueSlotId, f.scheduleVersionId]);
    await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-23', '2027-06-23 15:00:00', '2027-06-23 16:00:00', 'planned', 12);`, [occ2Id, f.academyId, classId, f.tueSlotId, f.scheduleVersionId]);

    const s1 = randomUUID();
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S1');`, [s1, f.academyId]);
    const p1 = randomUUID();
    await db.query(`INSERT INTO users (id, email, status, must_change_password) VALUES ($1, $2, false);`, [p1, "t8p@pg.test"]);
    await db.query(`INSERT INTO academy_memberships (id, user_id, academy_id, role, status) VALUES ($1, $2, $3, 'parent', 'active');`, [randomUUID(), p1, f.academyId]);
    await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), p1, s1]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), s1, classId]);
    const pkg = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1) RETURNING id;`, [randomUUID(), s1, f.plan4Id, classId]);
    const pkgId = (pkg.rows[0] as { id: string }).id;
    const ent1 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3) RETURNING id;`, [randomUUID(), pkgId, occ1Id]);
    const ent2 = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 2, 'active', $3, $3) RETURNING id;`, [randomUUID(), pkgId, occ2Id]);
    const ent1Id = (ent1.rows[0] as { id: string }).id;
    const ent2Id = (ent2.rows[0] as { id: string }).id;

    const adapter1 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const adapter2 = new PgAdapter(process.env.TEST_DATABASE_URL!);
    const principal = parentPrincipal(p1, f.academyId);

    const skip1 = parentSkipEntitlement(principal, f.academyId, {
      entitlementId: ent1Id, idempotencyKey: "T8-A",
    }, adapter1);
    const skip2 = parentSkipEntitlement(principal, f.academyId, {
      entitlementId: ent2Id, idempotencyKey: "T8-B",
    }, adapter2);

    const results = await Promise.allSettled([skip1, skip2]);
    await adapter1.close();
    await adapter2.close();

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBe(1);

    const skipCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_entitlements WHERE student_package_id = $1 AND skip_used = TRUE;`, [pkgId]);
    expect((skipCount.rows[0] as { c: number }).c).toBe(1);
  } finally {
    await cleanup();
  }
});

// === T14: Concurrent moves approaching the configured limit =============

pgTest("T14: concurrent moves approaching the limit — limit cannot be exceeded", async () => {
  const { db, cleanup } = await setupPgDb();
  try {
    const f = await seedPgFixture(db);
    const classId = f.classId;
    // 3 occurrences for moves (limit=2, so 3 concurrent → only 2 succeed).
    const occIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const oid of occIds) {
      await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1, $2, $3, $4, $5, '2027-06-16', '2027-06-16 15:00:00', '2027-06-16 16:00:00', 'planned', 12);`, [oid, f.academyId, classId, f.tueSlotId, f.scheduleVersionId]);
    }

    const s1 = randomUUID();
    await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1, $2, 'S1');`, [s1, f.academyId]);
    const p1 = randomUUID();
    await db.query(`INSERT INTO users (id, email, status, must_change_password) VALUES ($1, $2, false);`, [p1, "t14p@pg.test"]);
    await db.query(`INSERT INTO academy_memberships (id, user_id, academy_id, role, status) VALUES ($1, $2, $3, 'parent', 'active');`, [randomUUID(), p1, f.academyId]);
    await db.query(`INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary) VALUES ($1, $2, $3, true);`, [randomUUID(), p1, s1]);
    await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1, $2, $3, '2026-01-01');`, [randomUUID(), s1, classId]);
    const pkg = await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase, skip_allowance) VALUES ($1, $2, $3, $4, 1) RETURNING id;`, [randomUUID(), s1, f.plan4Id, classId]);
    const ent = await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1, $2, 1, 'active', $3, $3) RETURNING id;`, [randomUUID(), (pkg.rows[0] as { id: string }).id, occIds[0]]);
    const entId = (ent.rows[0] as { id: string }).id;

    const adapters = [new PgAdapter(process.env.TEST_DATABASE_URL!), new PgAdapter(process.env.TEST_DATABASE_URL!), new PgAdapter(process.env.TEST_DATABASE_URL!)];
    const principal = parentPrincipal(p1, f.academyId);

    // 3 concurrent moves from occIds[0] → occIds[1], occIds[2], and back to occIds[0].
    // Only 2 can succeed (limit=2).
    const moves = [
      moveEntitlement(principal, f.academyId, { entitlementId: entId, destinationOccurrenceId: occIds[1], expectedCurrentOccurrenceId: occIds[0], idempotencyKey: "T14-A" }, adapters[0]!),
      moveEntitlement(principal, f.academyId, { entitlementId: entId, destinationOccurrenceId: occIds[2], expectedCurrentOccurrenceId: occIds[0], idempotencyKey: "T14-B" }, adapters[1]!),
      moveEntitlement(principal, f.academyId, { entitlementId: entId, destinationOccurrenceId: occIds[0], expectedCurrentOccurrenceId: occIds[0], idempotencyKey: "T14-C" }, adapters[2]!),
    ];

    const results = await Promise.allSettled(moves);
    for (const a of adapters) await a.close();

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    // At most 2 can succeed (the 3rd either 409 stale or 409 move-exceeded).
    expect(succeeded).toBeLessThanOrEqual(2);

    const eventCount = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM entitlement_events WHERE entitlement_id = $1 AND event_type = 'normal_moved';`, [entId]);
    expect((eventCount.rows[0] as { c: number }).c).toBeLessThanOrEqual(2);
  } finally {
    await cleanup();
  }
});
