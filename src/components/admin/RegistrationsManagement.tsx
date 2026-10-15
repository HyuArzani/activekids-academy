"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  FileCheck,
  AlertCircle,
  Loader2,
  RefreshCw,
  Check,
  X,
  User,
  Phone,
  Mail,
  Calendar,
  MessageSquare,
  Clock,
  CheckCircle2,
  XCircle,
  Users,
  Search,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { toast } from "@/hooks/use-toast";

// ============================================================================
// Types — match RegistrationApplicationRow (camelCase from API SQL aliases)
// ============================================================================

type AppStatus = "pending" | "approved" | "rejected";
type StatusFilter = AppStatus | "all";

interface RegistrationApplication {
  id: string;
  academyId: string;
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
  status: AppStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  studentId: string | null;
  submittedAt: string;
}

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: RegistrationApplication[] };

// ============================================================================
// Helpers
// ============================================================================

/** Format an ISO timestamp "YYYY-MM-DDTHH:MM:SSZ" → "DD Mon YYYY, HH:MM". */
function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Format a date value (either "YYYY-MM-DD" or ISO timestamp) → "DD Mon YYYY". */
function formatDate(dateVal: string | null): string {
  if (!dateVal) return "—";
  // Handle both "YYYY-MM-DD" (clean string) and ISO timestamps
  // "YYYY-MM-DDT00:00:00.000Z" (Date.toJSON from the DB driver).
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateVal);
  if (!ymdMatch || !ymdMatch[1] || !ymdMatch[2] || !ymdMatch[3]) return dateVal;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = parseInt(ymdMatch[3], 10);
  const month = parseInt(ymdMatch[2], 10) - 1;
  const year = parseInt(ymdMatch[1], 10);
  return `${String(day).padStart(2, "0")} ${months[month] ?? "???"} ${year}`;
}

/** Calculate age from DOB (either "YYYY-MM-DD" or ISO timestamp) in years. */
function ageFromDob(dateVal: string | null): string {
  if (!dateVal) return "—";
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateVal);
  if (!ymdMatch) return "—";
  const dob = new Date(`${ymdMatch[0]}T00:00:00.000Z`);
  if (Number.isNaN(dob.getTime())) return "—";
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return `${age} yrs`;
}

const CONTACT_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  phone: { label: "Telepon", icon: Phone, color: "text-sky-600" },
  email: { label: "Email", icon: Mail, color: "text-violet-600" },
  whatsapp: { label: "WhatsApp", icon: MessageSquare, color: "text-emerald-600" },
};

async function adminFetch(url: string, method: string, body?: unknown): Promise<Response> {
  const csrfMatch = document.cookie.split("; ").find((c) => c.startsWith("futsal_csrf="));
  const csrfToken = csrfMatch?.split("=")[1] ?? "";
  return fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      [CSRF_HEADER]: csrfToken,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ============================================================================
// Main component
// ============================================================================

export function RegistrationsManagement({ academyId }: { academyId: string }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [rejectingApp, setRejectingApp] = useState<RegistrationApplication | null>(null);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchList call. Before
  // applying a response, check if this token still matches the latest
  // value. If a newer request has started, the stale response is discarded.
  // This prevents an older (slower) request from overwriting newer data
  // — e.g., a manual Refresh finishing after a silent refetch that
  // followed an approve.
  const requestIdRef = useRef(0);

  /**
   * Fetch the application list from the server.
   *
   * @param silent — when true, does NOT set loading/error state. Used after
   *   optimistic mutations (approve/reject) to reconcile local state with
   *   the server without causing a loading flash or replacing the list with
   *   an error message on failure. On silent failure, the current list
   *   (which reflects the successful mutation) stays visible.
   *
   * Concurrency: each call increments requestIdRef.current and captures the
   * value. Before applying the response, the captured value is compared to
   * the current ref. If they differ, a newer request has started and this
   * response is stale — it is silently discarded.
   */
  const fetchList = useCallback(async (silent = false) => {
    const aid = academyId;
    const filter = statusFilter;
    if (!aid) {
      if (!silent) setState({ status: "error", message: "Tidak ada akademi terpilih" });
      return;
    }
    const myRequestId = ++requestIdRef.current;
    if (!silent) setState({ status: "loading" });
    try {
      const res = await fetch(
        `/api/admin/registrations?academyId=${aid}&status=${filter}`,
        { credentials: "same-origin" },
      );
      const data = (await res.json()) as { applications?: RegistrationApplication[]; error?: { message?: string } };
      // Stale-response guard: if a newer request started, discard this.
      if (myRequestId !== requestIdRef.current) return;
      // Academy-change guard: if the academy changed, discard this.
      if (aid !== academyIdRef.current) return;
      if (!res.ok || !data.applications) {
        // Silent failure: keep the current list (the mutation already
        // succeeded, so the optimistic state is correct).
        if (!silent) {
          setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
        }
        return;
      }
      setState({ status: "success", data: data.applications });
    } catch {
      // Stale-response guard: if a newer request started, discard this.
      if (myRequestId !== requestIdRef.current) return;
      // Academy-change guard.
      if (aid !== academyIdRef.current) return;
      // Silent failure: keep the current list.
      if (!silent) {
        setState({ status: "error", message: "Kesalahan jaringan" });
      }
    }
  }, [academyId, statusFilter]);

  useEffect(() => {
    if (!academyId) return;
    // Inline async IIFE (not fetchList) to avoid the React Compiler
    // "setState synchronously within an effect" warning — fetchList
    // calls setState({status:"loading"}) before its first await, which
    // the compiler flags. The IIFE defers all setState calls to after
    // the await, which is safe.
    //
    // Both this IIFE and fetchList share the same requestIdRef, so
    // overlapping requests between the two code paths are handled
    // correctly — the older request's response is discarded.
    const myRequestId = ++requestIdRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/registrations?academyId=${academyId}&status=${statusFilter}`,
          { credentials: "same-origin" },
        );
        if (cancelled) return;
        // Stale-response guard: if a newer request started, discard.
        if (myRequestId !== requestIdRef.current) return;
        const data = (await res.json()) as { applications?: RegistrationApplication[]; error?: { message?: string } };
        if (cancelled) return;
        if (myRequestId !== requestIdRef.current) return;
        if (!res.ok || !data.applications) {
          setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.applications });
      } catch {
        if (cancelled) return;
        if (myRequestId !== requestIdRef.current) return;
        setState({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId, statusFilter]);

  // Optimistic update: remove an application from the local list immediately
  // after approve/reject, before the server confirms via fetchList. This
  // fixes R4 (stale data after approve — the card would stay visible until
  // the refetch completed, which could take 200-500ms with PgLite).
  const optimisticRemove = useCallback((appId: string) => {
    setState((prev) => {
      if (prev.status !== "success") return prev;
      return {
        status: "success",
        data: prev.data.filter((a) => a.id !== appId),
      };
    });
  }, []);

  // Derive counts from the current list for the filter tab badges.
  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 };
    if (state.status === "success") {
      for (const app of state.data) {
        if (app.status === "pending") c.pending++;
        else if (app.status === "approved") c.approved++;
        else if (app.status === "rejected") c.rejected++;
      }
    }
    return c;
  }, [state]);

  // Client-side search filter (R3). Filters by parent name, child name,
  // or phone number.
  const filteredApps = useMemo(() => {
    if (state.status !== "success") return [];
    if (!search.trim()) return state.data;
    const q = search.toLowerCase().trim();
    return state.data.filter((a) =>
      a.parentFullName.toLowerCase().includes(q) ||
      a.childFullName.toLowerCase().includes(q) ||
      a.parentPhone.toLowerCase().includes(q) ||
      (a.parentEmail?.toLowerCase().includes(q) ?? false),
    );
  }, [state, search]);

  const filterTabs: { id: StatusFilter; label: string; count?: number; color: string }[] = [
    { id: "pending", label: "Menunggu", count: counts.pending, color: "amber" },
    { id: "approved", label: "Disetujui", count: counts.approved, color: "emerald" },
    { id: "rejected", label: "Ditolak", count: counts.rejected, color: "rose" },
    { id: "all", label: "Semua", color: "muted" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">Pendaftaran</h3>
          <p className="text-xs text-muted-foreground">
            Tinjau pengajuan pendaftaran publik. Menyetujui akan membuat akun siswa + wali + pendaftaran kelas.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchList()} className="gap-2">
          <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
        </Button>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label="Filter status pendaftaran">
        {filterTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={statusFilter === tab.id}
            onClick={() => { setStatusFilter(tab.id); setSearch(""); }}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
              statusFilter === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <Badge
                variant="secondary"
                className={`h-5 min-w-5 px-1.5 text-xs ${
                  tab.color === "amber"
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                    : tab.color === "emerald"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                      : tab.color === "rose"
                        ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400"
                        : ""
                }`}
              >
                {tab.count}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {/* Search bar (R3) */}
      {state.status === "success" && state.data.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              placeholder="Cari berdasarkan orang tua, anak, atau telepon…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {search && (
            <Button variant="ghost" size="sm" onClick={() => setSearch("")} className="text-xs">
              Bersihkan
            </Button>
          )}
        </div>
      )}

      {/* Loading */}
      {state.status === "loading" && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat pengajuan…</p>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {state.status === "error" && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm font-medium text-destructive">Gagal memuat pengajuan</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={() => void fetchList()}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty */}
      {state.status === "success" && filteredApps.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <FileCheck className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">
              {search ? "Tidak ada pengajuan yang cocok" : statusFilter === "all" ? "Tidak ada pengajuan" : `Tidak ada pengajuan ${statusFilter === "pending" ? "menunggu" : statusFilter === "approved" ? "disetujui" : "ditolak"}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {search
                ? "Coba kata kunci pencarian lain."
                : statusFilter === "pending"
                  ? "Pengajuan pendaftaran baru dari formulir publik akan muncul di sini untuk ditinjau."
                  : `Tidak ada pengajuan ${statusFilter === "approved" ? "disetujui" : "ditolak"} di akademi ini.`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Application cards */}
      {state.status === "success" && filteredApps.length > 0 && (
        <div className="space-y-3">
          {filteredApps.map((app) => (
            <ApplicationCard
              key={app.id}
              app={app}
              academyId={academyId}
              onApproveDone={() => {
                // Optimistic remove immediately, then silent refetch.
                // Silent = don't flash loading state, don't replace list
                // with error on refetch failure (the mutation already
                // succeeded, so the optimistic state is correct).
                optimisticRemove(app.id);
                void fetchList(true);
              }}
              onReject={() => setRejectingApp(app)}
            />
          ))}
        </div>
      )}

      {/* Reject dialog */}
      {rejectingApp && (
        <RejectDialog
          key={`reject-${rejectingApp.id}`}
          open={rejectingApp !== null}
          app={rejectingApp}
          academyId={academyId}
          onClose={() => setRejectingApp(null)}
          onRejected={() => {
            // Optimistic remove immediately, then silent refetch.
            optimisticRemove(rejectingApp.id);
            setRejectingApp(null);
            void fetchList(true);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Application Card
// ============================================================================

function ApplicationCard({
  app,
  academyId,
  onApproveDone,
  onReject,
}: {
  app: RegistrationApplication;
  academyId: string;
  onApproveDone: () => void;
  onReject: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const handleApprove = async () => {
    setApproving(true);
    setApproveError(null);
    try {
      const res = await adminFetch(
        `/api/admin/registrations/${app.id}/approve?academyId=${academyId}`,
        "POST",
      );
      if (res.ok) {
        toast({ title: "Pendaftaran disetujui" });
        onApproveDone();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setApproveError(failMsg);
      toast({ title: "Gagal menyetujui pendaftaran", description: failMsg, variant: "destructive" });
    } catch {
      setApproveError("Kesalahan jaringan");
      toast({ title: "Gagal menyetujui pendaftaran", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setApproving(false);
    }
  };

  const contact = app.preferredContact ? CONTACT_META[app.preferredContact] : null;
  const ContactIcon = contact?.icon ?? Phone;

  return (
    <Card
      className={`transition-all ${
        app.status === "pending"
          ? "border-amber-200 dark:border-amber-900/50"
          : app.status === "approved"
            ? "border-emerald-200 dark:border-emerald-900/50"
            : "border-rose-200 dark:border-rose-900/50"
      }`}
    >
      <CardContent className="p-4">
        <div className="flex flex-col gap-3">
          {/* Top row: status badge + submitted time */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {app.status === "pending" && (
                <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                  <Clock className="h-3 w-3 mr-1" aria-hidden /> Menunggu
                </Badge>
              )}
              {app.status === "approved" && (
                <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3 mr-1" aria-hidden /> Disetujui
                </Badge>
              )}
              {app.status === "rejected" && (
                <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400">
                  <XCircle className="h-3 w-3 mr-1" aria-hidden /> Ditolak
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                Dikirim {formatTimestamp(app.submittedAt)}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDetails((v) => !v)}
              className="text-xs"
            >
              {showDetails ? "Sembunyikan" : "Detail"}
            </Button>
          </div>

          {/* Main info: parent + child */}
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Parent */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Orang Tua / Wali</p>
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {app.parentFullName.charAt(0).toUpperCase()}
                </div>
                <p className="text-sm font-medium">{app.parentFullName}</p>
              </div>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Phone className="h-3.5 w-3.5" aria-hidden />
                <span>{app.parentPhone}</span>
              </div>
              {app.parentEmail && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Mail className="h-3.5 w-3.5" aria-hidden />
                  <span className="truncate">{app.parentEmail}</span>
                </div>
              )}
              {contact && (
                <div className="flex items-center gap-1.5 text-xs">
                  <ContactIcon className={`h-3.5 w-3.5 ${contact.color}`} aria-hidden />
                  <span className="text-muted-foreground">Lebih suka: {contact.label}</span>
                </div>
              )}
            </div>

            {/* Child */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Anak</p>
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
                  {app.childFullName.charAt(0).toUpperCase()}
                </div>
                <p className="text-sm font-medium">{app.childFullName}</p>
              </div>
              {app.childDateOfBirth && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" aria-hidden />
                  <span>
                    {formatDate(app.childDateOfBirth)} ({ageFromDob(app.childDateOfBirth)})
                  </span>
                </div>
              )}
              {app.classPreference && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  <span>Kelas: {app.classPreference}</span>
                </div>
              )}
              {app.preferredDay && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Hari preferensi: {app.preferredDay}</span>
                </div>
              )}
            </div>
          </div>

          {/* Notes */}
          {app.notes && (
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Catatan</p>
              <p className="mt-0.5 text-sm">{app.notes}</p>
            </div>
          )}

          {/* Expanded details for reviewed apps */}
          {showDetails && app.status !== "pending" && (
            <div className="space-y-1.5 rounded-lg border p-2.5 text-xs">
              <p className="font-medium uppercase tracking-wide text-muted-foreground">Tinjauan</p>
              <div className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <span>Ditinjau: {formatTimestamp(app.reviewedAt)}</span>
              </div>
              {app.status === "approved" && app.studentId && (
                <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  <span>Siswa dibuat (ID: {app.studentId.slice(0, 8)}…)</span>
                </div>
              )}
              {app.status === "rejected" && app.rejectionReason && (
                <div className="mt-1 rounded bg-rose-50 p-2 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400">
                  <span className="font-medium">Alasan: </span>
                  {app.rejectionReason}
                </div>
              )}
            </div>
          )}

          {/* Approve error */}
          {approveError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{approveError}</p>
            </div>
          )}

          {/* Action buttons for pending */}
          {app.status === "pending" && (
            <div className="flex items-center gap-2 border-t pt-3">
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={approving}
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
              >
                {approving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Menyetujui…
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" aria-hidden /> Setujui
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onReject}
                disabled={approving}
                className="gap-1.5 border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
              >
                <X className="h-3.5 w-3.5" aria-hidden /> Tolak
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Reject Dialog
// ============================================================================

function RejectDialog({
  open,
  app,
  academyId,
  onClose,
  onRejected,
}: {
  open: boolean;
  app: RegistrationApplication;
  academyId: string;
  onClose: () => void;
  onRejected: () => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!reason.trim()) {
      setError("Alasan wajib diisi untuk menolak pengajuan.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminFetch(
        `/api/admin/registrations/${app.id}/reject?academyId=${academyId}`,
        "POST",
        { reason: reason.trim() },
      );
      if (res.ok) {
        toast({ title: "Pendaftaran ditolak" });
        onRejected();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menolak pendaftaran", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal menolak pendaftaran", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tolak Pengajuan</DialogTitle>
          <DialogDescription>
            Anda akan menolak pengajuan {app.parentFullName} untuk {app.childFullName}. Alasan wajib diisi dan akan dicatat untuk audit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Alasan *</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              placeholder="mis. Kelas penuh, silakan coba periode berikutnya"
              rows={3}
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            Batal
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={submitting}
            className="gap-1.5"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menolak…
              </>
            ) : (
              <>
                <X className="h-4 w-4" aria-hidden /> Tolak Pengajuan
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
