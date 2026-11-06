"use client";

/**
 * Coach Portal — the coach role's main workspace.
 *
 * Features:
 *   1. Schedule: list the coach's assigned training occurrences.
 *   2. Roster & attendance: view who is enrolled in a session and mark
 *      attendance (present / absent / excused).
 *   3. Training plan: write/edit a per-session training plan; optionally
 *      share it with parents (visible_to_parents).
 *
 * Authorization lives entirely in the API layer; this component only
 * renders what the authenticated coach is allowed to see.
 */

import { useState, useEffect, useCallback } from "react";
import {
  CalendarDays,
  ClipboardList,
  RefreshCw,
  Loader2,
  AlertCircle,
  ArrowLeft,
  Save,
  Eye,
  Check,
  X,
  MinusCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { formatDateTime, attendanceLabel } from "@/lib/parent-ui/format";

// === Types (match the API response shapes) ==============================

interface CoachOccurrence {
  id: string;
  class_id: string;
  class_name: string;
  occurrence_date: string;
  start_at: string;
  end_at: string;
  status: string;
  capacity: number;
}

interface RosterEntry {
  student_id: string;
  full_name: string;
  attendance_status: string | null;
  attendance_id: string | null;
}

interface RosterResponse {
  occurrence: { id: string; class_name: string; occurrence_date: string; start_at: string; status: string };
  roster: RosterEntry[];
}

interface PlanDto {
  id: string;
  occurrenceId: string;
  occurrenceDate: string;
  className: string;
  title: string;
  content: string;
  visibleToParents: boolean;
  updatedAt: string;
}

function csrfToken(): string {
  return document.cookie.split("; ").find((c) => c.startsWith("futsal_csrf="))?.split("=")[1] ?? "";
}

// === Main component ======================================================

interface CoachPortalProps {
  memberships: { academyId: string; role: string }[];
  selectedAcademyId: string;
  onSelectAcademy: (academyId: string) => void;
  onSessionExpired: () => void;
}

type LoadState =
  | { status: "loading"; academyId: string }
  | { status: "success"; academyId: string; occurrences: CoachOccurrence[] }
  | { status: "error"; academyId: string; message: string };

export function CoachPortal({ memberships, selectedAcademyId, onSelectAcademy, onSessionExpired }: CoachPortalProps) {
  const coachMemberships = memberships.filter((m) => m.role === "coach");
  const effectiveAcademyId = selectedAcademyId || coachMemberships[0]?.academyId || "";
  const [state, setState] = useState<LoadState>({ status: "loading", academyId: effectiveAcademyId });
  const [selected, setSelected] = useState<CoachOccurrence | null>(null);

  const loadOccurrences = useCallback(async (academyId: string) => {
    setState({ status: "loading", academyId });
    try {
      const res = await fetch(`/api/coach/occurrences?academyId=${academyId}`, { credentials: "same-origin" });
      if (res.status === 401) { onSessionExpired(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ status: "success", academyId, occurrences: data.occurrences ?? [] });
    } catch (err) {
      setState({ status: "error", academyId, message: err instanceof Error ? err.message : "Gagal memuat jadwal" });
    }
  }, [onSessionExpired]);

  useEffect(() => {
    if (effectiveAcademyId) void loadOccurrences(effectiveAcademyId);
  }, [effectiveAcademyId, loadOccurrences]);

  if (selected) {
    return (
      <CoachSessionDetail
        academyId={effectiveAcademyId}
        occurrence={selected}
        onBack={() => setSelected(null)}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  return (
    <div className="space-y-4">
      {coachMemberships.length > 1 && (
        <div className="flex items-center gap-2">
          <Label>Akademi:</Label>
          <select
            value={effectiveAcademyId}
            onChange={(e) => onSelectAcademy(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          >
            {coachMemberships.map((m) => (
              <option key={m.academyId} value={m.academyId}>{m.academyId.slice(0, 8)}</option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <CalendarDays className="h-5 w-5" aria-hidden /> Jadwal Latihan Saya
        </h2>
        <Button variant="outline" size="sm" onClick={() => void loadOccurrences(effectiveAcademyId)} className="gap-2">
          <RefreshCw className="h-4 w-4" aria-hidden /> Muat Ulang
        </Button>
      </div>

      {state.status === "loading" && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> Memuat…
        </div>
      )}
      {state.status === "error" && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" aria-hidden /> {state.message}
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.occurrences.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Belum ada sesi latihan yang ditugaskan untuk Anda.
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.occurrences.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {state.occurrences.map((occ) => {
            const dt = formatDateTime(occ.start_at);
            return (
              <Card
                key={occ.id}
                className="cursor-pointer transition-all hover:border-primary/40 hover:shadow-sm"
                onClick={() => setSelected(occ)}
              >
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{occ.class_name}</p>
                      <p className="text-sm text-muted-foreground">{dt.date} · {dt.time} WIB</p>
                    </div>
                    <Badge variant={occ.status === "completed" ? "secondary" : occ.status === "cancelled" ? "destructive" : "default"}>
                      {occ.status === "completed" ? "Selesai" : occ.status === "cancelled" ? "Dibatalkan" : "Terjadwal"}
                    </Badge>
                  </div>
                  <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                    <ClipboardList className="h-3 w-3" aria-hidden /> Kapasitas {occ.capacity} · klik untuk detail sesi
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// === Session detail (roster + attendance + plan) ==========================

function CoachSessionDetail({
  academyId,
  occurrence,
  onBack,
  onSessionExpired,
}: {
  academyId: string;
  occurrence: CoachOccurrence;
  onBack: () => void;
  onSessionExpired: () => void;
}) {
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [planTitle, setPlanTitle] = useState("");
  const [planContent, setPlanContent] = useState("");
  const [planVisible, setPlanVisible] = useState(false);
  const [planLoading, setPlanLoading] = useState(true);
  const [planSaving, setPlanSaving] = useState(false);
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  const [attendanceBusy, setAttendanceBusy] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    setRosterError(null);
    try {
      const res = await fetch(`/api/coach/occurrences/${occurrence.id}/roster?academyId=${academyId}`, { credentials: "same-origin" });
      if (res.status === 401) { onSessionExpired(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRoster(await res.json());
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : "Gagal memuat roster");
    }
  }, [academyId, occurrence.id, onSessionExpired]);

  const loadPlan = useCallback(async () => {
    setPlanLoading(true);
    try {
      const res = await fetch(`/api/coach/occurrences/${occurrence.id}/plan?academyId=${academyId}`, { credentials: "same-origin" });
      if (res.status === 401) { onSessionExpired(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const p: PlanDto | null = data.plan ?? null;
      setPlan(p);
      setPlanTitle(p?.title ?? "");
      setPlanContent(p?.content ?? "");
      setPlanVisible(p?.visibleToParents ?? false);
    } catch {
      setPlan(null);
    } finally {
      setPlanLoading(false);
    }
  }, [academyId, occurrence.id, onSessionExpired]);

  useEffect(() => {
    void loadRoster();
    void loadPlan();
  }, [loadRoster, loadPlan]);

  const markAttendance = async (studentId: string, status: "present" | "absent" | "excused") => {
    setAttendanceBusy(studentId);
    try {
      const res = await fetch(`/api/coach/occurrences/${occurrence.id}/attendance?academyId=${academyId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: csrfToken() },
        body: JSON.stringify({ studentId, status }),
      });
      if (res.status === 401) { onSessionExpired(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadRoster();
    } finally {
      setAttendanceBusy(null);
    }
  };

  const savePlan = async () => {
    setPlanSaving(true);
    setPlanMessage(null);
    try {
      const res = await fetch(`/api/coach/occurrences/${occurrence.id}/plan?academyId=${academyId}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: csrfToken() },
        body: JSON.stringify({ title: planTitle, content: planContent, visibleToParents: planVisible }),
      });
      if (res.status === 401) { onSessionExpired(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlan(data.plan);
      setPlanMessage("Rencana latihan tersimpan.");
    } catch (err) {
      setPlanMessage(err instanceof Error ? `Gagal menyimpan: ${err.message}` : "Gagal menyimpan");
    } finally {
      setPlanSaving(false);
    }
  };

  const dt = formatDateTime(occurrence.start_at);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali
        </Button>
        <div>
          <h2 className="text-lg font-semibold">{occurrence.class_name}</h2>
          <p className="text-sm text-muted-foreground">{dt.date} · {dt.time} WIB</p>
        </div>
      </div>

      {/* Roster + attendance */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Roster &amp; Kehadiran</CardTitle>
          <CardDescription>Tandai kehadiran siswa untuk sesi ini.</CardDescription>
        </CardHeader>
        <CardContent>
          {rosterError && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" aria-hidden /> {rosterError}
            </p>
          )}
          {!rosterError && !roster && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memuat roster…
            </div>
          )}
          {roster && roster.roster.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">Belum ada siswa terdaftar pada sesi ini.</p>
          )}
          {roster && roster.roster.length > 0 && (
            <ul className="divide-y">
              {roster.roster.map((entry) => {
                const label = entry.attendance_status ? attendanceLabel(entry.attendance_status) : null;
                return (
                  <li key={entry.student_id} className="flex items-center justify-between gap-2 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{entry.full_name}</span>
                      {label && <Badge variant={label.variant}>{label.label}</Badge>}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm" variant="outline" disabled={attendanceBusy === entry.student_id}
                        onClick={() => void markAttendance(entry.student_id, "present")}
                        className="gap-1"
                      >
                        <Check className="h-3 w-3" aria-hidden /> Hadir
                      </Button>
                      <Button
                        size="sm" variant="outline" disabled={attendanceBusy === entry.student_id}
                        onClick={() => void markAttendance(entry.student_id, "excused")}
                        className="gap-1"
                      >
                        <MinusCircle className="h-3 w-3" aria-hidden /> Izin
                      </Button>
                      <Button
                        size="sm" variant="outline" disabled={attendanceBusy === entry.student_id}
                        onClick={() => void markAttendance(entry.student_id, "absent")}
                        className="gap-1"
                      >
                        <X className="h-3 w-3" aria-hidden /> Absen
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Training plan editor */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rencana Latihan</CardTitle>
          <CardDescription>
            Tulis rencana latihan untuk sesi ini. Aktifkan &ldquo;Tampil ke orang tua&rdquo; agar orang tua siswa
            yang terdaftar dapat melihatnya di portal mereka (opsional).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {planLoading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memuat rencana…
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor="plan-title">Judul</Label>
                <Input
                  id="plan-title"
                  value={planTitle}
                  onChange={(e) => setPlanTitle(e.target.value)}
                  placeholder="cth. Penguatan passing & kontrol bola"
                  maxLength={200}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="plan-content">Isi rencana</Label>
                <Textarea
                  id="plan-content"
                  value={planContent}
                  onChange={(e) => setPlanContent(e.target.value)}
                  placeholder={"1. Pemanasan 10 menit\n2. Drill passing berpasangan\n3. Small-sided game"}
                  rows={8}
                  maxLength={10000}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch id="plan-visible" checked={planVisible} onCheckedChange={setPlanVisible} />
                <Label htmlFor="plan-visible" className="flex items-center gap-1">
                  <Eye className="h-4 w-4" aria-hidden /> Tampil ke orang tua
                </Label>
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={() => void savePlan()} disabled={planSaving || !planTitle.trim() || !planContent.trim()} className="gap-2">
                  {planSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                  Simpan Rencana
                </Button>
                {planMessage && <span className="text-sm text-muted-foreground">{planMessage}</span>}
                {plan && !planMessage && (
                  <span className="text-xs text-muted-foreground">
                    Tersimpan {formatDateTime(plan.updatedAt).date}
                  </span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
