/**
 * Phase B5.4 — PackagesManagement stale-response protection behavior tests.
 *
 * Verifies the requestIdRef guard added in B5.4 prevents stale responses
 * from overwriting newer state. Uses the same deferred-promise pattern as
 * the registration-concurrency tests (controlled request completion order +
 * observable DOM assertions).
 *
 * The race tested: the initial useEffect fetch (on mount) racing a manual
 * "Refresh" click (calling fetchList()). Both fetches use the SAME
 * academyId, so the academyIdRef guard does NOT catch this race — only
 * the requestIdRef guard does.
 *
 * What this verifies:
 *   1. A newer fetch's response is applied even if an older fetch is
 *      still pending.
 *   2. When the older (stale) fetch resolves AFTER the newer one, it is
 *      discarded — the newer state is NOT overwritten.
 *
 * This is a BEHAVIOR test (not source-code matching) — it controls
 * request completion order + asserts the rendered DOM reflects the
 * correct (newer) data.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { PackagesManagement } from "@/components/admin/PackagesManagement";

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

// ============================================================================
// Mock data
// ============================================================================

const ACADEMY_ID = "00000000-0000-0000-0000-000000000001";

/** Old data (the initial fetch's response — STALE). */
const OLD_PLANS = [
  { id: "plan-old", name: "Old Plan (stale)", session_count: 4, is_active: true },
];

/** New data (the Refresh fetch's response — NEWER). */
const NEW_PLANS = [
  { id: "plan-new", name: "New Plan (refreshed)", session_count: 8, is_active: true },
];

// ============================================================================
// DOM + Fetch Mock Setup
// ============================================================================

let root: Root;
let container: HTMLElement;
let domWindow: Window;
let originalGlobals: { document: Document | undefined; window: Window | undefined; fetch: typeof fetch };
let listDeferreds: Deferred<Response>[];

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  domWindow = new Window();
  globalThis.window = domWindow as unknown as Window;
  globalThis.document = domWindow.document as unknown as Document;
  container = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(container);
  domWindow.document.cookie = "futsal_csrf=test-csrf-token";
  listDeferreds = [];

  // Mock fetch: all list requests get deferred promises (controllable
  // completion order). Each call pushes a new deferred.
  globalThis.fetch = (() => {
    const deferred = createDeferred<Response>();
    listDeferreds.push(deferred);
    return deferred.promise;
  }) as typeof fetch;
});

afterEach(() => {
  act(() => { root?.unmount(); });
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
    root.render(createElement(PackagesManagement, { academyId }));
  });
}

/** Find a button by text content. */
function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(domWindow.document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").includes(text),
  );
}

/** Get the full rendered text content (for assertions). */
function getRenderedText(): string {
  return container.textContent ?? "";
}

// ============================================================================
// Test 1: Newer fetch resolves first → applied. Stale fetch resolves
//         later → discarded (does NOT overwrite newer data).
// ============================================================================

test("stale-response guard: stale fetch does NOT overwrite newer data (same academy)", async () => {
  renderComponent(ACADEMY_ID);
  // The initial useEffect fetch started → listDeferreds[0] is pending.
  expect(listDeferreds.length).toBe(1);

  // Click "Segarkan" → a second fetch starts → listDeferreds[1] is pending.
  // Both fetches use the SAME academyId (the academyIdRef guard does NOT
  // catch this race — only the requestIdRef guard does).
  const refreshBtn = findButton("Segarkan");
  expect(refreshBtn).toBeDefined();
  act(() => { refreshBtn!.click(); });
  expect(listDeferreds.length).toBe(2);

  // Resolve the NEWER fetch (listDeferreds[1]) FIRST.
  await act(async () => {
    listDeferreds[1].resolve(createOkResponse({ plans: NEW_PLANS }));
  });
  // Flush the json() promise + setState.
  await act(async () => { await new Promise<void>((r) => setTimeout(r, 10)); });

  // The newer data should be visible now.
  expect(getRenderedText()).toContain("New Plan (refreshed)");

  // Now resolve the STALE fetch (listDeferreds[0]) — this is the older
  // initial fetch that was superseded by the Refresh.
  await act(async () => {
    listDeferreds[0].resolve(createOkResponse({ plans: OLD_PLANS }));
  });
  // Flush the json() promise.
  await act(async () => { await new Promise<void>((r) => setTimeout(r, 10)); });

  // The stale response must NOT have overwritten the newer data.
  // If the requestIdRef guard is working, the state still shows "New Plan".
  // If the guard is missing (pre-B5.4), the stale "Old Plan" would overwrite.
  expect(getRenderedText()).toContain("New Plan (refreshed)");
  expect(getRenderedText()).not.toContain("Old Plan (stale)");
});

// ============================================================================
// Test 2: Sequential fetches — initial resolves + is applied, then a
//         Refresh resolves + overwrites (the newer one wins). Verifies
//         the guard does NOT break normal sequential fetching.
// ============================================================================

test("stale-response guard: sequential fetches work correctly (older applied, then newer overwrites)", async () => {
  renderComponent(ACADEMY_ID);
  expect(listDeferreds.length).toBe(1);

  // Resolve the initial fetch FIRST (no other fetch in flight → not stale).
  await act(async () => {
    listDeferreds[0].resolve(createOkResponse({ plans: OLD_PLANS }));
  });
  await act(async () => { await new Promise<void>((r) => setTimeout(r, 10)); });
  // The initial data is applied.
  expect(getRenderedText()).toContain("Old Plan (stale)");

  // Now click Segarkan → a second fetch starts.
  const refreshBtn = findButton("Segarkan");
  act(() => { refreshBtn!.click(); });
  expect(listDeferreds.length).toBe(2);

  // Resolve the second (newer) fetch.
  await act(async () => {
    listDeferreds[1].resolve(createOkResponse({ plans: NEW_PLANS }));
  });
  await act(async () => { await new Promise<void>((r) => setTimeout(r, 10)); });

  // The newer data overwrites — the newer fetch wins.
  expect(getRenderedText()).toContain("New Plan (refreshed)");
  expect(getRenderedText()).not.toContain("Old Plan (stale)");
});
