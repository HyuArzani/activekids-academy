/**
 * Phase B5.6b-2 — Language consistency tests for Admin Packages/Payments.
 *
 * Verifies that the Packages + Payments & Expenses sections use Bahasa
 * Indonesia for user-facing strings, NOT English. SOURCE-LEVEL checks.
 *
 * What this verifies:
 *   1. Key Indonesian strings are present in both files.
 *   2. No common English UI strings remain as display text.
 *   3. API field names + enum VALUES remain in English.
 *   4. Toast messages are translated.
 *   5. The B5.2 amount placeholder is translated (no auto-fill behavior
 *      reintroduced).
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
// PackagesManagement.tsx
// ============================================================================

const PACKAGES = readSource("PackagesManagement.tsx");
const PACKAGES_NO_COMMENTS = stripComments(PACKAGES);

test("PackagesManagement: key Indonesian strings present", () => {
  expect(PACKAGES).toContain("Memuat paket latihan");
  expect(PACKAGES).toContain("Belum ada paket latihan");
  expect(PACKAGES).toContain("Gagal memuat paket latihan");
  expect(PACKAGES).toContain("Segarkan");
  expect(PACKAGES).toContain("Tambah Paket");
  expect(PACKAGES).toContain("Tambah Paket Latihan");
  expect(PACKAGES).toContain("Ubah Paket Latihan");
  expect(PACKAGES).toContain("Nama Paket");
  expect(PACKAGES).toContain("Jumlah Sesi");
  expect(PACKAGES).toContain("sesi latihan per pembelian");
  expect(PACKAGES).toContain("Aktif");
  expect(PACKAGES).toContain("Tidak Aktif");
  // Toasts
  expect(PACKAGES).toContain("Paket latihan ditambahkan");
  expect(PACKAGES).toContain("Paket latihan diperbarui");
  expect(PACKAGES).toContain("Gagal menambah paket latihan");
  expect(PACKAGES).toContain("Gagal memperbarui paket latihan");
  // aria-label (B5.5 translated to Indonesian)
  expect(PACKAGES).toContain("Ubah ${plan.name}");
});

test("PackagesManagement: no English UI strings remain as display text", () => {
  const englishStrings = [
    /Loading package/,
    /No package plans/,
    /Failed to load package/,
    /Add Plan/,
    /Create Package Plan/,
    /Edit Package Plan/,
    /Package plan created/,
    /Package plan updated/,
    /training sessions per purchase/,
  ];
  for (const pattern of englishStrings) {
    expect(PACKAGES_NO_COMMENTS, `should not contain "${pattern}"`).not.toMatch(pattern);
  }
});

test("PackagesManagement: API field names remain English", () => {
  expect(PACKAGES).toContain("sessionCount");
  expect(PACKAGES).toContain("is_active");
  expect(PACKAGES).toContain("isActive");
  expect(PACKAGES).toContain("package-plans");
});

test("PackagesManagement: isActive boolean + is_active field preserved", () => {
  // PackagesManagement uses a boolean `isActive` (not a string enum).
  // The API field `is_active` is preserved in English.
  expect(PACKAGES).toContain("isActive");
  expect(PACKAGES).toContain("is_active");
  // Display text translated
  expect(PACKAGES).toContain("Aktif");
  expect(PACKAGES).toContain("Tidak Aktif");
});

// ============================================================================
// PaymentsManagement.tsx
// ============================================================================

const PAYMENTS = readSource("PaymentsManagement.tsx");
const PAYMENTS_NO_COMMENTS = stripComments(PAYMENTS);

test("PaymentsManagement: key Indonesian strings present", () => {
  expect(PAYMENTS).toContain("Pembayaran & Pengeluaran");
  expect(PAYMENTS).toContain("Catat Pembayaran");
  expect(PAYMENTS).toContain("Catat Pengeluaran");
  expect(PAYMENTS).toContain("Segarkan");
  expect(PAYMENTS).toContain("Dari");
  expect(PAYMENTS).toContain("Sampai");
  expect(PAYMENTS).toContain("Pemasukan");
  expect(PAYMENTS).toContain("Pengeluaran");
  expect(PAYMENTS).toContain("Bersih");
  expect(PAYMENTS).toContain("Metode");
  expect(PAYMENTS).toContain("Tunai");
  expect(PAYMENTS).toContain("Transfer Bank");
  expect(PAYMENTS).toContain("Jumlah");
  expect(PAYMENTS).toContain("Nama Pembayar");
  expect(PAYMENTS).toContain("No. Referensi");
  expect(PAYMENTS).toContain("Kategori");
  expect(PAYMENTS).toContain("Tanggal Pengeluaran");
  // Toasts
  expect(PAYMENTS).toContain("Pembayaran dicatat");
  expect(PAYMENTS).toContain("Pengeluaran dicatat");
  expect(PAYMENTS).toContain("Gagal mencatat pembayaran");
  expect(PAYMENTS).toContain("Gagal mencatat pengeluaran");
  // Empty states
  expect(PAYMENTS).toContain("Tidak ada pembayaran");
  expect(PAYMENTS).toContain("Tidak ada pengeluaran");
});

test("PaymentsManagement: B5.2 amount placeholder is translated (no auto-fill)", () => {
  // The B5.2 fix removed the sessionCount*50000 auto-fill. The placeholder
  // should be Indonesian + NOT reintroduce the auto-fill.
  // Strip comments first (the old pattern is referenced in a dev comment
  // explaining the removal — the actual useEffect is gone).
  expect(PAYMENTS).toContain("Masukkan jumlah dibayar");
  expect(PAYMENTS_NO_COMMENTS).not.toMatch(/sessionCount\s*\*\s*50000/);
  expect(PAYMENTS_NO_COMMENTS).not.toContain("Enter the amount paid");
});

test("PaymentsManagement: no English UI strings remain as display text", () => {
  const englishStrings = [
    /Payments & Expenses/,
    /Record Payment/,
    /Record Expense/,
    /Total income/,
    /Total expense/,
    /Payment method/,
    /Loading payments/,
    /No payments found/,
    /Payment recorded/,
    /Expense recorded/,
    /Amount must be greater than zero/,
  ];
  for (const pattern of englishStrings) {
    expect(PAYMENTS_NO_COMMENTS, `should not contain "${pattern}"`).not.toMatch(pattern);
  }
});

test("PaymentsManagement: API field names remain English", () => {
  expect(PAYMENTS).toContain("studentId");
  expect(PAYMENTS).toContain("packagePlanId");
  expect(PAYMENTS).toContain("amount");
  expect(PAYMENTS).toContain("paymentMethod");
  expect(PAYMENTS).toContain("paymentDate");
  expect(PAYMENTS).toContain("payerName");
  expect(PAYMENTS).toContain("referenceNumber");
  expect(PAYMENTS).toContain("incurredOn");
  expect(PAYMENTS).toContain("idempotencyKey");
});

test("PaymentsManagement: payment method enum VALUES remain English", () => {
  expect(PAYMENTS).toContain('"cash"');
  expect(PAYMENTS).toContain('"bank_transfer"');
  // Display text translated
  expect(PAYMENTS).toContain("Tunai");
  expect(PAYMENTS).toContain("Transfer Bank");
});

test("PaymentsManagement: formatRupiah preserved (not translated)", () => {
  // The formatRupiah function formats IDR amounts — it should still use
  // "Rp" prefix + Indonesian locale formatting, NOT be translated to
  // a different format.
  expect(PAYMENTS).toContain("formatRupiah");
  expect(PAYMENTS).toContain('"id-ID"');
});
