"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CSRF_HEADER } from "@/lib/auth/csrf";

// === Types (match the actual API response) ===============================

interface SkipResult {
  operation: "skip";
  entitlementId: string;
  status: string;
  skipAllowanceUsed: number;
  skipAllowanceRemaining: number;
}

interface ApiError {
  error: { code: string; message: string; detail?: string };
}

// === Request state =======================================================

type ReqState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; message: string; detail?: string; retryable: boolean };

// === Component ===========================================================

interface SkipActionDialogProps {
  open: boolean;
  onClose: () => void;
  entitlementId: string;
  studentId: string;
  academyId: string;
  occurrenceDate: string | null;
  startAt: string | null;
  className: string | null;
  onSessionExpired: () => void;
  onSuccess: () => void;
}

export function SkipActionDialog({
  open,
  onClose,
  entitlementId,
  studentId,
  academyId,
  occurrenceDate,
  startAt,
  className,
  onSessionExpired,
  onSuccess,
}: SkipActionDialogProps) {
  // The idempotency key is generated once per mount (lazy initializer).
  // The parent uses a `key` prop that changes each time the dialog opens
  // for a new action, forcing a remount → fresh key. This avoids
  // setState-in-effect (cascading-render) and ensures each new action
  // gets a new key while retries preserve the same key.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [reqState, setReqState] = useState<ReqState>({ status: "idle" });

  // Refs for use in async callbacks (stable across re-renders).
  const idempotencyKeyRef = useRef(idempotencyKey);
  useEffect(() => { idempotencyKeyRef.current = idempotencyKey; }, [idempotencyKey]);
  const reasonRef = useRef(reason);
  useEffect(() => { reasonRef.current = reason; }, [reason]);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  const doSubmit = useCallback(async () => {
    const key = idempotencyKeyRef.current;
    const body = { reason: reasonRef.current || undefined };
    setReqState({ status: "submitting" });
    try {
      // Read the CSRF cookie (NOT HttpOnly — JS can read it).
      const csrfMatch = document.cookie
        .split("; ")
        .find((c) => c.startsWith("futsal_csrf="));
      const csrfToken = csrfMatch?.split("=")[1] ?? "";

      const res = await fetch(
        `/api/parent/children/${studentId}/entitlements/${entitlementId}/skip?academyId=${academyId}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            [CSRF_HEADER]: csrfToken,
            "idempotency-key": key,
          },
          body: JSON.stringify(body),
        },
      );

      if (!openRef.current) return;

      // 401 — session expired.
      if (res.status === 401) {
        onSessionExpired();
        return;
      }

      // 200 — success (or replay of a successful request with the same key).
      if (res.status === 200) {
        setReqState({ status: "success" });
        // Brief delay so the user sees the success state before the dialog closes.
        setTimeout(() => {
          if (openRef.current) {
            onSuccess();
            onClose();
          }
        }, 600);
        return;
      }

      // Error — parse the error body.
      const errData = (await res.json().catch(() => null)) as ApiError | null;
      if (!openRef.current) return;
      const detail = errData?.error?.detail;
      const message = errData?.error?.message ?? `Error ${res.status}`;

      // Map known detail subcodes to specific UX.
      if (detail === "skip_allowance_exceeded") {
        setReqState({ status: "error", message: "Skip allowance already used for this package.", detail, retryable: false });
      } else if (detail === "invalid_status") {
        setReqState({ status: "error", message: "This session is no longer active. Please refresh the schedule.", detail, retryable: false });
      } else if (detail === "no_assignment") {
        setReqState({ status: "error", message: "This session has no current assignment. Please refresh the schedule.", detail, retryable: false });
      } else if (detail === "idempotency_key_reuse") {
        setReqState({ status: "error", message: "Request conflict — the key was used for a different request. Please try again.", detail, retryable: false });
      } else if (detail === "retryable") {
        // Server-side retries exhausted — the user can retry with the SAME key.
        setReqState({ status: "error", message: "Server busy. Please try again.", detail, retryable: true });
      } else if (res.status === 403) {
        setReqState({ status: "error", message: "You don't have access to this action.", retryable: false });
      } else if (res.status === 404) {
        setReqState({ status: "error", message: "Entitlement not found.", retryable: false });
      } else if (res.status === 422) {
        setReqState({ status: "error", message: "Invalid request. Please try again.", retryable: false });
      } else {
        // Unknown 409 or other error — safe generic message.
        setReqState({ status: "error", message, detail, retryable: false });
      }
    } catch {
      // Network error — preserve the key + body for retry.
      if (!openRef.current) return;
      setReqState({ status: "error", message: "Kesalahan jaringan — tidak dapat terhubung ke server. Coba lagi?", retryable: true });
    }
  }, [studentId, entitlementId, academyId, onSessionExpired, onSuccess, onClose]);

  // Handle close — if submitting, don't close (prevent losing an in-flight request).
  const handleClose = useCallback(() => {
    if (reqState.status === "submitting") return;
    onClose();
  }, [reqState.status, onClose]);

  const submitting = reqState.status === "submitting";
  const showSuccess = reqState.status === "success";
  const showError = reqState.status === "error";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Lewati Sesi</DialogTitle>
          <DialogDescription>
            {occurrenceDate && startAt
              ? `Sesi: ${className ?? "—"}`
              : "Konfirmasi lewati sesi ini."}
          </DialogDescription>
        </DialogHeader>

        {showSuccess ? (
          <div className="py-4 text-center">
            <p className="text-sm font-medium text-emerald-600">Sesi berhasil dilewati.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="skip-reason">Alasan (opsional)</Label>
              <Textarea
                id="skip-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Contoh: sakit, urusan keluarga…"
                maxLength={500}
                rows={3}
                disabled={submitting}
              />
            </div>

            {showError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
                <div className="flex-1">
                  <p className="text-sm text-destructive">{(reqState as { message: string }).message}</p>
                  {showError && (reqState as { retryable: boolean }).retryable && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 gap-2"
                      onClick={doSubmit}
                      disabled={submitting}
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {!showSuccess && (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={handleClose} disabled={submitting}>
              Batal
            </Button>
            <Button onClick={doSubmit} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memproses…
                </>
              ) : (
                "Lewati sesi"
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
