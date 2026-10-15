/**
 * Phase B5.6 — Language consistency tests for public-facing pages.
 *
 * Verifies that the public-facing pages (PublicRegistrationForm,
 * PublicApplicationStatus, AuthShell) use Bahasa Indonesia for
 * user-facing strings, NOT English. These are SOURCE-LEVEL checks
 * (not rendered accessibility-tree checks) — they read the component
 * source + assert the Indonesian strings are present + English strings
 * are gone.
 *
 * What this verifies:
 *   1. Key Indonesian strings are present in each public file.
 *   2. No common English UI strings remain (e.g., "Sign in", "Back",
 *      "Loading", "Submit", "Cancel").
 *   3. Status enum DISPLAY values are translated (pending → Menunggu,
 *      approved → Disetujui, rejected → Ditolak) while the underlying
 *      API values are unchanged.
 *
 * Strings that REMAIN in English (by design — NOT user-facing):
 *   - API field names (parentFullName, childFullName, etc.)
 *   - Database enum VALUES ("pending", "approved", "rejected" used
 *     in code comparisons)
 *   - Technical identifiers (scripts/provision-admin.ts, UUIDs)
 *   - "Email" and "WhatsApp" (universally understood in Indonesia)
 *   - The footer security summary (developer-facing)
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC_DIR = resolve(import.meta.dir, "../../src/components");

function readSource(relPath: string): string {
  return readFileSync(resolve(SRC_DIR, relPath), "utf-8");
}

// ============================================================================
// Test 1: PublicRegistrationForm — Indonesian strings present
// ============================================================================

test("PublicRegistrationForm: key Indonesian strings are present", () => {
  const src = readSource("public/PublicRegistrationForm.tsx");
  // Form labels.
  expect(src).toContain("Nama Lengkap");
  expect(src).toContain("Nomor Telepon");
  expect(src).toContain("Email (opsional)");
  expect(src).toContain("Tanggal Lahir");
  expect(src).toContain("Metode Kontak yang Disukai");
  expect(src).toContain("Kelas yang Diinginkan");
  expect(src).toContain("Hari Latihan yang Diinginkan");
  expect(src).toContain("Catatan Tambahan");
  // Step labels.
  expect(src).toContain("Orang Tua/Wali");
  expect(src).toContain("Preferensi");
  // Buttons.
  expect(src).toContain("Kembali");
  expect(src).toContain("Lanjut");
  expect(src).toContain("Kirim Pendaftaran");
  expect(src).toContain("Batal");
  // Validation messages.
  expect(src).toContain("Nama orang tua wajib diisi");
  expect(src).toContain("Nomor telepon wajib diisi");
  expect(src).toContain("Nama anak wajib diisi");
  expect(src).toContain("Format email tidak valid");
  // Day names (Indonesian).
  expect(src).toContain("Minggu");
  expect(src).toContain("Senin");
  expect(src).toContain("Sabtu");
});

test("PublicRegistrationForm: no common English UI strings remain", () => {
  const src = readSource("public/PublicRegistrationForm.tsx");
  // These English strings should NOT be present (translated to Indonesian).
  expect(src).not.toContain("Full Name");
  expect(src).not.toContain("Phone Number");
  expect(src).not.toContain("Date of Birth");
  expect(src).not.toContain("Preferred Contact");
  expect(src).not.toContain("Preferred Class");
  expect(src).not.toContain("Preferred Training Day");
  expect(src).not.toContain("Additional Notes");
  expect(src).not.toContain("Parent name is required");
  expect(src).not.toContain("Phone number is required");
  expect(src).not.toContain("Child name is required");
  expect(src).not.toContain("Submit Registration");
  // Day names as DISPLAY text are translated, but the `value="Sunday"`
  // attributes (API enum values) correctly remain. Check that no SelectItem
  // DISPLAYS the English day name (between > and <).
  expect(src).not.toMatch(/>Sunday</);
  expect(src).not.toMatch(/>Monday</);
  expect(src).not.toMatch(/>Saturday</);
});

// ============================================================================
// Test 2: PublicApplicationStatus — Indonesian strings present
// ============================================================================

test("PublicApplicationStatus: key indonesian strings are present", () => {
  const src = readSource("public/PublicApplicationStatus.tsx");
  expect(src).toContain("Cek Status Pendaftaran");
  expect(src).toContain("Nomor Referensi Pendaftaran");
  expect(src).toContain("Kembali ke Akademi");
  expect(src).toContain("Pendaftaran tidak ditemukan");
  // Status display values (translated, while the code still uses
  // "pending"/"approved"/"rejected" for comparisons).
  expect(src).toContain("Menunggu");
  expect(src).toContain("Disetujui");
  expect(src).toContain("Ditolak");
  // Detail labels.
  expect(src).toContain("Dikirim");
  expect(src).toContain("Ditinjau");
  expect(src).toContain("Nomor Referensi");
  expect(src).toContain("Alasan");
});

test("PublicApplicationStatus: status enum VALUES are unchanged (API contract)", () => {
  const src = readSource("public/PublicApplicationStatus.tsx");
  // The code still compares against the English enum values (API contract).
  // Only the DISPLAY is translated.
  expect(src).toContain('"pending"');
  expect(src).toContain('"approved"');
  expect(src).toContain('"rejected"');
});

test("PublicApplicationStatus: no common English UI strings remain", () => {
  const src = readSource("public/PublicApplicationStatus.tsx");
  expect(src).not.toContain("Check Application Status");
  expect(src).not.toContain("Application Status Lookup");
  expect(src).not.toContain("Application Reference ID");
  expect(src).not.toContain("Application not found");
  expect(src).not.toContain("Submitted");
  expect(src).not.toContain("Reviewed");
  expect(src).not.toContain("Reference ID");
  // "Reason" as a display label is gone (translated to "Alasan"),
  // but "rejectionReason" (the interface field name) correctly remains.
  expect(src).not.toMatch(/>Reason</);
  // The raw `state.data.status` (which would display "pending"/"approved"/
  // "rejected") is replaced by the translated conditional.
  expect(src).not.toMatch(/\{state\.data\.status\}<\/p>/);
});

// ============================================================================
// Test 3: AuthShell — Indonesian strings present
// ============================================================================

test("AuthShell: login form uses Indonesian", () => {
  const src = readSource("auth/AuthShell.tsx");
  expect(src).toContain("Masuk");
  expect(src).toContain("Kata Sandi");
  expect(src).toContain("Masukkan kredensial Anda untuk melanjutkan");
  expect(src).toContain("Kesalahan jaringan");
  expect(src).toContain("Gagal masuk");
  expect(src).toContain("Memproses…");
  expect(src).toContain("Kembali ke halaman akademi");
});

test("AuthShell: change-password form uses Indonesian", () => {
  const src = readSource("auth/AuthShell.tsx");
  expect(src).toContain("Perubahan kata sandi diperlukan");
  expect(src).toContain("Kata sandi saat ini");
  expect(src).toContain("Kata sandi baru");
  expect(src).toContain("Ubah Kata Sandi");
  expect(src).toContain("Gagal mengubah kata sandi");
});

test("AuthShell: authenticated state uses Indonesian", () => {
  const src = readSource("auth/AuthShell.tsx");
  expect(src).toContain("Tervalidasi");
  expect(src).toContain("Masuk sebagai");
  expect(src).toContain("Keluar");
  expect(src).toContain("Tidak ada keanggotaan aktif");
  expect(src).toContain("Portal Wali");
  expect(src).toContain("Dasbor Admin");
  expect(src).toContain("Memuat sesi");
});

test("AuthShell: no common English login/auth strings remain", () => {
  const src = readSource("auth/AuthShell.tsx");
  expect(src).not.toContain("Sign in");
  expect(src).not.toContain("Signing in");
  expect(src).not.toContain("Password change required");
  expect(src).not.toContain("Change password");
  expect(src).not.toContain("Sign out");
  expect(src).not.toContain("Authenticated");
  expect(src).not.toContain("Signed in as");
  expect(src).not.toContain("No active memberships");
  expect(src).not.toContain("Admin Dashboard");
  expect(src).not.toContain("Parent Portal");
  expect(src).not.toContain("Loading session");
});

// ============================================================================
// Test 4: Preserved English (technical identifiers)
// ============================================================================

test("public pages: technical identifiers remain in English", () => {
  const regSrc = readSource("public/PublicRegistrationForm.tsx");
  // API field names (used in the fetch body) — NOT translated.
  expect(regSrc).toContain("parentFullName");
  expect(regSrc).toContain("childFullName");
  expect(regSrc).toContain("parentPhone");
  // "Email" is universally understood in Indonesia — kept as-is.
  expect(regSrc).toContain("Email");
  // "WhatsApp" — kept as-is.
  expect(regSrc).toContain("WhatsApp");

  const authSrc = readSource("auth/AuthShell.tsx");
  // Script reference — a technical identifier, kept as-is.
  expect(authSrc).toContain("scripts/provision-admin.ts");
  // Footer security summary — developer-facing, kept as-is.
  expect(authSrc).toContain("Argon2id");
});
