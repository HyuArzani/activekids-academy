/**
 * Phase B5.6b-3 — Language consistency tests for Admin
 * Attendance + Registrations sections.
 *
 * Verifies that AttendanceManagement.tsx + RegistrationsManagement.tsx
 * use Bahasa Indonesia for user-facing strings. SOURCE-LEVEL checks.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(relPath: string): string {
  return readFileSync(resolve(import.meta.dir, "../../src/components/admin", relPath), "utf-8");
}

function stripComments(src: string): string {
  return src.replace(/^.*\/\/.*$/gm, "");
}

// ============================================================================
// AttendanceManagement.tsx
// ============================================================================

const ATTENDANCE = readSource("AttendanceManagement.tsx");
const ATTENDANCE_NC = stripComments(ATTENDANCE);

test("AttendanceManagement: key Indonesian strings present", () => {
  expect(ATTENDANCE).toContain("Kehadiran");
  expect(ATTENDANCE).toContain("Hadir");
  expect(ATTENDANCE).toContain("Tidak Hadir");
  expect(ATTENDANCE).toContain("Izin");
  expect(ATTENDANCE).toContain("Segarkan");
  expect(ATTENDANCE).toContain("Simpan");
  expect(ATTENDANCE).toContain("Kembali");
  expect(ATTENDANCE).toContain("Coba lagi");
  expect(ATTENDANCE).toContain("Memuat");
  expect(ATTENDANCE).toContain("Gagal");
  expect(ATTENDANCE).toContain("Kesalahan jaringan");
  // Toasts
  expect(ATTENDANCE).toContain("Kehadiran tersimpan");
  expect(ATTENDANCE).toContain("Gagal menyimpan kehadiran");
});

test("AttendanceManagement: attendance status DISPLAY translated, VALUES preserved", () => {
  // Enum VALUES used in code comparisons remain English.
  expect(ATTENDANCE).toContain('"present"');
  expect(ATTENDANCE).toContain('"absent"');
  expect(ATTENDANCE).toContain('"excused"');
  // Display text translated.
  expect(ATTENDANCE).toContain("Hadir");
  expect(ATTENDANCE).toContain("Tidak Hadir");
  expect(ATTENDANCE).toContain("Izin");
});

test("AttendanceManagement: no English UI strings remain as display text", () => {
  const patterns = [
    /Loading roster/,
    /Failed to load roster/,
    /Take attendance/,
    /Save all/,
    /Attendance saved/,
    /Failed to save attendance/,
  ];
  for (const p of patterns) {
    expect(ATTENDANCE_NC, `should not contain "${p}"`).not.toMatch(p);
  }
});

test("AttendanceManagement: API field names remain English", () => {
  expect(ATTENDANCE).toContain("occurrenceId");
  expect(ATTENDANCE).toContain("attendanceId");
  expect(ATTENDANCE).toContain("student_id");
  expect(ATTENDANCE).toContain("full_name");
  expect(ATTENDANCE).toContain("attendance_status");
});

// ============================================================================
// RegistrationsManagement.tsx
// ============================================================================

const REGISTRATIONS = readSource("RegistrationsManagement.tsx");
const REGISTRATIONS_NC = stripComments(REGISTRATIONS);

test("RegistrationsManagement: key Indonesian strings present", () => {
  expect(REGISTRATIONS).toContain("Pendaftaran");
  expect(REGISTRATIONS).toContain("Menunggu");
  expect(REGISTRATIONS).toContain("Disetujui");
  expect(REGISTRATIONS).toContain("Ditolak");
  expect(REGISTRATIONS).toContain("Setujui");
  expect(REGISTRATIONS).toContain("Tolak");
  expect(REGISTRATIONS).toContain("Alasan");
  expect(REGISTRATIONS).toContain("Cari");
  expect(REGISTRATIONS).toContain("Segarkan");
  expect(REGISTRATIONS).toContain("Memuat");
  expect(REGISTRATIONS).toContain("Gagal");
  expect(REGISTRATIONS).toContain("Kesalahan jaringan");
  expect(REGISTRATIONS).toContain("Orang Tua");
  expect(REGISTRATIONS).toContain("Anak");
  expect(REGISTRATIONS).toContain("Catatan");
  expect(REGISTRATIONS).toContain("Batal");
  // Toasts
  expect(REGISTRATIONS).toContain("Pendaftaran disetujui");
  expect(REGISTRATIONS).toContain("Pendaftaran ditolak");
  expect(REGISTRATIONS).toContain("Gagal menyetujui pendaftaran");
  expect(REGISTRATIONS).toContain("Gagal menolak pendaftaran");
});

test("RegistrationsManagement: status enum VALUES preserved", () => {
  expect(REGISTRATIONS).toContain('"pending"');
  expect(REGISTRATIONS).toContain('"approved"');
  expect(REGISTRATIONS).toContain('"rejected"');
});

test("RegistrationsManagement: no English UI strings remain as display text", () => {
  // "Approve"/"Reject" appear in internal identifiers (handleApprove,
  // approving, approveError, etc.) — those are correctly NOT translated.
  // We check for display-only patterns (loading, error, toast titles).
  const patterns = [
    /Loading applications/,
    /Failed to load/,
    /Registration approved/,
    /Registration rejected/,
    /Failed to approve registration/,
    /Failed to reject registration/,
  ];
  for (const p of patterns) {
    expect(REGISTRATIONS_NC, `should not contain "${p}"`).not.toMatch(p);
  }
});

test("RegistrationsManagement: API field names remain English", () => {
  expect(REGISTRATIONS).toContain("parentFullName");
  expect(REGISTRATIONS).toContain("childFullName");
  expect(REGISTRATIONS).toContain("rejectionReason");
  expect(REGISTRATIONS).toContain("preferredContact");
  expect(REGISTRATIONS).toContain("classPreference");
  expect(REGISTRATIONS).toContain("submittedAt");
  expect(REGISTRATIONS).toContain("reviewedAt");
});

test("RegistrationsManagement: CONTACT_META labels translated (Email/WhatsApp kept)", () => {
  expect(REGISTRATIONS).toContain("Telepon");
  // Email and WhatsApp are universally understood — kept in English.
  expect(REGISTRATIONS).toContain("Email");
  expect(REGISTRATIONS).toContain("WhatsApp");
});
