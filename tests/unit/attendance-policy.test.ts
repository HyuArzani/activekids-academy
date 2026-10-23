import { describe, expect, test } from "bun:test";
import { isAttendanceStatus, isAttendanceHistoryLocked } from "@/lib/domain/attendance-policy";

describe("attendance policy", () => {
  test("accepts only the approved attendance statuses", () => {
    expect(isAttendanceStatus("present")).toBe(true);
    expect(isAttendanceStatus("absent")).toBe(true);
    expect(isAttendanceStatus("excused")).toBe(true);
    expect(isAttendanceStatus("late")).toBe(false);
    expect(isAttendanceStatus("unknown")).toBe(false);
  });

  test("locks at midnight Asia/Jakarta seven calendar days after occurrence", () => {
    const occurrenceDate = "2026-10-01";
    expect(isAttendanceHistoryLocked(occurrenceDate, new Date("2026-10-07T16:59:59.999Z"))).toBe(false);
    expect(isAttendanceHistoryLocked(occurrenceDate, new Date("2026-10-07T17:00:00.000Z"))).toBe(true);
  });

  test("uses the Jakarta calendar date when given an occurrence instant", () => {
    const occurrenceInstant = new Date("2026-10-01T16:59:00.000Z");
    expect(isAttendanceHistoryLocked(occurrenceInstant, new Date("2026-10-07T16:59:59.999Z"))).toBe(false);
    expect(isAttendanceHistoryLocked(occurrenceInstant, new Date("2026-10-07T17:00:00.000Z"))).toBe(true);
  });

  test("treats an invalid occurrence date as locked", () => {
    expect(isAttendanceHistoryLocked("not-a-date", new Date("2026-10-01T00:00:00.000Z"))).toBe(true);
  });
});
