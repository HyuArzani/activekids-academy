/**
 * Phase B5.6d-4 — Dialog close button localization test.
 *
 * Verifies that the shared Dialog component's screen-reader-only
 * close label is "Tutup" (Indonesian), not "Close" (English).
 * SOURCE-LEVEL check — the test environment doesn't support full
 * accessibility-tree rendering of the Radix Dialog primitive.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/components/ui/dialog.tsx"),
  "utf-8",
);

test("dialog: close button sr-only label is Indonesian", () => {
  expect(SRC).toContain('className="sr-only">Tutup</span>');
  expect(SRC).not.toContain('className="sr-only">Close</span>');
});

test("dialog: close button structure preserved", () => {
  // The DialogPrimitive.Close + XIcon + sr-only span structure is unchanged.
  expect(SRC).toContain("DialogPrimitive.Close");
  expect(SRC).toContain("XIcon");
  expect(SRC).toContain("sr-only");
  expect(SRC).toContain("showCloseButton");
});
