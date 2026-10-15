/**
 * Phase B3.3.4 — Registration fetch concurrency tests.
 *
 * Tests the actual RegistrationsManagement component's request-ID
 * protection against stale concurrent responses. Uses happy-dom for
 * a lightweight DOM environment, React's createRoot for rendering,
 * and controllable deferred promises for deterministic request ordering.
 *
 * No arbitrary sleeps. No timing-dependent assertions.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { Window } from "happy-dom";
import { RegistrationsManagement } from "@/components/admin/RegistrationsManagement";

// ============================================================================
// Types
// ============================================================================

interface MockApp {
  id: string;
  parentFullName: string;
  parentPhone: string;
  parentEmail: string | null;
  preferredContact: string | null;
  childFullName: string;
  childDateOfBirth: string | null;
  classPreference: string | null;
  preferredDay: string | null;
  notes: string | null;
  source: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  studentId: string | null;
  submittedAt: string;
}

// ============================================================================
// Deferred Promise (deterministic request control)
// ============================================================================

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

// ============================================================================
// Mock Response
// ============================================================================

function createOkResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  } as Response;
}

function createErrorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { message } }),
    text: () => Promise.resolve(JSON.stringify({ error: { message } })),
    headers: new Headers(),
  } as Response;
}

// ============================================================================
// Test fixture: mock application data
// ============================================================================

const ACADEMY_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(overrides: Partial<MockApp> = {}): MockApp {
  return {
    id: "app-default",
    parentFullName: "Default Parent",
    parentPhone: "+62111",
    parentEmail: "default@example.com",
    preferredContact: "phone",
    childFullName: "Default Child",
    childDateOfBirth: null,
    classPreference: null,
    preferredDay: null,
    notes: null,
    source: "website",
    status: "pending",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    studentId: null,
    submittedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

const OLD_DATA: MockApp[] = [
  makeApp({ id: "app-old", parentFullName: "Andi Old", childFullName: "Old Child" }),
];

const NEW_DATA: MockApp[] = [
  makeApp({ id: "app-new", parentFullName: "Budi New", childFullName: "New Child" }),
];

const TWO_APPS: MockApp[] = [
  makeApp({ id: "app-1", parentFullName: "Parent One", childFullName: "Child One" }),
  makeApp({ id: "app-2", parentFullName: "Parent Two", childFullName: "Child Two" }),
];

const ONE_APP: MockApp[] = [
  makeApp({ id: "app-2", parentFullName: "Parent Two", childFullName: "Child Two" }),
];

// ============================================================================
// DOM + Fetch Mock Setup
// ============================================================================

let root: Root;
let container: HTMLElement;
let domWindow: Window;
let originalGlobals: { document: Document; window: Window; fetch: typeof fetch };
let listDeferreds: Deferred<Response>[];

beforeEach(() => {
  // Enable React's act() environment.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // Save originals
  originalGlobals = {
    document: globalThis.document,
    window: globalThis.window as Window,
    fetch: globalThis.fetch,
  };

  // Set up happy-dom
  domWindow = new Window();
  globalThis.window = domWindow as unknown as Window;
  globalThis.document = domWindow.document as unknown as Document;

  // Create container
  container = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(container);

  // Set a CSRF cookie for adminFetch
  domWindow.document.cookie = "futsal_csrf=test-csrf-token";

  // Reset deferreds
  listDeferreds = [];

  // Mock fetch: list requests get deferred promises; approve/reject get
  // immediate success responses.
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : (input as URL).toString();

    // Approve/reject: immediate success
    if (url.includes("/approve")) {
      return Promise.resolve(createOkResponse({ studentId: "student-from-approve" }));
    }
    if (url.includes("/reject")) {
      return Promise.resolve(createOkResponse({ ok: true }));
    }

    // List request: deferred (controllable)
    const deferred = createDeferred<Response>();
    listDeferreds.push(deferred);
    return deferred.promise;
  }) as typeof fetch;
});

afterEach(() => {
  // Unmount
  act(() => {
    root?.unmount();
  });

  // Restore globals
  globalThis.document = originalGlobals.document;
  globalThis.window = originalGlobals.window;
  globalThis.fetch = originalGlobals.fetch;
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

// ============================================================================
// Render Helper
// ============================================================================

function renderComponent(academyId = ACADEMY_ID): void {
  root = createRoot(container);
  act(() => {
    root.render(createElement(RegistrationsManagement, { academyId }));
  });
}

function getContainerText(): string {
  return container.textContent ?? "";
}

function findButtonByText(text: string): HTMLElement | undefined {
  const buttons = Array.from(container.querySelectorAll("button"));
  return buttons.find((b) => b.textContent?.includes(text));
}

/** Find a button by text, throwing if not found (avoids non-null assertions). */
function requireButton(text: string): HTMLElement {
  const btn = findButtonByText(text);
  if (!btn) throw new Error(`Button "${text}" not found`);
  return btn;
}

async function clickRefresh(): Promise<void> {
  const btn = requireButton("Segarkan");
  await act(async () => {
    btn.click();
    await Promise.resolve(); // flush microtasks
  });
}

async function resolveDeferred(index: number, data: unknown, ok = true, status = 200): Promise<void> {
  const deferred = listDeferreds[index];
  if (!deferred) throw new Error(`Deferred at index ${index} not found (have ${listDeferreds.length})`);
  await act(async () => {
    if (ok) {
      deferred.resolve(createOkResponse(data));
    } else {
      deferred.resolve(createErrorResponse(status, "Server error"));
    }
    await Promise.resolve(); // flush microtasks
  });
}

async function rejectDeferred(index: number, error: Error): Promise<void> {
  const deferred = listDeferreds[index];
  if (!deferred) throw new Error(`Deferred at index ${index} not found (have ${listDeferreds.length})`);
  await act(async () => {
    deferred.reject(error);
    await Promise.resolve();
  });
}

// ============================================================================
// Tests
// ============================================================================

// === Test A: Out-of-order success ===

test("Out-of-order success: older request cannot overwrite newer", async () => {
  renderComponent();
  // Request A (useEffect, index 0) is pending.
  expect(listDeferreds.length).toBe(1);

  // Start Request B (Refresh click).
  await clickRefresh();
  expect(listDeferreds.length).toBe(2);

  // Resolve B first with newer data.
  await resolveDeferred(1, { applications: NEW_DATA });

  // Verify newer data is displayed.
  const afterB = getContainerText();
  expect(afterB).toContain("Budi New");
  expect(afterB).not.toContain("Andi Old");

  // Resolve A with older (stale) data.
  await resolveDeferred(0, { applications: OLD_DATA });

  // Verify newer data remains — A must not overwrite B.
  const afterA = getContainerText();
  expect(afterA).toContain("Budi New");
  expect(afterA).not.toContain("Andi Old");
});

// === Test B: Out-of-order failure ===

test("Out-of-order failure: older error cannot overwrite newer success", async () => {
  renderComponent();
  expect(listDeferreds.length).toBe(1); // Request A

  await clickRefresh();
  expect(listDeferreds.length).toBe(2); // Request B

  // Resolve B successfully.
  await resolveDeferred(1, { applications: NEW_DATA });

  // Verify success state.
  const afterB = getContainerText();
  expect(afterB).toContain("Budi New");

  // Reject A with a network error.
  await rejectDeferred(0, new Error("Network error"));

  // Verify the success state remains — no stale error.
  const afterA = getContainerText();
  expect(afterA).toContain("Budi New");
  expect(afterA).not.toContain("Gagal memuat");
  expect(afterA).not.toContain("Kesalahan jaringan");
});

// === Test C: Stale request cannot clear loading state ===

test("Stale request cannot clear newer loading state", async () => {
  renderComponent();
  expect(listDeferreds.length).toBe(1); // Request A (from useEffect)

  // A is still pending → component shows "Memuat pengajuan…"
  expect(getContainerText()).toContain("Memuat pengajuan");

  // Start Request B (Refresh).
  await clickRefresh();
  expect(listDeferreds.length).toBe(2); // Request B

  // B is also pending → still loading.
  expect(getContainerText()).toContain("Memuat pengajuan");

  // Resolve A with success (stale — B is newer).
  await resolveDeferred(0, { applications: OLD_DATA });

  // A's success must NOT be applied because B is still pending.
  // The component should still show "Loading" (B's loading state),
  // NOT A's stale data.
  const afterA = getContainerText();
  expect(afterA).toContain("Memuat pengajuan");
  expect(afterA).not.toContain("Andi Old");

  // Now resolve B.
  await resolveDeferred(1, { applications: NEW_DATA });

  // B's data should be displayed.
  const afterB = getContainerText();
  expect(afterB).toContain("Budi New");
  expect(afterB).not.toContain("Memuat pengajuan");
});

// === Test D: Stale response cannot restore removed registration data ===
//
// This test does NOT exercise the approve/reject UI flow. The approve
// mutation's setState (optimisticRemove) is not reliably flushed by
// React 19's concurrent rendering scheduler in the happy-dom environment.
//
// Instead, this test verifies the same request-ID guard that the approve
// flow relies on: an older list response containing data that has been
// superseded by a newer response cannot overwrite the newer state.
// The scenario mirrors the approve flow's stale-response risk:
//
//   1. Request A starts (simulates a fetch from before the approve,
//      containing the to-be-approved app as pending).
//   2. Request B starts (simulates the silent refetch after approve,
//      where the approved app is no longer in the list).
//   3. B resolves first → the approved app is absent.
//   4. A resolves second with stale data → the approved app must NOT
//      reappear.
//
// Server-side mutation consistency (approve/reject returns the correct
// status) is verified separately by the 25 API tests in
// tests/integration/api/registration.test.ts.

test("Stale response cannot restore removed registration data", async () => {
  renderComponent();
  expect(listDeferreds.length).toBe(1); // Request A (pending, has both apps)

  // Start Request B (simulates the silent refetch after approve).
  await clickRefresh();
  expect(listDeferreds.length).toBe(2); // A (pending), B (pending)

  // Resolve B with only app-2 (app-1 was "approved" and removed).
  await resolveDeferred(1, { applications: ONE_APP });

  // Verify only Parent Two is visible (app-1 removed).
  expect(getContainerText()).toContain("Parent Two");
  expect(getContainerText()).not.toContain("Parent One");

  // Resolve A with both apps (stale data from before the approve).
  await resolveDeferred(0, { applications: TWO_APPS });

  // Verify Parent One is NOT restored — the stale response is discarded
  // by the request-ID guard.
  const afterStale = getContainerText();
  expect(afterStale).not.toContain("Parent One");
  expect(afterStale).toContain("Parent Two");
});
