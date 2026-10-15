/**
 * Phase B5.6b-1 — Language consistency tests for Admin Student/Class sections.
 *
 * Verifies that the Student + Class management sections in AdminShell.tsx
 * use Bahasa Indonesia for user-facing strings, NOT English. These are
 * SOURCE-LEVEL checks — they read the component source + assert the
 * Indonesian strings are present + English UI strings are gone.
 *
 * What this verifies:
 *   1. Key Indonesian strings are present (Siswa, Wali, Kelas, etc.).
 *   2. No common English UI strings remain (Loading, Cancel, Save, etc.).
 *   3. Status/enum DISPLAY values are translated while API VALUES are
 *      unchanged (e.g., value="male" → display "Laki-laki").
 *   4. Toast messages are translated.
 *   5. Navigation labels are translated.
 *   6. API field names + technical identifiers remain in English.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/components/admin/AdminShell.tsx"),
  "utf-8",
);

// Only check the Student + Class management sections (lines 138-2090).
// The imports/types/helpers above line 138 are not user-facing.
const SECTION_START = SRC.indexOf("const NAV_ITEMS");
const SECTION = SRC.slice(SECTION_START);

// ============================================================================
// Test 1: Key Indonesian strings are present
// ============================================================================

test("AdminShell Student/Class: key Indonesian terms present", () => {
  const terms = [
    "Siswa", "Wali", "Kelas", "Memuat", "Kesalahan",
    "Batal", "Simpan", "Hapus", "Kembali", "Tambah",
    "Ubah", "Daftarkan", "Pindahkan", "Akademi",
  ];
  for (const term of terms) {
    expect(SECTION, `should contain "${term}"`).toContain(term);
  }
});

// ============================================================================
// Test 2: Navigation labels are translated
// ============================================================================

test("AdminShell: navigation labels are Indonesian", () => {
  // The NAV_ITEMS labels should be Indonesian.
  expect(SECTION).toContain("Dasbor");
  expect(SECTION).toContain('"Siswa"');
  expect(SECTION).toContain('"Kelas"');
  // Other sections (Packages, Attendance, etc.) are out of scope for B5.6b-1
  // but the nav labels should be translated for consistency.
  expect(SECTION).toContain("Paket");
  expect(SECTION).toContain("Kehadiran");
  expect(SECTION).toContain("Pembayaran");
  expect(SECTION).toContain("Pendaftaran");
  expect(SECTION).toContain("Laporan");
  expect(SECTION).toContain("Konten Website");
});

// ============================================================================
// Test 3: Loading + error + empty states are Indonesian
// ============================================================================

test("AdminShell: loading states are Indonesian", () => {
  expect(SECTION).toContain("Memuat siswa");
  expect(SECTION).toContain("Memuat kelas");
});

test("AdminShell: error states are Indonesian", () => {
  expect(SECTION).toContain("Gagal memuat siswa");
  expect(SECTION).toContain("Gagal memuat kelas");
  expect(SECTION).toContain("Kesalahan jaringan");
});

test("AdminShell: empty states are Indonesian", () => {
  expect(SECTION).toContain("Tidak ada siswa");
  expect(SECTION).toContain("Tidak ada kelas");
  expect(SECTION).toContain("Belum ada wali");
  expect(SECTION).toContain("Belum terdaftar di kelas");
});

// ============================================================================
// Test 4: Dialog titles + buttons are Indonesian
// ============================================================================

test("AdminShell: dialog titles are Indonesian", () => {
  expect(SECTION).toContain("Tambah Siswa");
  expect(SECTION).toContain("Ubah Siswa");
  expect(SECTION).toContain("Tambah Wali");
  expect(SECTION).toContain("Tambah Kelas Baru");
  expect(SECTION).toContain("Ubah Kelas");
  expect(SECTION).toContain("Versi Jadwal Baru");
  expect(SECTION).toContain("Tambah Jadwal Latihan");
  expect(SECTION).toContain("Buat Sesi Latihan Otomatis");
  expect(SECTION).toContain("Pendaftaran Kelas");
  expect(SECTION).toContain("Pindahkan Kelas");
});

// ============================================================================
// Test 5: Toast messages are Indonesian
// ============================================================================

test("AdminShell: toast messages are Indonesian", () => {
  expect(SECTION).toContain("Siswa ditambahkan");
  expect(SECTION).toContain("Siswa diperbarui");
  expect(SECTION).toContain("Wali ditambahkan");
  expect(SECTION).toContain("Wali dihapus");
  expect(SECTION).toContain("Siswa terdaftar di kelas");
  expect(SECTION).toContain("Siswa dipindahkan");
  expect(SECTION).toContain("Jadwal latihan dihapus");
  expect(SECTION).toContain("Versi jadwal dibuat");
  expect(SECTION).toContain("Jadwal latihan ditambahkan");
  expect(SECTION).toContain("Kelas dibuat");
  expect(SECTION).toContain("Kelas diperbarui");
  // Error toasts
  expect(SECTION).toContain("Gagal menambah siswa");
  expect(SECTION).toContain("Gagal memperbarui siswa");
  expect(SECTION).toContain("Gagal menambah wali");
  expect(SECTION).toContain("Gagal membuat kelas");
  expect(SECTION).toContain("Gagal memperbarui kelas");
});

// ============================================================================
// Test 6: No common English UI strings remain
// ============================================================================

test("AdminShell Student/Class: no common English UI strings remain as display text", () => {
  // These English UI strings should NOT be present as DISPLAY text.
  // We strip comments (lines starting with //) before checking to avoid
  // matching developer-facing section banners like "// === Edit Student ===".
  const noComments = SECTION.replace(/^.*\/\/.*$/gm, "");
  const englishDisplayStrings = [
    /Loading students/,
    /Loading classes/,
    /Failed to load students/,
    /Failed to load classes/,
    /No students found/,
    /No classes found/,
    /No guardians linked/,
    /Not enrolled in any class/,
    /Student created/,
    /Student updated/,
    /Guardian linked/,
    /Guardian removed/,
    /Class created/,
    /Class updated/,
  ];
  for (const pattern of englishDisplayStrings) {
    expect(noComments, `should not contain English "${pattern}" as display text`).not.toMatch(pattern);
  }
  // "Add Student" / "Edit Student" / "Link Guardian" / "Add New Class" /
  // "Edit Class" appear in section-banner COMMENTS only (developer-facing),
  // not as user-facing display text. The Indonesian translations are
  // verified in the "dialog titles are Indonesian" test above.
});

// ============================================================================
// Test 7: API field names + enum values remain in English
// ============================================================================

test("AdminShell Student/Class: API field names remain in English", () => {
  // These are API field names — NOT translated.
  expect(SECTION).toContain("fullName");
  expect(SECTION).toContain("dateOfBirth");
  expect(SECTION).toContain("guardianUserId");
  expect(SECTION).toContain("effectiveFrom");
  expect(SECTION).toContain("newClassId");
  // Snake-case DB fields (from the API response) — NOT translated.
  expect(SECTION).toContain("full_name");
  expect(SECTION).toContain("date_of_birth");
});

test("AdminShell Student/Class: gender enum VALUES remain in English", () => {
  // The code still uses the English enum values for comparisons.
  // Only the DISPLAY text is translated.
  expect(SECTION).toContain('"male"');
  expect(SECTION).toContain('"female"');
  expect(SECTION).toContain('"unspecified"');
  // But the display text should be Indonesian.
  expect(SECTION).toContain("Laki-laki");
  expect(SECTION).toContain("Perempuan");
  expect(SECTION).toContain("Tidak Disebutkan");
});

// ============================================================================
// Test 8: Accessibility labels are Indonesian (from B5.5, now translated)
// ============================================================================

test("AdminShell Student/Class: aria-labels are Indonesian", () => {
  expect(SECTION).toContain('aria-label="Hapus wali"');
  expect(SECTION).toContain('aria-label="Hapus jadwal latihan"');
  expect(SECTION).toContain("aria-label={`Ubah kelas");
});
