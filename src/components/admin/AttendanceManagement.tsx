"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  AlertCircle,
  Loader2,
  RefreshCw,
  CalendarDays,
  CheckCircle2,
  XCircle,
  UserX,
  Save,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { toast } from "@/hooks/use-toast";

// ============================================================================
// Types (match the API responses)
// ============================================================================

interface OccurrenceListItem {
  id: string;
  classId: string;
  className: string;
  occurrenceDate: string; // YYYY-MM-DD
  startAt: string; // YYYY-MM-DDTHH:MM:SSZ (Jakarta wall-clock)
  endAt: string;
  status: "planned" | "completed" | "cancelled";
  capacity: number;
  cancelledReason: string | null;
  recordedCount: number;
}

interface RosterStudent {
  student_id: string;
  full_name: string;
  enrollment_id: string;
  effective_from: string;
  effective_to: string | null;
  attendance_id: string | null;
  attendance_status: "present" | "absent" | "excused" | null;
  attendance_legacy_status?: "late" | null;
  notes: string | null;
}

interface RosterResponse {
  occurrence: {
    id: string;
    class_id: string;
    occurrence_date: string;
    start_at: string;
    end_at: string;
    status: string;
    capacity: number;
  };
  roster: RosterStudent[];
}

type AttendanceStatus = "present" | "absent" | "excused";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: OccurrenceListItem[] };

// ============================================================================
// Helpers
// ============================================================================

/** Today's date in Asia/Jakarta (UTC+7), as YYYY-MM-DD. */
function jakartaTodayYmd(): string {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Format an occurrence's start/end time as Jakarta wall-clock HH:MM.
 *
 * Two endpoint shapes exist in this app:
 *   1. Occurrences listing (`/api/admin/occurrences`): returns
 *      `to_char(start_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
 *      → e.g. "2026-10-13T15:00:00Z" (Jakarta wall-clock, literal Z suffix,
 *      NO milliseconds). The HH:MM is already Jakarta; extract directly.
 *   2. Roster (`/api/admin/occurrences/:id/roster`): returns the raw
 *      `start_at` Date which JSON-serializes as UTC ISO, e.g.
 *      "2026-10-13T08:00:00.000Z" (UTC, WITH milliseconds, Z suffix).
 *      The HH:MM is UTC; shift +7h to get Jakarta.
 *
 * Distinguishing heuristic: if the string contains a milliseconds component
 * (`.NNNZ`), it's UTC (Date.toJSON output). Otherwise it's the
 * Jakarta-formatted string from to_char.
 */
function formatTime(isoLike: string): string {
  if (!isoLike) return "?";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoLike);
  if (!m) return "?";
  // Date.toJSON() output always includes ".NNN" before the Z. The to_char
  // output never includes milliseconds.
  const isUtc = /\.\d{3}Z$/.test(isoLike) || /\.\d{3}[+-]\d{2}:\d{2}$/.test(isoLike);
  if (isUtc) {
    const d = new Date(isoLike);
    if (Number.isNaN(d.getTime())) return "?";
    const shifted = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
  }
  // Already Jakarta wall-clock (from the listing endpoint's to_char).
  return `${m[4]}:${m[5]}`;
}

/** Format "YYYY-MM-DD" → "Weekday, DD Mon YYYY" (Indonesian-ish locale). */
function formatDateLong(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${weekdays[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const STATUS_META: Record<
  AttendanceStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; active: string; idle: string }
> = {
  present: {
    label: "Hadir",
    icon: CheckCircle2,
    active: "bg-emerald-600 text-white hover:bg-emerald-700 border-emerald-600",
    idle: "bg-background text-emerald-700 hover:bg-emerald-50 border-emerald-200 dark:text-emerald-400 dark:hover:bg-emerald-950",
  },
  absent: {
    label: "Tidak Hadir",
    icon: XCircle,
    active: "bg-rose-600 text-white hover:bg-rose-700 border-rose-600",
    idle: "bg-background text-rose-700 hover:bg-rose-50 border-rose-200 dark:text-rose-400 dark:hover:bg-rose-950",
  },
  excused: {
    label: "Izin",
    icon: UserX,
    active: "bg-sky-600 text-white hover:bg-sky-700 border-sky-600",
    idle: "bg-background text-sky-700 hover:bg-sky-50 border-sky-200 dark:text-sky-400 dark:hover:bg-sky-950",
  },
};

const ALL_STATUSES: AttendanceStatus[] = ["present", "absent", "excused"];

// ============================================================================
// Shared fetch helper (matches the pattern in AdminShell)
// ============================================================================

async function adminFetch(url: string, method: string, body?: unknown): Promise<Response> {
  const csrfMatch = document.cookie.split("; ").find((c) => c.startsWith("futsal_csrf="));
  const csrfToken = csrfMatch?.split("=")[1] ?? "";
  return fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      [CSRF_HEADER]: csrfToken,
      ...(body !== undefined ? {} : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ============================================================================
// Main Component
// ============================================================================

interface AttendanceManagementProps {
  academyId: string;
}

export function AttendanceManagement({ academyId }: AttendanceManagementProps) {
  const [selectedDate, setSelectedDate] = useState<string>(jakartaTodayYmd());
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);

  if (selectedOccurrenceId) {
    return (
      <AttendanceRoster
        occurrenceId={selectedOccurrenceId}
        academyId={academyId}
        onBack={() => setSelectedOccurrenceId(null)}
      />
    );
  }

  return (
    <AttendanceSessionList
      academyId={academyId}
      selectedDate={selectedDate}
      onSelectDate={setSelectedDate}
      onSelectOccurrence={setSelectedOccurrenceId}
    />
  );
}

// ============================================================================
// Session List (date picker + today's sessions)
// ============================================================================

interface AttendanceSessionListProps {
  academyId: string;
  selectedDate: string;
  onSelectDate: (d: string) => void;
  onSelectOccurrence: (id: string) => void;
}

function AttendanceSessionList({
  academyId,
  selectedDate,
  onSelectDate,
  onSelectOccurrence,
}: AttendanceSessionListProps) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const academyIdRef = useRef(academyId);

  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token (stale-response guard). Mirrors the
  // RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchList = useCallback(async () => {
    const aid = academyId;
    const date = selectedDate;
    const myRequestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const url = `/api/admin/occurrences?academyId=${aid}&fromDate=${date}&toDate=${date}`;
      const res = await fetch(url, { credentials: "same-origin" });
      const data = (await res.json()) as { occurrences?: OccurrenceListItem[]; error?: { message?: string } };
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok || !data.occurrences) {
        setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
        return;
      }
      setState({ status: "success", data: data.occurrences });
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId, selectedDate]);

  useEffect(() => {
    if (!academyId || !selectedDate) return;
    const myRequestId = ++requestIdRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const url = `/api/admin/occurrences?academyId=${academyId}&fromDate=${selectedDate}&toDate=${selectedDate}`;
        const res = await fetch(url, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        const data = (await res.json()) as { occurrences?: OccurrenceListItem[]; error?: { message?: string } };
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok || !data.occurrences) {
          setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.occurrences });
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setState({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId, selectedDate]);

  const today = jakartaTodayYmd();
  const isToday = selectedDate === today;

  return (
    <div className="space-y-4">
      {/* Header: date picker + today button */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">Kehadiran</h3>
          <p className="text-xs text-muted-foreground">
            Pilih tanggal untuk melihat sesi latihan terjadwal, lalu catat kehadiran per sesi.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="attendance-date" className="text-xs text-muted-foreground">
              Tanggal
            </Label>
            <Input
              id="attendance-date"
              type="date"
              value={selectedDate}
              onChange={(e) => onSelectDate(e.target.value)}
              className="w-44"
            />
          </div>
          {!isToday && (
            <Button variant="outline" size="sm" onClick={() => onSelectDate(today)} className="gap-2">
              <CalendarDays className="h-4 w-4" aria-hidden /> Hari ini
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={fetchList} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
          </Button>
        </div>
      </div>

      {/* Loading state */}
      {state.status === "loading" && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat sesi latihan untuk {formatDateLong(selectedDate)}…</p>
          </CardContent>
        </Card>
      )}

      {/* Error state */}
      {state.status === "error" && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm font-medium text-destructive">Gagal memuat sesi latihan</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={fetchList}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {state.status === "success" && state.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <CalendarDays className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">Tidak ada sesi latihan terjadwal</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tidak ada sesi latihan pada {formatDateLong(selectedDate)}.
              <br />
              Buat sesi latihan dari tab Kelas terlebih dahulu.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Session list */}
      {state.status === "success" && state.data.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {state.data.length} sesi pada{" "}
              {formatDateLong(selectedDate)}
            </span>
          </div>
          {state.data.map((occ) => {
            const fullyRecorded =
              occ.recordedCount > 0 && occ.recordedCount >= occ.capacity ? true : false;
            return (
              <Card
                key={occ.id}
                className="cursor-pointer transition-all hover:border-primary/40 hover:shadow-sm"
                onClick={() => onSelectOccurrence(occ.id)}
              >
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 flex-col items-center justify-center rounded-lg bg-primary/5 text-primary">
                      <span className="text-base font-semibold leading-none">
                        {formatTime(occ.startAt)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatTime(occ.endAt)}
                      </span>
                    </div>
                    <div>
                      <p className="font-medium">{occ.className}</p>
                      <p className="text-sm text-muted-foreground">
                        Kapasitas: {occ.capacity}
                        {occ.recordedCount > 0 && (
                          <span className="ml-2">
                            · {occ.recordedCount} tercatat
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {occ.status === "cancelled" && (
                      <Badge variant="destructive">Dibatalkan</Badge>
                    )}
                    {occ.status === "completed" && <Badge>Selesai</Badge>}
                    {occ.status === "planned" && fullyRecorded && (
                      <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                        Semua tercatat
                      </Badge>
                    )}
                    {occ.status === "planned" && !fullyRecorded && occ.recordedCount > 0 && (
                      <Badge variant="secondary">{occ.recordedCount}/{occ.capacity}</Badge>
                    )}
                    {occ.status === "planned" && occ.recordedCount === 0 && (
                      <Badge variant="outline">Belum dimulai</Badge>
                    )}
                    <Button variant="ghost" size="sm" className="text-muted-foreground">
                      Catat kehadiran →
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Roster View (per-student attendance)
// ============================================================================

interface AttendanceRosterProps {
  occurrenceId: string;
  academyId: string;
  onBack: () => void;
}

interface RosterState {
  status: "loading" | "error" | "success";
  message?: string;
  data?: RosterResponse;
}

interface StudentDraft {
  studentId: string;
  fullName: string;
  attendanceId: string | null;
  /** Status the admin has selected in the UI (may differ from server). */
  selectedStatus: AttendanceStatus | null;
  notes: string;
  /** True if the draft has unsaved changes. */
  dirty: boolean;
  /** Saving state for this student. */
  saving: "idle" | "saving" | "saved" | "error";
  saveError?: string;
}

export function AttendanceRoster({ occurrenceId, academyId, onBack }: AttendanceRosterProps) {
  const [state, setState] = useState<RosterState>({ status: "loading" });
  const [drafts, setDrafts] = useState<Record<string, StudentDraft>>({});
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token (stale-response guard) for the roster fetch.
  const rosterRequestIdRef = useRef(0);

  // Fetch the roster + initialize drafts. Pure async function (no setState
  // called synchronously from an effect — the initial load is wrapped in
  // an async IIFE inside the effect, matching the existing ClassManagement
  // pattern in AdminShell).
  const loadRoster = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++rosterRequestIdRef.current;
    try {
      const res = await fetch(
        `/api/admin/occurrences/${occurrenceId}/roster?academyId=${aid}`,
        { credentials: "same-origin" },
      );
      if (myRequestId !== rosterRequestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        if (myRequestId !== rosterRequestIdRef.current) return;
        setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
        return;
      }
      const data = (await res.json()) as RosterResponse;
      if (myRequestId !== rosterRequestIdRef.current) return;
      // Initialize drafts from the roster.
      const newDrafts: Record<string, StudentDraft> = {};
      for (const s of data.roster) {
        newDrafts[s.student_id] = {
          studentId: s.student_id,
          fullName: s.full_name,
          attendanceId: s.attendance_id,
          selectedStatus: s.attendance_status,
          notes: s.notes ?? "",
          dirty: false,
          saving: "idle",
        };
      }
      setState({ status: "success", data });
      setDrafts(newDrafts);
    } catch {
      if (myRequestId !== rosterRequestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [occurrenceId, academyId]);

  // Initial load — inline async IIFE (no synchronous setState in the
  // effect body). The "Discard" button calls `loadRoster` directly to
  // re-fetch fresh state from the server.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await loadRoster();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadRoster]);

  const setStatus = (studentId: string, status: AttendanceStatus) => {
    setDrafts((prev) => {
      const d = prev[studentId];
      if (!d) return prev;
      if (d.selectedStatus === status && !d.dirty) return prev;
      return {
        ...prev,
        [studentId]: { ...d, selectedStatus: status, dirty: true, saving: "idle", saveError: undefined },
      };
    });
  };

  const setNotes = (studentId: string, notes: string) => {
    setDrafts((prev) => {
      const d = prev[studentId];
      if (!d) return prev;
      return { ...prev, [studentId]: { ...d, notes, dirty: true, saving: "idle", saveError: undefined } };
    });
  };

  const saveStudent = async (studentId: string): Promise<boolean> => {
    const draft = drafts[studentId];
    if (!draft || !draft.dirty || draft.saving === "saving") return false;

    setDrafts((prev) => ({
      ...prev,
      [studentId]: { ...prev[studentId]!, saving: "saving", saveError: undefined },
    }));

    try {
      let res: Response;
      const body: { studentId: string; status: AttendanceStatus; notes?: string } = {
        studentId: draft.studentId,
        status: draft.selectedStatus!,
      };
      if (draft.notes.trim()) body.notes = draft.notes.trim();

      if (draft.attendanceId) {
        // PATCH existing record.
        const patchBody: { status?: AttendanceStatus; notes?: string | null } = {};
        if (draft.selectedStatus) patchBody.status = draft.selectedStatus;
        patchBody.notes = draft.notes.trim() || null;
        res = await adminFetch(
          `/api/admin/attendance/${draft.attendanceId}?academyId=${academyId}`,
          "PATCH",
          patchBody,
        );
      } else {
        // POST new record.
        res = await adminFetch(
          `/api/admin/occurrences/${occurrenceId}/attendance?academyId=${academyId}`,
          "POST",
          body,
        );
      }

      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
        setDrafts((prev) => ({
          ...prev,
          [studentId]: {
            ...prev[studentId]!,
            saving: "error",
            saveError: failMsg,
          },
        }));
        return false;
      }

      // If this was a POST, capture the new attendanceId.
      let newAttendanceId = draft.attendanceId;
      if (!newAttendanceId) {
        const json = (await res.json()) as { attendanceId?: string };
        newAttendanceId = json.attendanceId ?? null;
      }

      setDrafts((prev) => ({
        ...prev,
        [studentId]: {
          ...prev[studentId]!,
          attendanceId: newAttendanceId,
          dirty: false,
          saving: "saved",
          saveError: undefined,
        },
      }));

      // Clear "saved" badge after 1.5s.
      setTimeout(() => {
        setDrafts((prev) => {
          const cur = prev[studentId];
          if (!cur || cur.saving !== "saved") return prev;
          return { ...prev, [studentId]: { ...cur, saving: "idle" } };
        });
      }, 1500);
      return true;
    } catch {
      setDrafts((prev) => ({
        ...prev,
        [studentId]: { ...prev[studentId]!, saving: "error", saveError: "Kesalahan jaringan" },
      }));
      return false;
    }
  };

  const saveAll = async () => {
    const dirtyIds = Object.values(drafts)
      .filter((d) => d.dirty && d.selectedStatus !== null)
      .map((d) => d.studentId);
    if (dirtyIds.length === 0) return;
    // Save sequentially to avoid concurrent CSRF/lock contention on the
    // occurrence row (recordAttendance takes a SERIALIZABLE tx + FOR UPDATE
    // on the occurrence). Sequential is correct; parallel would race.
    let ok = 0;
    let fail = 0;
    for (const id of dirtyIds) {
      const success = await saveStudent(id);
      if (success) ok++; else fail++;
    }
    // Single summary toast for the batch (per-student inline badges
    // still show "saved"/"error" individually).
    if (fail === 0) {
      toast({ title: `Kehadiran tersimpan (${ok} siswa)` });
    } else if (ok === 0) {
      toast({ title: "Gagal menyimpan kehadiran", description: `${fail} siswa gagal`, variant: "destructive" });
    } else {
      toast({ title: "Beberapa kehadiran gagal disimpan", description: `${ok} tersimpan, ${fail} gagal`, variant: "destructive" });
    }
  };

  const dirtyCount = Object.values(drafts).filter((d) => d.dirty).length;

  if (state.status === "loading") {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">Memuat daftar siswa…</p>
        </CardContent>
      </Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card className="border-destructive/30">
        <CardContent className="p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-sm font-medium text-destructive">Gagal memuat daftar siswa</p>
              <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
              <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const data = state.data!;
  const occ = data.occurrence;
  const roster = data.roster;

  // Aggregate counts from current drafts (so the header summary updates live).
  const counts: Record<AttendanceStatus, number> = { present: 0, absent: 0, excused: 0 };
  let unrecorded = 0;
  for (const s of roster) {
    const d = drafts[s.student_id];
    const status = d?.selectedStatus ?? s.attendance_status;
    if (status) counts[status]++;
    else unrecorded++;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali
        </Button>
      </div>

      {/* Occurrence summary card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-lg">
                {formatDateLong(occ.occurrence_date.slice(0, 10))}
              </CardTitle>
              <CardDescription>
                {formatTime(occ.start_at)} – {formatTime(occ.end_at)} · Kapasitas {occ.capacity}
              </CardDescription>
            </div>
            <Badge
              variant={occ.status === "planned" ? "secondary" : "outline"}
              className="capitalize"
            >
              {occ.status === "planned" ? "Direncanakan" : occ.status === "completed" ? "Selesai" : occ.status === "cancelled" ? "Dibatalkan" : occ.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryStat label="Hadir" value={counts.present} color="emerald" />
            <SummaryStat label="Tidak Hadir" value={counts.absent} color="rose" />
            <SummaryStat label="Izin" value={counts.excused} color="sky" />
            <SummaryStat label="Belum tercatat" value={unrecorded} color="muted" />
          </div>
        </CardContent>
      </Card>

      {/* Roster */}
      {roster.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Users className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">Tidak ada siswa terdaftar</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tidak ada siswa yang terdaftar di kelas ini pada tanggal sesi latihan.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {roster.map((student) => {
            const draft = drafts[student.student_id];
            if (!draft) return null;
            return (
              <Card
                key={student.student_id}
                className={draft.dirty ? "border-primary/40" : ""}
              >
                <CardContent className="p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3 sm:min-w-0 sm:flex-1">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                        {draft.fullName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium leading-tight">{draft.fullName}</p>
                        {draft.attendanceId && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Sebelumnya: {student.attendance_legacy_status === "late" ? "Terlambat (data lama)" : student.attendance_status ? (STATUS_META[student.attendance_status as AttendanceStatus]?.label ?? student.attendance_status) : "—"}
                          </p>
                        )}
                        <Textarea
                          value={draft.notes}
                          onChange={(e) => setNotes(student.student_id, e.target.value)}
                          placeholder="Catatan (opsional)…"
                          className="mt-2 min-h-[44px] resize-y text-sm"
                          disabled={draft.saving === "saving"}
                          rows={1}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col items-stretch gap-2 sm:items-end">
                      <div className="flex flex-wrap gap-1.5">
                        {ALL_STATUSES.map((status) => {
                          const meta = STATUS_META[status];
                          const Icon = meta.icon;
                          const isActive = draft.selectedStatus === status;
                          return (
                            <Button
                              key={status}
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setStatus(student.student_id, status)}
                              disabled={draft.saving === "saving"}
                              className={`gap-1.5 border ${isActive ? meta.active : meta.idle}`}
                              aria-pressed={isActive}
                            >
                              <Icon className="h-3.5 w-3.5" aria-hidden />
                              <span className="text-xs">{meta.label}</span>
                            </Button>
                          );
                        })}
                      </div>
                      <div className="flex items-center gap-2">
                        {draft.saving === "saving" && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Menyimpan…
                          </span>
                        )}
                        {draft.saving === "saved" && (
                          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" aria-hidden /> Tersimpan
                          </span>
                        )}
                        {draft.saving === "error" && (
                          <span className="text-xs text-destructive" title={draft.saveError}>
                            {draft.saveError ?? "Kesalahan"}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant={draft.dirty ? "default" : "outline"}
                          disabled={!draft.dirty || draft.saving === "saving"}
                          onClick={async () => {
                            const success = await saveStudent(student.student_id);
                            if (success) {
                              toast({ title: "Kehadiran tersimpan" });
                            } else {
                              toast({ title: "Gagal menyimpan kehadiran", description: "Periksa kesalahan pada baris ini", variant: "destructive" });
                            }
                          }}
                          className="gap-1.5"
                        >
                          <Save className="h-3.5 w-3.5" aria-hidden /> Simpan
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Sticky save-all bar */}
      {dirtyCount > 0 && (
        <div className="sticky bottom-4 z-10">
          <Card className="border-primary/40 shadow-lg">
            <CardContent className="flex items-center justify-between p-3">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{dirtyCount}</span> perubahan belum tersimpan
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void loadRoster()}>
                  Buang
                </Button>
                <Button size="sm" onClick={() => void saveAll()} className="gap-1.5">
                  <Save className="h-3.5 w-3.5" aria-hidden /> Simpan Semua ({dirtyCount})
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Summary Stat (small present/late/absent/excused/unrecorded box)
// ============================================================================

interface SummaryStatProps {
  label: string;
  value: number;
  color: "emerald" | "amber" | "rose" | "sky" | "muted";
}

function SummaryStat({ label, value, color }: SummaryStatProps) {
  const colorClasses: Record<SummaryStatProps["color"], string> = {
    emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
    rose: "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400",
    sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <div className={`rounded-lg p-2.5 text-center ${colorClasses[color]}`}>
      <p className="text-xl font-semibold leading-none">{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-wide">{label}</p>
    </div>
  );
}
