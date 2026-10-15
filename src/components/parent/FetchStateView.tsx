"use client";

import type { FetchState } from "@/lib/parent-ui/useContextFetch";

/** Shared loading/error/empty rendering helper. Returns null if handled. */
export function FetchStateView({
  state,
  expectedContextId,
  onRetry,
  emptyMessage,
  children,
}: {
  state: FetchState<unknown>;
  expectedContextId: string | null;
  onRetry: () => void;
  emptyMessage?: string;
  children: React.ReactNode;
}) {
  const isStale = !expectedContextId || state.contextId !== expectedContextId;
  if (state.status === "loading" || isStale) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Memuat…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="p-4">
        <div className="flex items-start gap-3">
          <ErrorIcon />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">{state.message}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
            >
              Coba lagi
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (state.status === "success") {
    const data = state.data as { length?: number } | null | undefined;
    if (emptyMessage && (!data || (typeof data.length === "number" ? data.length === 0 : false))) {
      return (
        <div className="p-8 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      );
    }
    return <>{children}</>;
  }
  return null;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
