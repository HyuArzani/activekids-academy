/**
 * Phase B5.6b-4 — Language consistency tests for Admin
 * Reports + Website Content sections.
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
// ReportsManagement.tsx
// ============================================================================

const REPORTS = readSource("ReportsManagement.tsx");
const REPORTS_NC = stripComments(REPORTS);

test("ReportsManagement: key Indonesian strings present", () => {
  expect(REPORTS).toContain("Laporan");
  expect(REPORTS).toContain("Siswa");
  expect(REPORTS).toContain("Kehadiran");
  expect(REPORTS).toContain("Keuangan");
  expect(REPORTS).toContain("Segarkan");
  expect(REPORTS).toContain("Coba lagi");
  expect(REPORTS).toContain("Memuat");
  expect(REPORTS).toContain("Gagal");
  expect(REPORTS).toContain("Kesalahan jaringan");
  expect(REPORTS).toContain("Dari");
  expect(REPORTS).toContain("Sampai");
  // CSV button text — uses Download icon + "CSV" (universal term)
  expect(REPORTS).toContain("> CSV");
});

test("ReportsManagement: report loading states Indonesian", () => {
  expect(REPORTS).toContain("Memuat daftar siswa");
  expect(REPORTS).toContain("Memuat laporan keuangan");
  // The attendance report uses inline loading (Refresh button spinner),
  // not a LoadingCard — no dedicated loading text for it.
});

test("ReportsManagement: no English UI strings remain as display text", () => {
  const patterns = [
    /Loading student roster/,
    /Loading financial report/,
    /Loading attendance report/,
    /Failed to load/,
    /Download CSV/,
  ];
  for (const p of patterns) {
    expect(REPORTS_NC, `should not contain "${p}"`).not.toMatch(p);
  }
});

test("ReportsManagement: API field names remain English", () => {
  expect(REPORTS).toContain("academyId");
  expect(REPORTS).toContain("studentId");
  expect(REPORTS).toContain("fromDate");
  expect(REPORTS).toContain("toDate");
  expect(REPORTS).toContain("paymentId");
  expect(REPORTS).toContain("expenseId");
});

// ============================================================================
// WebsiteContentManagement.tsx
// ============================================================================

const WEBSITE = readSource("WebsiteContentManagement.tsx");
const WEBSITE_NC = stripComments(WEBSITE);

test("WebsiteContentManagement: key Indonesian strings present", () => {
  expect(WEBSITE).toContain("Draf");
  // The editor may not have a dedicated Preview button — check for
  // the key editing/publishing terms instead.
  expect(WEBSITE).toContain("Terbitkan");
  expect(WEBSITE).toContain("Simpan");
  expect(WEBSITE).toContain("Batal");
  expect(WEBSITE).toContain("Galeri");
  expect(WEBSITE).toContain("Video");
  expect(WEBSITE).toContain("Riwayat publikasi");
  expect(WEBSITE).toContain("Memuat");
  expect(WEBSITE).toContain("Gagal");
  expect(WEBSITE).toContain("Kesalahan jaringan");
  expect(WEBSITE).toContain("Segarkan");
  // Toasts
  expect(WEBSITE).toContain("Draf tersimpan");
  expect(WEBSITE).toContain("Gagal menyimpan draf");
  expect(WEBSITE).toContain("Halaman landing diterbitkan");
  expect(WEBSITE).toContain("Item galeri ditambahkan");
  expect(WEBSITE).toContain("Video ditambahkan");
  expect(WEBSITE).toContain("Versi halaman landing dipulihkan");
});

test("WebsiteContentManagement: aria-labels translated to Indonesian", () => {
  expect(WEBSITE).toContain("Hapus program");
  expect(WEBSITE).toContain("Hapus jadwal");
  expect(WEBSITE).toContain("Hapus pelatih");
});

test("WebsiteContentManagement: no English UI strings remain as display text", () => {
  const patterns = [
    /Loading landing page/,
    /Failed to load/,
    /Save Draft/,
    /Publish Now/,
    /Draft saved/,
    /Gallery item added/,
    /Video added/,
    /Publication history/,
  ];
  for (const p of patterns) {
    expect(WEBSITE_NC, `should not contain "${p}"`).not.toMatch(p);
  }
});

test("WebsiteContentManagement: API field names remain English", () => {
  expect(WEBSITE).toContain("academyId");
  expect(WEBSITE).toContain("draftContent");
  expect(WEBSITE).toContain("versionNumber");
  expect(WEBSITE).toContain("publishNote");
  expect(WEBSITE).toContain("isFeatured");
  expect(WEBSITE).toContain("isPublished");
  expect(WEBSITE).toContain("mediaKey");
  expect(WEBSITE).toContain("videoId");
});
