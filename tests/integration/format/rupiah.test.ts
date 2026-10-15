/**
 * Unit tests for the safe rupiah formatter.
 * Uses the existing `bun test` convention (no React testing setup needed).
 */

import { test, expect } from "bun:test";
import { formatRupiah } from "@/lib/format/rupiah";

test("formats whole-number string with Indonesian grouping", () => {
  expect(formatRupiah("400000")).toBe("Rp 400.000");
});

test("formats two-decimal string (drops zero sen)", () => {
  expect(formatRupiah("400000.00")).toBe("Rp 400.000");
});

test("formats with non-zero sen", () => {
  expect(formatRupiah("400000.50")).toBe("Rp 400.000,50");
});

test("formats zero as 'Rp 0'", () => {
  expect(formatRupiah("0")).toBe("Rp 0");
  expect(formatRupiah("0.00")).toBe("Rp 0");
});

test("formats negative amount", () => {
  expect(formatRupiah("-50000.00")).toBe("-Rp 50.000");
});

test("formats large amount without float precision loss", () => {
  // 999,999,999.99 — would overflow Number.MAX_SAFE_INTEGER if parsed as float × 100
  expect(formatRupiah("999999999.99")).toBe("Rp 999.999.999,99");
});

test("formats amount with non-zero sen in negative", () => {
  expect(formatRupiah("-123.45")).toBe("-Rp 123,45");
});

test("handles single-digit decimal (pads to 2)", () => {
  expect(formatRupiah("100.5")).toBe("Rp 100,50");
});

test("handles empty decimal part", () => {
  expect(formatRupiah("100.")).toBe("Rp 100");
});
