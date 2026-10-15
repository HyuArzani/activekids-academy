/**
 * Phase B5.6d-5 — Indonesian date formatting consistency tests.
 *
 * Verifies that the date formatting helpers in PaymentsManagement
 * and ReportsManagement use Indonesian locale (id-ID) instead of
 * hardcoded English month abbreviations (Jan/Feb/Mar...).
 *
 * Tests the actual formatting function behavior (not source-code
 * pattern matching) by calling the helper with known inputs and
 * asserting the output contains Indonesian month names.
 *
 * NOTE: The formatting helpers are module-internal (not exported).
 * These tests use source-level inspection to verify the helpers
 * use Intl.DateTimeFormat("id-ID") and don't contain the old
 * English month array. A behavior test would require importing
 * the internal function — not possible without refactoring.
 */

import { test, expect} from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(relPath: string): string {
  return readFileSync(resolve(import.meta.dir, "../../src/components/admin", relPath), "utf-8");
}

// Also verify the actual Intl.DateTimeFormat output for Indonesian
// dates — this tests the locale behavior the helpers rely on.

test("Intl.DateTimeFormat id-ID produces Indonesian month abbreviations", () => {
  const fmt = new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  // Test several months that differ between English and Indonesian.
  const oct = new Date("2024-10-14T00:00:00.000Z");
  const aug = new Date("2024-08-14T00:00:00.000Z");
  const may = new Date("2024-05-14T00:00:00.000Z");
  const dec = new Date("2024-12-14T00:00:00.000Z");

  const octStr = fmt.format(oct);
  const augStr = fmt.format(aug);
  const mayStr = fmt.format(may);
  const decStr = fmt.format(dec);

  // Indonesian abbreviations differ from English for these months.
  expect(octStr).toContain("Okt"); // English: "Oct"
  expect(augStr).toContain("Agu"); // English: "Aug"
  expect(mayStr).toContain("Mei"); // English: "May"
  expect(decStr).toContain("Des"); // English: "Dec"

  // None should contain the English abbreviations.
  expect(octStr).not.toContain("Oct");
  expect(augStr).not.toContain("Aug");
  expect(mayStr).not.toContain("May");
  expect(decStr).not.toContain("Dec");
});

test("PaymentsManagement: formatDateShort uses id-ID locale, no English months", () => {
  const src = readSource("PaymentsManagement.tsx");
  // The helper uses Intl.DateTimeFormat with id-ID.
  expect(src).toContain('Intl.DateTimeFormat("id-ID"');
  expect(src).toContain("month: \"short\"");
  expect(src).toContain("timeZone: \"UTC\"");
  // The old hardcoded English month array is gone.
  expect(src).not.toContain('"Jan"');
  expect(src).not.toContain('"Feb"');
  expect(src).not.toContain('"Oct"');
  expect(src).not.toContain('"Dec"');
});

test("ReportsManagement: formatDate uses id-ID locale, no English months", () => {
  const src = readSource("ReportsManagement.tsx");
  expect(src).toContain('Intl.DateTimeFormat("id-ID"');
  expect(src).toContain("month: \"short\"");
  expect(src).toContain("timeZone: \"UTC\"");
  // The old hardcoded English month array is gone.
  expect(src).not.toContain('"Jan"');
  expect(src).not.toContain('"Feb"');
  expect(src).not.toContain('"Oct"');
  expect(src).not.toContain('"Dec"');
});

test("PaymentsManagement: formatDateShort preserves UTC + fallback behavior", () => {
  const src = readSource("PaymentsManagement.tsx");
  // Still parses the date as UTC (T00:00:00.000Z).
  expect(src).toContain("T00:00:00.000Z");
  // Still returns the raw input on NaN (fallback).
  expect(src).toContain("Number.isNaN");
  // Still returns the raw input as fallback.
  expect(src).toContain("return ymd");
});

test("ReportsManagement: formatDate preserves null fallback + UTC + NaN behavior", () => {
  const src = readSource("ReportsManagement.tsx");
  // Still handles null input.
  expect(src).toContain('if (!ymd) return "—"');
  // Still parses as UTC.
  expect(src).toContain("T00:00:00.000Z");
  // Still returns raw input on NaN.
  expect(src).toContain("Number.isNaN");
  expect(src).toContain("return ymd");
});
