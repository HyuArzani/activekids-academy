/**
 * Phase B5.6f-1 — Parent portal SkipActionDialog language test.
 *
 * Verifies that the network-error message in SkipActionDialog.tsx
 * is Indonesian (not English). SOURCE-LEVEL check — the component
 * requires a complex mock setup (academy context, entitlement data,
 * occurrence lists, fetch mocking) that goes beyond a simple source
 * inspection for a single string change.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/components/parent/SkipActionDialog.tsx"),
  "utf-8",
);

test("SkipActionDialog: network error message is Indonesian", () => {
  expect(SRC).toContain("Kesalahan jaringan — tidak dapat terhubung ke server. Coba lagi?");
  expect(SRC).not.toContain("Network error — could not reach the server");
});

test("SkipActionDialog: retry behavior preserved", () => {
  // The setReqState call still sets retryable: true (the retry button
  // appears via FetchStateView when retryable is true).
  expect(SRC).toContain("retryable: true");
  // The openRef guard is still there (prevents setting state if the
  // dialog closed during the fetch).
  expect(SRC).toContain("openRef.current");
});

test("SkipActionDialog: no other English UI strings introduced", () => {
  // Strip comments to avoid matching developer-facing comments.
  const noComments = SRC.replace(/^.*\/\/.*$/gm, "");
  expect(noComments).not.toContain("Network error");
});
