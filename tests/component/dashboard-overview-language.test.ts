/**
 * Phase B5.6d-1 — Language consistency tests for DashboardOverview.
 *
 * Verifies that DashboardOverview.tsx uses Bahasa Indonesia for all
 * user-facing strings. SOURCE-LEVEL checks.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/components/dashboard/DashboardOverview.tsx"),
  "utf-8",
);

test("DashboardOverview: key Indonesian strings present", () => {
  expect(SRC).toContain("Memuat dasbor");
  expect(SRC).toContain("Gagal memuat dasbor");
  expect(SRC).toContain("Kesalahan jaringan");
  expect(SRC).toContain("Coba lagi");
  expect(SRC).toContain("Akademi");
  expect(SRC).toContain("Pilih akademi");
  expect(SRC).toContain("Hari ini");
  expect(SRC).toContain("Bulan:");
  expect(SRC).toContain("Belum ada data");
  expect(SRC).toContain("Siswa");
  expect(SRC).toContain("Sesi latihan hari ini");
  expect(SRC).toContain("Terjadwal");
  expect(SRC).toContain("Hadir");
  expect(SRC).toContain("Terlambat");
  expect(SRC).toContain("Tidak hadir");
  expect(SRC).toContain("Izin");
  expect(SRC).toContain("Paket latihan dan tindak lanjut");
  expect(SRC).toContain("Keuangan");
  expect(SRC).toContain("Pembayaran diterima");
  expect(SRC).toContain("Pengeluaran");
  expect(SRC).toContain("Bulan ini");
  expect(SRC).toContain("Tidak ada");
  expect(SRC).toContain("Terdaftar saat ini");
  expect(SRC).toContain("Mulai hari ini");
  expect(SRC).toContain("Memiliki sesi tersisa");
  expect(SRC).toContain("Paket habis");
  expect(SRC).toContain("Menunggu makeup");
  expect(SRC).toContain("Aktif belum terjadwal");
  expect(SRC).toContain("Anda tidak memiliki akses Admin");
});

test("DashboardOverview: no English UI strings remain", () => {
  // Strip comments (JSX {/* ... */} and // ...) to avoid matching
  // developer-facing section banners.
  const noComments = SRC.replace(/\{\s*\/\*[\s\S]*?\*\s*\/\s*\}/g, "").replace(/^.*\/\/.*$/gm, "");
  expect(noComments).not.toContain("Loading dashboard");
  expect(noComments).not.toContain("Failed to load dashboard");
  expect(noComments).not.toContain("Network error");
  expect(noComments).not.toContain(">Retry<");
  expect(noComments).not.toContain(">Academy<");
  expect(noComments).not.toContain("Select academy");
  expect(noComments).not.toContain(">Today<");
  expect(noComments).not.toContain("Month:");
  expect(noComments).not.toContain("No data yet");
  expect(noComments).not.toContain(">Students<");
  expect(noComments).not.toContain("Today's sessions");
  expect(noComments).not.toContain(">Scheduled<");
  expect(noComments).not.toContain(">Present<");
  expect(noComments).not.toContain(">Late<");
  expect(noComments).not.toContain(">Absent<");
  expect(noComments).not.toContain(">Excused<");
  expect(noComments).not.toContain("Packages & follow-up");
  expect(noComments).not.toContain(">Finances<");
  expect(noComments).not.toContain("Payments received");
  expect(noComments).not.toContain(">Expenses<");
  expect(noComments).not.toContain("You do not have Admin access");
});

test("DashboardOverview: attendance status DISPLAY translated, enum VALUES preserved", () => {
  // The code still accesses data.sessions.attendanceToday.present/absent/
  // excused/late — these are API field names, NOT translated.
  expect(SRC).toContain("attendanceToday.present");
  expect(SRC).toContain("attendanceToday.absent");
  expect(SRC).toContain("attendanceToday.excused");
  expect(SRC).toContain("attendanceToday.late");
  // Display labels translated.
  expect(SRC).toContain('"Hadir"');
  expect(SRC).toContain('"Tidak hadir"');
  expect(SRC).toContain('"Izin"');
  expect(SRC).toContain('"Terlambat"');
});

test("DashboardOverview: API field names remain English", () => {
  expect(SRC).toContain("currentlyEnrolled");
  expect(SRC).toContain("startingToday");
  expect(SRC).toContain("scheduledToday");
  expect(SRC).toContain("withUsableSessions");
  expect(SRC).toContain("exhausted");
  expect(SRC).toContain("awaitingMakeup");
  expect(SRC).toContain("unassignedActive");
  expect(SRC).toContain("monthPaymentTotal");
  expect(SRC).toContain("monthExpenseTotal");
  expect(SRC).toContain("monthStart");
  expect(SRC).toContain("monthEnd");
  expect(SRC).toContain("academyId");
});

test("DashboardOverview: formatRupiah preserved (not translated)", () => {
  expect(SRC).toContain("formatRupiah");
});
