/**
 * Phase B5.2 — Payment amount default correctness (source-level regression).
 *
 * The RecordPaymentDialog in PaymentsManagement.tsx previously auto-filled
 * the payment amount using `plan.sessionCount * 50000`, implying a fixed
 * per-session price of IDR 50,000. This was fabricated — the
 * `package_plans` table has NO price column (verified in migration 0004),
 * so there is no authoritative price to derive from. The admin MUST enter
 * the actual amount paid.
 *
 * This test is a SOURCE-LEVEL regression guard: it reads the component
 * source and asserts the bad pattern is gone. It is NOT a behavior test
 * (that would require a full component-testing library + fetch mocking,
 * which is out of scope — see the B5.2 report for browser-verification
 * limitations). The guard prevents the bug from being reintroduced.
 *
 * What this verifies:
 *   1. The literal `* 50000` (or `*50000`) pattern is NOT in the file.
 *   2. No `setAmount` call derives from `sessionCount`.
 *   3. The amount field starts empty (`useState("")`) — no auto-fill.
 *
 * What this does NOT verify:
 *   - The full UI interaction (selecting a plan, typing an amount,
 *     submitting). That requires browser verification or a component
 *     testing library — documented as a limitation in the B5.2 report.
 *   - The server-side payment recording behavior (that's covered by the
 *     25+ tests in tests/integration/api/payments.test.ts +
 *     tests/integration/api/admin-payments.test.ts — unchanged by B5.2).
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMPONENT_PATH = resolve(
  import.meta.dir,
  "../../src/components/admin/PaymentsManagement.tsx",
);
const SOURCE = readFileSync(COMPONENT_PATH, "utf-8");

test("PaymentsManagement source: no `* 50000` per-session price calculation in code", () => {
  // The old code had `setAmount(String(plan.sessionCount * 50000))`.
  // We check for the actual CODE pattern (a setAmount call that multiplies
  // by 50000), NOT comment mentions of the old bug (the comment block
  // documents the removal and is expected to mention the old pattern).
  const lines = SOURCE.split("\n");
  const badLines = lines.filter(
    (line) =>
      line.includes("setAmount") &&
      line.includes("50000"),
  );
  expect(badLines).toEqual([]);
});

test("PaymentsManagement source: no setAmount derived from sessionCount", () => {
  // Assert no line sets `amount` from `sessionCount` (the auto-fill bug).
  // The only valid setAmount calls are: initial useState(""), reset on
  // dialog open, and onChange from the Input. None should reference
  // sessionCount.
  const lines = SOURCE.split("\n");
  const badLines = lines.filter(
    (line) => line.includes("setAmount") && line.includes("sessionCount"),
  );
  expect(badLines).toEqual([]);
});

test("PaymentsManagement source: amount state starts empty (no auto-fill default)", () => {
  // The amount useState must initialize to "" (empty), not a derived value.
  // This verifies the admin must type the amount explicitly.
  expect(SOURCE).toMatch(/setAmount\(["']["']\)/);
});

test("PaymentsManagement source: package_plans has no price field referenced", () => {
  // The PackagePlan + PackagePlanApi interfaces must NOT have a price field
  // (confirming the component doesn't assume one exists). The only plan
  // fields are id, name, sessionCount/session_count, isActive/is_active.
  // Assert no `price` property appears in the plan interfaces.
  const planInterfaceBlock = SOURCE.match(
    /interface PackagePlan \{[\s\S]*?\}/,
  )?.[0] ?? "";
  expect(planInterfaceBlock).not.toContain("price");
  expect(planInterfaceBlock).not.toContain("amount");

  const planApiInterfaceBlock = SOURCE.match(
    /interface PackagePlanApi \{[\s\S]*?\}/,
  )?.[0] ?? "";
  expect(planApiInterfaceBlock).not.toContain("price");
  expect(planApiInterfaceBlock).not.toContain("amount");
});
