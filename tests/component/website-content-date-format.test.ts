/**
 * Phase B5.6f-2 — Website CMS Indonesian date formatting test.
 *
 * Verifies that the formatTimestamp helper in WebsiteContentManagement
 * uses Intl.DateTimeFormat("id-ID") instead of hardcoded English month
 * abbreviations. Tests both the source-level pattern and the actual
 * Intl.DateTimeFormat behavior.
 *
 * The helper is module-internal (not exported). Source-level assertions
 * verify the implementation; a behavior test of Intl.DateTimeFormat
 * verifies the locale produces Indonesian month abbreviations.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/components/admin/WebsiteContentManagement.tsx"),
  "utf-8",
);

test("WebsiteContentManagement: formatTimestamp uses id-ID locale", () => {
  expect(SRC).toContain('Intl.DateTimeFormat("id-ID"');
  expect(SRC).toContain("month: \"short\"");
  expect(SRC).toContain("hour: \"2-digit\"");
  expect(SRC).toContain("minute: \"2-digit\"");
  expect(SRC).toContain("timeZone: \"UTC\"");
});

test("WebsiteContentManagement: no hardcoded English month array", () => {
  expect(SRC).not.toContain('"Jan"');
  expect(SRC).not.toContain('"Feb"');
  expect(SRC).not.toContain('"Oct"');
  expect(SRC).not.toContain('"Dec"');
});

test("WebsiteContentManagement: formatTimestamp preserves null + NaN fallback", () => {
  expect(SRC).toContain('if (!iso) return "—"');
  expect(SRC).toContain("Number.isNaN");
  expect(SRC).toContain("return iso");
});

test("WebsiteContentManagement: formatTimestamp call sites still use the helper", () => {
  // Draft update timestamp (LandingPageEditor).
  expect(SRC).toContain("formatTimestamp(page?.draftUpdatedAt");
  // Publication history timestamp.
  expect(SRC).toContain("formatTimestamp(pub.publishedAt)");
});

test("Intl.DateTimeFormat id-ID with time produces Indonesian months + time", () => {
  const fmt = new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  // Test months that differ between English and Indonesian.
  const oct = new Date("2024-10-14T15:30:00.000Z");
  const aug = new Date("2024-08-14T15:30:00.000Z");
  const may = new Date("2024-05-14T15:30:00.000Z");
  const dec = new Date("2024-12-14T15:30:00.000Z");

  const octStr = fmt.format(oct);
  const augStr = fmt.format(aug);
  const mayStr = fmt.format(may);
  const decStr = fmt.format(dec);

  // Indonesian abbreviations differ from English for these months.
  expect(octStr).toContain("Okt");
  expect(augStr).toContain("Agu");
  expect(mayStr).toContain("Mei");
  expect(decStr).toContain("Des");

  // None should contain the English abbreviations.
  expect(octStr).not.toContain("Oct");
  expect(augStr).not.toContain("Aug");
  expect(mayStr).not.toContain("May");
  expect(decStr).not.toContain("Dec");

  // All should contain the time component (hour:minute).
  // Indonesian locale uses "." as time separator.
  expect(octStr).toMatch(/\d{2}[.:]\d{2}/);
});
