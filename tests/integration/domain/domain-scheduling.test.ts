/**
 * Domain test: Schedule occurrence generation.
 *
 * Tests invariant #8: changing a recurring schedule must not silently
 * rewrite existing occurrences or move paid entitlements.
 *
 * Tests idempotent generation (same call twice = no new rows).
 * Tests that occurrences preserve the schedule_version_id snapshot.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDomainFixture, teardownDomainDb, ACADEMY_ID, type DomainSetup } from "./_helpers";
import { generateOccurrences } from "@/lib/domain/scheduling";
import { AppError } from "@/lib/errors";

let setup: DomainSetup;

beforeEach(async () => {
  setup = await setupDomainFixture();
});

afterEach(async () => {
  await teardownDomainDb();
});

test("generateOccurrences creates occurrences for Tue and Sat slots", async () => {
  const result = await generateOccurrences(setup.admin, ACADEMY_ID, {
    classId: setup.classId,
    fromDate: new Date("2026-01-04"), // a Sunday
    weeksAhead: 2,
  }, setup.db);

  // 2 weeks × 2 slots (Tue + Sat) = 4 occurrences.
  expect(result.generated).toBe(4);
  expect(result.idempotent).toBe(false);
});

test("generateOccurrences is idempotent (running twice produces no new rows)", async () => {
  const input = {
    classId: setup.classId,
    fromDate: new Date("2026-01-04"),
    weeksAhead: 2,
  };

  const result1 = await generateOccurrences(setup.admin, ACADEMY_ID, input, setup.db);
  expect(result1.generated).toBe(4);

  const result2 = await generateOccurrences(setup.admin, ACADEMY_ID, input, setup.db);
  expect(result2.generated).toBe(0);
  expect(result2.idempotent).toBe(true);

  // Verify total occurrences in DB = 4 (not 8).
  const countResult = await setup.db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM training_occurrences WHERE class_id = $1;`,
    [setup.classId],
  );
  expect((countResult.rows[0] as { c: number }).c).toBe(4);
});

test("occurrences preserve the schedule_version_id snapshot", async () => {
  await generateOccurrences(setup.admin, ACADEMY_ID, {
    classId: setup.classId,
    fromDate: new Date("2026-01-04"),
    weeksAhead: 1,
  }, setup.db);

  // Verify all occurrences reference the original schedule version.
  const occResult = await setup.db.query<{ schedule_version_id: string }>(
    `SELECT schedule_version_id FROM training_occurrences WHERE class_id = $1;`,
    [setup.classId],
  );
  for (const row of occResult.rows as { schedule_version_id: string }[]) {
    expect(row.schedule_version_id).toBe(setup.scheduleVersionId);
  }
});

test("changing the schedule version does NOT rewrite existing occurrences", async () => {
  // Generate occurrences with the original version.
  await generateOccurrences(setup.admin, ACADEMY_ID, {
    classId: setup.classId,
    fromDate: new Date("2026-01-04"),
    weeksAhead: 2,
  }, setup.db);

  // Get the original occurrences' version IDs.
  const beforeResult = await setup.db.query<{ id: string; schedule_version_id: string }>(
    `SELECT id, schedule_version_id FROM training_occurrences WHERE class_id = $1;`,
    [setup.classId],
  );
  const beforeRows = beforeResult.rows as { id: string; schedule_version_id: string }[];

  // Close the old version and create a new one.
  await setup.db.query(
    `UPDATE schedule_versions SET effective_to = '2026-01-15', status = 'superseded' WHERE id = $1;`,
    [setup.scheduleVersionId],
  );
  const newVersionId = randomUUID();
  await setup.db.query(
    `INSERT INTO schedule_versions (id, class_id, effective_from, effective_to, status)
     VALUES ($1, $2, '2026-01-16', NULL, 'active');`,
    [newVersionId, setup.classId],
  );
  // Add a slot to the new version.
  await setup.db.query(
    `INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time)
     VALUES ($1, $2, 2, '17:00', '18:00');`,
    [randomUUID(), newVersionId],
  );

  // Generate occurrences from the new version.
  await generateOccurrences(setup.admin, ACADEMY_ID, {
    classId: setup.classId,
    fromDate: new Date("2026-01-20"),
    weeksAhead: 1,
  }, setup.db);

  // Verify the ORIGINAL occurrences still reference the OLD version.
  const afterResult = await setup.db.query<{ id: string; schedule_version_id: string }>(
    `SELECT id, schedule_version_id FROM training_occurrences WHERE class_id = $1;`,
    [setup.classId],
  );
  const afterRows = afterResult.rows as { id: string; schedule_version_id: string }[];

  // The original occurrences should still have the old version ID.
  for (const beforeRow of beforeRows) {
    const afterRow = afterRows.find(r => r.id === beforeRow.id);
    expect(afterRow).toBeDefined();
    expect(afterRow!.schedule_version_id).toBe(beforeRow.schedule_version_id);
  }
});

test("generateOccurrences fails without an active schedule version", async () => {
  // Close the existing version.
  await setup.db.query(
    `UPDATE schedule_versions SET effective_to = CURRENT_DATE, status = 'superseded' WHERE id = $1;`,
    [setup.scheduleVersionId],
  );

  try {
    await generateOccurrences(setup.admin, ACADEMY_ID, {
      classId: setup.classId,
      fromDate: new Date(),
      weeksAhead: 1,
    }, setup.db);
    expect.fail("should have thrown");
  } catch (err) {
    expect((err as AppError).code).toBe("CONFLICT");
  }
});
