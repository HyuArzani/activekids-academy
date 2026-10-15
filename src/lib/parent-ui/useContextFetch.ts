/**
 * Shared data-fetching hook for Parent Portal child-specific tabs.
 * Implements the same LoadState + stale-prevention pattern as the admin
 * DashboardOverview/StudentList, extended with 401 (session-expired) detection.
 *
 * Uses refs for urlBuilder and onSessionExpired so the effect doesn't
 * re-run when the caller's memoized callbacks change identity.
 */

import { useState, useEffect, useRef } from "react";

export interface FetchState<T> {
  status: "loading" | "success" | "error";
  contextId: string;
  data?: T;
  message?: string;
}

export interface UseFetchOptions {
  /** Called when a fetch returns 401 (session expired). */
  onSessionExpired?: () => void;
}

/**
 * Fetch JSON from a URL that depends on a contextId (e.g., studentId).
 * Prevents stale responses from overwriting data for a new contextId.
 * Returns { state, retry }.
 */
export function useContextFetch<T>(
  urlBuilder: (contextId: string) => string,
  contextId: string | null,
  opts: UseFetchOptions = {},
): { state: FetchState<T>; retry: () => void } {
  const [state, setState] = useState<FetchState<T>>({
    status: "loading",
    contextId: contextId ?? "",
  });

  // Use refs for the urlBuilder and onSessionExpired so the effect only
  // re-runs when contextId changes (not when the caller's callbacks change
  // identity due to re-renders). Refs are updated in effects (not during
  // render) to comply with the React Compiler's rules.
  const urlBuilderRef = useRef(urlBuilder);
  useEffect(() => { urlBuilderRef.current = urlBuilder; }, [urlBuilder]);
  const onExpiredRef = useRef(opts.onSessionExpired);
  useEffect(() => { onExpiredRef.current = opts.onSessionExpired; }, [opts.onSessionExpired]);

  const contextIdRef = useRef(contextId);
  useEffect(() => { contextIdRef.current = contextId; }, [contextId]);

  useEffect(() => {
    if (!contextId) return;
    let cancelled = false;
    const id = contextId;
    void (async () => {
      try {
        const res = await fetch(urlBuilderRef.current(id), { credentials: "same-origin" });
        if (cancelled) return;
        if (res.status === 401) {
          if (!cancelled) onExpiredRef.current?.();
          return;
        }
        const data = (await res.json()) as { error?: { message?: string } } & T;
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: "error", contextId: id, message: (data as { error?: { message?: string } }).error?.message ?? `Error ${res.status}` });
          return;
        }
        setState({ status: "success", contextId: id, data });
      } catch {
        if (cancelled) return;
        setState({ status: "error", contextId: id, message: "Kesalahan jaringan — tidak dapat terhubung ke server" });
      }
    })();
    return () => { cancelled = true; };
  }, [contextId]);

  const retry = () => {
    const id = contextIdRef.current;
    if (!id) return;
    setState({ status: "loading", contextId: id });
    void (async () => {
      try {
        const res = await fetch(urlBuilderRef.current(id), { credentials: "same-origin" });
        if (res.status === 401) {
          onExpiredRef.current?.();
          return;
        }
        const data = (await res.json()) as { error?: { message?: string } } & T;
        if (id !== contextIdRef.current) return;
        if (!res.ok) {
          setState({ status: "error", contextId: id, message: (data as { error?: { message?: string } }).error?.message ?? `Error ${res.status}` });
          return;
        }
        setState({ status: "success", contextId: id, data });
      } catch {
        if (id !== contextIdRef.current) return;
        setState({ status: "error", contextId: id, message: "Kesalahan jaringan — tidak dapat terhubung ke server" });
      }
    })();
  };

  return { state, retry };
}
