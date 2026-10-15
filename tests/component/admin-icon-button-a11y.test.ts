/**
 * Phase B5.5 — Admin icon-only button accessibility tests.
 *
 * Verifies that icon-only buttons across the admin interface have
 * meaningful aria-labels. Uses source-level inspection (reading the
 * component source + asserting the aria-label attribute is present)
 * because rendering the full admin components requires mocking many
 * API endpoints, CSRF cookies, and academy contexts — the source-level
 * check is the most reliable + deterministic approach for this
 * specific a11y property.
 *
 * What this verifies:
 *   1. Every icon-only Button (containing ONLY an icon, no text sibling)
 *      has an aria-label attribute.
 *   2. The aria-label is NOT an icon implementation name (e.g., not
 *      "Trash2" or "Pencil" — these are component names, not user-facing).
 *   3. Destructive actions (remove/delete) have distinguishable labels.
 *
 * These are SOURCE-LEVEL checks (not rendered accessibility-tree checks).
 * A rendered a11y-tree check would require agent-browser + a stable dev
 * server + admin authentication — documented as a limitation in the
 * B5.5 report.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ADMIN_DIR = resolve(import.meta.dir, "../../src/components/admin");

function readSource(relPath: string): string {
  return readFileSync(resolve(ADMIN_DIR, relPath), "utf-8");
}

// ============================================================================
// Test 1: No icon-only buttons exist WITHOUT an aria-label
// ============================================================================

test("icon-only buttons: all have aria-label (no unnamed icon-only buttons)", () => {
  const files = [
    "AdminShell.tsx",
    "PackagesManagement.tsx",
    "PaymentsManagement.tsx",
    "AttendanceManagement.tsx",
    "RegistrationsManagement.tsx",
    "WebsiteContentManagement.tsx",
    "ReportsManagement.tsx",
  ];

  for (const file of files) {
    const src = readSource(file);
    const lines = src.split("\n");

    // Find all <Button ...> elements that contain ONLY an icon (no text
    // sibling). The pattern: a <Button...> line followed by an <Icon...
    // aria-hidden /> and then </Button> with no text between them.
    // We check: a Button opening tag, then a line with only an icon
    // (aria-hidden), then </Button>.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match <Button ...> opening tags.
      if (!line.includes("<Button") || line.includes("</Button>")) continue;

      // Look at the next few lines for the closing </Button>.
      const block = lines.slice(i, i + 5).join("\n");
      const buttonBlock = block.match(/<Button[^>]*>([\s\S]*?)<\/Button>/);
      if (!buttonBlock) continue;

      const content = buttonBlock[1] ?? "";
      // Check if the content is ONLY an icon (aria-hidden) with no text.
      // An icon-only button has an <Icon ... aria-hidden /> and no visible
      // text. We strip tags + whitespace + check if the remaining text
      // is empty.
      const textOnly = content
        .replace(/<[^>]+\/?>/g, "") // remove all tags
        .replace(/aria-hidden/g, "")
        .trim();
      const hasIcon = /<[^>]+aria-hidden/.test(content);
      if (!hasIcon) continue; // not an icon-containing button
      if (textOnly !== "") continue; // has visible text — not icon-only

      // This IS an icon-only button. Check it has an aria-label.
      const buttonTag = block.match(/<Button[^>]*>/)?.[0] ?? "";
      const hasAriaLabel = /aria-label=/.test(buttonTag);
      expect(hasAriaLabel, `${file}:${i + 1} — icon-only button missing aria-label: ${buttonTag.trim()}`).toBe(true);
    }
  }
});

// ============================================================================
// Test 2: Destructive icon-only buttons have distinguishable labels
// ============================================================================

test("destructive icon-only buttons: have distinguishable aria-labels (not generic)", () => {
  const src = readSource("AdminShell.tsx");

  // The RemoveGuardianButton must have aria-label containing "wali".
  const removeGuardianMatch = src.match(
    /aria-label="Hapus wali"/,
  );
  expect(removeGuardianMatch, 'RemoveGuardianButton should have aria-label="Hapus wali"').not.toBeNull();

  // The DeleteSlotButton must have aria-label containing "jadwal latihan".
  const deleteSlotMatch = src.match(
    /aria-label="Hapus jadwal latihan"/,
  );
  expect(deleteSlotMatch, 'DeleteSlotButton should have aria-label="Hapus jadwal latihan"').not.toBeNull();

  // The class edit button must have aria-label containing "Ubah kelas".
  const editClassMatch = src.match(/aria-label=\{`Ubah kelas/);
  expect(editClassMatch, 'class edit button should have aria-label starting with "Ubah kelas"').not.toBeNull();
});

// ============================================================================
// Test 3: Package plan edit + WebsiteContent remove buttons have labels
// ============================================================================

test("PackagesManagement: package plan edit button has aria-label with plan name", () => {
  const src = readSource("PackagesManagement.tsx");
  // The edit button should have aria-label={`Ubah ${plan.name}`}.
  expect(src).toContain('aria-label={`Ubah ${plan.name}`}');
});

test("WebsiteContentManagement: program/schedule/coach remove buttons have aria-labels", () => {
  const src = readSource("WebsiteContentManagement.tsx");
  // Program remove: aria-label={`Hapus program ${p.name || i + 1}`}
  expect(src).toContain("aria-label={`Hapus program");
  // Schedule remove: aria-label={`Hapus jadwal ${i + 1}`}
  expect(src).toContain("aria-label={`Hapus jadwal");
  // Coach remove: aria-label={`Hapus pelatih ${c.name || i + 1}`}
  expect(src).toContain("aria-label={`Hapus pelatih");
});

// ============================================================================
// Test 4: aria-labels are NOT icon implementation names
// ============================================================================

test("icon-only buttons: aria-labels are not icon implementation names", () => {
  const files = ["AdminShell.tsx", "PackagesManagement.tsx", "WebsiteContentManagement.tsx"];
  const iconNames = ["Trash2", "Pencil", "X", "Plus", "Check", "Loader2", "RefreshCw", "Copy"];

  for (const file of files) {
    const src = readSource(file);
    // Find all aria-label="..." values (static strings).
    const labels = [...src.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    for (const label of labels) {
      for (const iconName of iconNames) {
        expect(
          label.toLowerCase(),
          `${file}: aria-label "${label}" should not be the icon name "${iconName}"`,
        ).not.toBe(iconName.toLowerCase());
      }
    }
    // Also check template-literal aria-labels (aria-label={`...`}).
    const templateLabels = [...src.matchAll(/aria-label=\{`([^`]+)`\}/g)].map((m) => m[1]);
    for (const label of templateLabels) {
      for (const iconName of iconNames) {
        // Template labels can contain expressions, so we check the static part.
        const staticPart = label.replace(/\$\{[^}]+\}/g, "").trim();
        expect(
          staticPart.toLowerCase(),
          `${file}: aria-label template "${label}" static part should not be just the icon name "${iconName}"`,
        ).not.toBe(iconName.toLowerCase());
      }
    }
  }
});
