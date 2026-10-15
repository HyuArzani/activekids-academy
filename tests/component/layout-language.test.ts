/**
 * Phase B5.6d-3 — HTML language + metadata localization tests.
 *
 * Verifies that the root layout declares `lang="id"` (Indonesian)
 * and that the metadata description is in Bahasa Indonesia, not
 * exposing internal development notes. SOURCE-LEVEL checks.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/app/layout.tsx"),
  "utf-8",
);

test("layout: html lang attribute is Indonesian", () => {
  expect(SRC).toContain('lang="id"');
  expect(SRC).not.toContain('lang="en"');
});

test("layout: metadata description is Indonesian", () => {
  expect(SRC).toContain("Sistem manajemen akademi futsal");
  expect(SRC).toContain("pendaftaran siswa");
  expect(SRC).toContain("kehadiran");
  expect(SRC).toContain("pembayaran");
  expect(SRC).toContain("jadwal latihan");
});

test("layout: metadata description does not expose development notes", () => {
  expect(SRC).not.toContain("Phase 1 foundation");
  expect(SRC).not.toContain("database adapter");
  expect(SRC).not.toContain("raw SQL migrations");
  expect(SRC).not.toContain("seed data");
  expect(SRC).not.toContain("custom auth");
});

test("layout: OpenGraph + Twitter descriptions are Indonesian", () => {
  expect(SRC).toContain('description: "Sistem manajemen akademi futsal"');
  // Should NOT contain the old English description in OG/Twitter.
  expect(SRC).not.toContain('"Phase 1 foundation"');
});

test("layout: preserved metadata properties unchanged", () => {
  // Title is a proper name — intentionally English.
  expect(SRC).toContain('title: "Futsal Academy Management System"');
  // Keywords preserved.
  expect(SRC).toContain("futsal");
  expect(SRC).toContain("academy");
  // Authors preserved.
  expect(SRC).toContain("Futsal Academy");
  // Icons preserved.
  expect(SRC).toContain("z-cdn.chatglm.cn");
  // OpenGraph title + siteName + type preserved.
  expect(SRC).toContain("siteName: \"Futsal Academy\"");
  expect(SRC).toContain("type: \"website\"");
  // Twitter card preserved.
  expect(SRC).toContain("summary_large_image");
  // Fonts + Toaster + suppressHydrationWarning preserved.
  expect(SRC).toContain("Geist");
  expect(SRC).toContain("Geist_Mono");
  expect(SRC).toContain("Toaster");
  expect(SRC).toContain("suppressHydrationWarning");
});
