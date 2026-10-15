"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AlertCircle, Loader2, RefreshCw, ArrowRight } from "lucide-react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { formatDateTime } from "@/lib/parent-ui/format";

// === Types (match the actual API responses) ===============================

interface EligibleOccurrence {
  id: string;
  occurrenceDate: string;
  startAt: string;
  endAt: string;
  className: string;
  capacity: number;
  activeCount: number;
  availableSeats: number;
}

interface MoveResult {
  operation: "move";
  entitlementId: string;
  originalOccurrenceId: string | null;
  assignedOccurrenceId: string;
  status: string;
  moveCountUsed: number;
  moveCountRemaining: number;
  noOp: boolean;
}

interface ApiError {
  error: { code: string; message: string; detail?: string };
}

type ReqState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; message: string; detail?: string; retryable: boolean };

type DestState =
  | { status: "loading" }
  | { status: "success"; occurrences: EligibleOccurrence[] }
  | { status: "error"; message: string };

// === Component ===========================================================

interface MoveActionDialogProps {
  open: boolean;
  onClose: () => void;
  entitlementId: string;
  studentId: string;
  academyId: string;
  /** The current occurrence ID (from the schedule entry's occurrenceId). */
  expectedCurrentOccurrenceId: string;
  occurrenceDate: string | null;
  startAt: string | null;
  className: string | null;
  onSessionExpired: () => void;
  onSuccess: () => void;
}

export function MoveActionDialog({
  open,
  onClose,
  entitlementId,
  studentId,
  academyId,
  expectedCurrentOccurrenceId,
  occurrenceDate,
  startAt,
  className,
  onSessionExpired,
  onSuccess,
}: MoveActionDialogProps) {
  // Idempotency key: one per mount (fresh per new action via key prop remount).
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [reqState, setReqState] = useState<ReqState>({ status: "idle" });
  // Lazy initializer: "loading" on each fresh mount (key prop forces remount
  // for each new action). Avoids setState-in-effect (cascading-render).
  const [destState, setDestState] = useState<DestState>(() => ({ status: "loading" }));
  const [selectedDestId, setSelectedDestId] = useState<string | null>(null);

  // Refs for async callbacks.
  const idempotencyKeyRef = useRef(idempotencyKey);
  useEffect(() => { idempotencyKeyRef.current = idempotencyKey; }, [idempotencyKey]);
  const reasonRef = useRef(reason);
  useEffect(() => { reasonRef.current = reason; }, [reason]);
  const selectedDestRef = useRef(selectedDestId);
  useEffect(() => { selectedDestRef.current = selectedDestId; }, [selectedDestId]);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);
  const expectedRef = useRef(expectedCurrentOccurrenceId);
  useEffect(() => { expectedRef.current = expectedCurrentOccurrenceId; }, [expectedCurrentOccurrenceId]);

  // Fetch eligible occurrences when the dialog opens.
  const eligibleUrl = useMemo(
    () => `/api/parent/children/${studentId}/entitlements/${entitlementId}/eligible-occurrences?academyId=${academyId}`,
    [studentId, entitlementId, academyId],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // State is already "loading" via the lazy initializer (fresh on each
    // remount from key prop). No need to setState here — avoids cascading-render.
    void (async () => {
      try {
        const res = await fetch(eligibleUrl, { credentials: "same-origin" });
        if (cancelled) return;
        if (res.status === 401) {
          if (!cancelled) onSessionExpired();
          return;
        }
        const data = (await res.json()) as { occurrences?: EligibleOccurrence[]; error?: { message?: string } };
        if (cancelled) return;
        if (!res.ok || !data.occurrences) {
          setDestState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
          return;
        }
        setDestState({ status: "success", occurrences: data.occurrences });
      } catch {
        if (cancelled) return;
        setDestState({ status: "error", message: "Kesalahan jaringan — tidak dapat memuat daftar sesi." });
      }
    })();
    return () => { cancelled = true; };
  }, [open, eligibleUrl, onSessionExpired]);

  // Retry eligible-occurrences fetch.
  const refetchDest = useCallback(async () => {
    setDestState({ status: "loading" });
    try {
      const res = await fetch(eligibleUrl, { credentials: "same-origin" });
      if (res.status === 401) { onSessionExpired(); return; }
      const data = (await res.json()) as { occurrences?: EligibleOccurrence[]; error?: { message?: string } };
      if (!res.ok || !data.occurrences) {
        setDestState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      setDestState({ status: "success", occurrences: data.occurrences });
    } catch {
      setDestState({ status: "error", message: "Kesalahan jaringan — tidak dapat memuat daftar sesi." });
    }
  }, [eligibleUrl, onSessionExpired]);

  const doSubmit = useCallback(async () => {
    const key = idempotencyKeyRef.current;
    const destId = selectedDestRef.current;
    if (!destId) return;
    const body = {
      destinationOccurrenceId: destId,
      expectedCurrentOccurrenceId: expectedRef.current,
      reason: reasonRef.current || undefined,
    };
    setReqState({ status: "submitting" });
    try {
      const csrfMatch = document.cookie
        .split("; ")
        .find((c) => c.startsWith("futsal_csrf="));
      const csrfToken = csrfMatch?.split("=")[1] ?? "";

      const res = await fetch(
        `/api/parent/children/${studentId}/entitlements/${entitlementId}/move?academyId=${academyId}`,
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

      if (res.status === 401) { onSessionExpired(); return; }

      if (res.status === 200) {
        setReqState({ status: "success" });
        setTimeout(() => {
          if (openRef.current) { onSuccess(); onClose(); }
        }, 600);
        return;
      }

      const errData = (await res.json().catch(() => null)) as ApiError | null;
      if (!openRef.current) return;
      const detail = errData?.error?.detail;
      const message = errData?.error?.message ?? `Error ${res.status}`;

      // Map known move-specific detail subcodes.
      if (detail === "stale_assignment") {
        setReqState({ status: "error", message: "Sesi ini telah dipindahkan. Silakan muat ulang jadwal.", detail, retryable: false });
      } else if (detail === "destination_full") {
        setReqState({ status: "error", message: "Sesi tujuan sudah penuh. Pilih waktu lain.", detail, retryable: false });
      } else if (detail === "move_limit_exceeded") {
        setReqState({ status: "error", message: "Batas pemindahan sesi telah tercapai.", detail, retryable: false });
      } else if (detail === "past_occurrence") {
        setReqState({ status: "error", message: "Tidak dapat memindahkan ke sesi yang sudah lewat.", detail, retryable: false });
      } else if (detail === "occurrence_not_planned") {
        setReqState({ status: "error", message: "Sesi tujuan tidak lagi tersedia. Silakan muat ulang.", detail, retryable: false });
      } else if (detail === "class_mismatch") {
        setReqState({ status: "error", message: "Sesi tujuan tidak sesuai dengan kelas paket.", detail, retryable: false });
      } else if (detail === "obsolete_version") {
        setReqState({ status: "error", message: "Sesi tujuan dari versi jadwal lama. Silakan muat ulang.", detail, retryable: false });
      } else if (detail === "idempotency_key_reuse") {
        setReqState({ status: "error", message: "Konflik permintaan — kunci digunakan untuk permintaan lain. Coba lagi.", detail, retryable: false });
      } else if (detail === "retryable") {
        setReqState({ status: "error", message: "Server sibuk. Silakan coba lagi.", detail, retryable: true });
      } else if (res.status === 403) {
        setReqState({ status: "error", message: "Anda tidak memiliki akses ke aksi ini.", retryable: false });
      } else if (res.status === 404) {
        setReqState({ status: "error", message: "Entitlement tidak ditemukan.", retryable: false });
      } else if (res.status === 422) {
        setReqState({ status: "error", message: "Permintaan tidak valid. Silakan coba lagi.", retryable: false });
      } else {
        setReqState({ status: "error", message, detail, retryable: false });
      }
    } catch {
      if (!openRef.current) return;
      setReqState({ status: "error", message: "Kesalahan jaringan — tidak dapat terhubung ke server. Coba lagi?", retryable: true });
    }
  }, [studentId, entitlementId, academyId, onSessionExpired, onSuccess, onClose]);

  const handleClose = useCallback(() => {
    if (reqState.status === "submitting") return;
    onClose();
  }, [reqState.status, onClose]);

  const submitting = reqState.status === "submitting";
  const showSuccess = reqState.status === "success";
  const showError = reqState.status === "error";
  const currentDt = formatDateTime(startAt);
  const selectedOcc = destState.status === "success" ? destState.occurrences.find((o) => o.id === selectedDestId) : null;
  const canSubmit = selectedDestId !== null && !submitting && destState.status === "success";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pindahkan Sesi</DialogTitle>
          <DialogDescription>
            Pilih sesi tujuan untuk memindahkan jadwal latihan ini.
          </DialogDescription>
        </DialogHeader>

        {showSuccess ? (
          <div className="py-4 text-center">
            <p className="text-sm font-medium text-emerald-600">Sesi berhasil dipindahkan.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Current session info */}
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground">Sesi saat ini</p>
              <p className="text-sm font-medium">{currentDt.date} {currentDt.time}</p>
              <p className="text-sm text-muted-foreground">{className ?? "—"}</p>
            </div>

            {/* Destination picker */}
            <div className="space-y-2">
              <Label>Pilih sesi tujuan</Label>
              {destState.status === "loading" && (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memuat daftar sesi…
                </div>
              )}
              {destState.status === "error" && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
                    <div className="flex-1">
                      <p className="text-sm text-destructive">{destState.message}</p>
                      <Button variant="outline" size="sm" className="mt-2 gap-2" onClick={refetchDest}>
                        <RefreshCw className="h-4 w-4" aria-hidden /> Muat ulang
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              {destState.status === "success" && destState.occurrences.length === 0 && (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  Tidak ada sesi tujuan yang tersedia.
                </div>
              )}
              {destState.status === "success" && destState.occurrences.length > 0 && (
                <RadioGroup
                  value={selectedDestId ?? ""}
                  onValueChange={setSelectedDestId}
                  disabled={submitting}
                  className="space-y-2"
                >
                  {destState.occurrences.map((occ) => {
                    const dt = formatDateTime(occ.startAt);
                    const full = occ.availableSeats === 0;
                    return (
                      <label
                        key={occ.id}
                        htmlFor={`occ-${occ.id}`}
                        className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-muted/30 ${selectedDestId === occ.id ? "border-primary bg-primary/5" : ""} ${full ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <RadioGroupItem value={occ.id} id={`occ-${occ.id}`} disabled={full} className="mt-1" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium">{dt.date} {dt.time}</p>
                            <Badge variant={full ? "destructive" : "secondary"} className="text-xs">
                              {full ? "Penuh" : `${occ.availableSeats} kursi`}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">{occ.className}</p>
                        </div>
                      </label>
                    );
                  })}
                </RadioGroup>
              )}
            </div>

            {/* Selected destination confirmation */}
            {selectedOcc && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
                <span className="text-muted-foreground">{currentDt.date}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                <span className="font-medium">{formatDateTime(selectedOcc.startAt).date} {formatDateTime(selectedOcc.startAt).time}</span>
              </div>
            )}

            {/* Optional reason */}
            <div className="space-y-2">
              <Label htmlFor="move-reason">Alasan (opsional)</Label>
              <Textarea
                id="move-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Contoh: jadwal bentrok…"
                maxLength={500}
                rows={2}
                disabled={submitting}
              />
            </div>

            {/* Error display */}
            {showError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
                <div className="flex-1">
                  <p className="text-sm text-destructive">{(reqState as { message: string }).message}</p>
                  {showError && (reqState as { retryable: boolean }).retryable && (
                    <Button variant="outline" size="sm" className="mt-2 gap-2" onClick={doSubmit} disabled={submitting}>
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
            <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
            <Button onClick={doSubmit} disabled={!canSubmit}>
              {submitting ? (
                <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memproses…</>
              ) : (
                "Pindahkan sesi"
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
