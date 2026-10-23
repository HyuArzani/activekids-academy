export type AttendanceStatus = "present" | "absent" | "excused";

export function isAttendanceStatus(value: unknown): value is AttendanceStatus {
  return value === "present" || value === "absent" || value === "excused";
}

/** Lock starts at midnight Asia/Jakarta on the date seven days after occurrence. */
export function isAttendanceHistoryLocked(occurrenceDate: Date | string, now: Date = new Date()): boolean {
  let dateText: string;
  if (occurrenceDate instanceof Date) {
    if (!Number.isFinite(occurrenceDate.getTime())) return true;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(occurrenceDate);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    dateText = `${values.year}-${values.month}-${values.day}`;
  } else {
    dateText = occurrenceDate;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return true;
  const utcDate = new Date(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(utcDate.getTime()) || utcDate.toISOString().slice(0, 10) !== dateText) return true;
  const boundary = new Date(`${dateText}T00:00:00+07:00`);
  boundary.setUTCDate(boundary.getUTCDate() + 7);
  return !Number.isFinite(now.getTime()) || now.getTime() >= boundary.getTime();
}
