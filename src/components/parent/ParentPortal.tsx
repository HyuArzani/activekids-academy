"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Users, RefreshCw, Loader2, AlertCircle, ArrowLeft, CalendarDays, Package, ClipboardCheck, FileText, Video } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime } from "@/lib/parent-ui/format";
import { ChildSchedule } from "./ChildSchedule";
import { ChildPackages } from "./ChildPackages";
import { ChildAttendance } from "./ChildAttendance";
import { ChildReports } from "./ChildReports";
import { ChildVideos } from "./ChildVideos";

// === Types (match the API response shapes) ===============================

interface ChildSummary {
  studentId: string;
  fullName: string;
  className: string | null;
  classId: string | null;
  enrollmentActive: boolean;
}

interface DashboardSummary {
  childrenCount: number;
  children: ChildSummary[];
  upcomingSessions: { studentId: string; studentName: string; occurrenceDate: string; startAt: string; className: string }[];
  recentAttendance: { studentId: string; studentName: string; occurrenceDate: string; status: string }[];
  activePackages: { studentId: string; studentName: string; packageName: string; sessionCount: number; activeEntitlements: number }[];
  availableReports: { studentId: string; studentName: string; semesterName: string; reportId: string }[];
}

type LoadState =
  | { status: "loading"; academyId: string }
  | { status: "success"; academyId: string; data: DashboardSummary }
  | { status: "error"; academyId: string; message: string };

type ChildTab = "schedule" | "packages" | "attendance" | "reports" | "videos";

// === Main component =======================================================

interface ParentPortalProps {
  memberships: { academyId: string; role: string }[];
  selectedAcademyId: string;
  onSelectAcademy: (academyId: string) => void;
  onSessionExpired: () => void;
}

export function ParentPortal({ memberships, selectedAcademyId, onSelectAcademy, onSessionExpired }: ParentPortalProps) {
  const parentMemberships = memberships.filter((m) => m.role === "parent");
  const [state, setState] = useState<LoadState>({ status: "loading", academyId: selectedAcademyId });
  // Track which academy the child selection belongs to. When the academy
  // changes, the selection is automatically invalidated (derived, not
  // imperative — avoids cascading-render setState-in-effect).
  const [selectedStudent, setSelectedStudent] = useState<{ studentId: string; academyId: string } | null>(null);
  const [activeTab, setActiveTab] = useState<ChildTab>("schedule");
  // The selected student is only valid for the current academy.
  const selectedStudentId = selectedStudent?.academyId === selectedAcademyId ? selectedStudent.studentId : null;

  const selectedAcademyIdRef = useRef(selectedAcademyId);
  useEffect(() => {
    selectedAcademyIdRef.current = selectedAcademyId;
  }, [selectedAcademyId]);

  const fetchSummary = useCallback(async (academyId: string) => {
    setState({ status: "loading", academyId });
    try {
      const res = await fetch(`/api/parent/dashboard/summary?academyId=${academyId}`, {
        credentials: "same-origin",
      });
      if (res.status === 401) {
        onSessionExpired();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } } & Partial<DashboardSummary>;
      if (academyId !== selectedAcademyIdRef.current) return;
      if (!res.ok || data.childrenCount === undefined) {
        setState({ status: "error", academyId, message: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      setState({ status: "success", academyId, data: data as DashboardSummary });
    } catch {
      if (academyId !== selectedAcademyIdRef.current) return;
      setState({ status: "error", academyId, message: "Kesalahan jaringan — tidak dapat terhubung ke server" });
    }
  }, [onSessionExpired]);

  // Initial load + reload when academy changes.
  useEffect(() => {
    if (!selectedAcademyId) return;
    let cancelled = false;
    const academyId = selectedAcademyId;
    void (async () => {
      try {
        const res = await fetch(`/api/parent/dashboard/summary?academyId=${academyId}`, {
          credentials: "same-origin",
        });
        if (cancelled) return;
        if (res.status === 401) {
          if (!cancelled) onSessionExpired();
          return;
        }
        const data = (await res.json()) as { error?: { message?: string } } & Partial<DashboardSummary>;
        if (cancelled) return;
        if (!res.ok || data.childrenCount === undefined) {
          setState({ status: "error", academyId, message: data.error?.message ?? `Error ${res.status}` });
          return;
        }
        setState({ status: "success", academyId, data: data as DashboardSummary });
      } catch {
        if (cancelled) return;
        setState({ status: "error", academyId, message: "Kesalahan jaringan — tidak dapat terhubung ke server" });
      }
    })();
    return () => { cancelled = true; };
  }, [selectedAcademyId, onSessionExpired]);

  const isStale = state.academyId !== selectedAcademyId;
  const showLoading = state.status === "loading" || isStale;
  const showError = !isStale && state.status === "error";
  const showSuccess = !isStale && state.status === "success" && state.data;

  // === Child detail view ===
  if (selectedStudentId && showSuccess && state.data) {
    const child = state.data.children.find((c) => c.studentId === selectedStudentId);
    if (child) {
      return (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setSelectedStudent(null)} className="gap-2">
              <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali
            </Button>
            <div>
              <h2 className="text-lg font-semibold">{child.fullName}</h2>
              <p className="text-sm text-muted-foreground">{child.className ?? "Kelas belum ditentukan"}</p>
            </div>
          </div>

          {/* Tab navigation */}
          <div className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label="Bagian anak">
            <TabButton active={activeTab === "schedule"} onClick={() => setActiveTab("schedule")} icon={CalendarDays} label="Jadwal" />
            <TabButton active={activeTab === "packages"} onClick={() => setActiveTab("packages")} icon={Package} label="Paket" />
            <TabButton active={activeTab === "attendance"} onClick={() => setActiveTab("attendance")} icon={ClipboardCheck} label="Kehadiran" />
            <TabButton active={activeTab === "reports"} onClick={() => setActiveTab("reports")} icon={FileText} label="Laporan" />
            <TabButton active={activeTab === "videos"} onClick={() => setActiveTab("videos")} icon={Video} label="Video" />
          </div>

          {/* Tab content */}
          <div className="min-h-[200px]">
            {activeTab === "schedule" && (
              <ChildSchedule studentId={child.studentId} academyId={selectedAcademyId} onSessionExpired={onSessionExpired} />
            )}
            {activeTab === "packages" && (
              <ChildPackages studentId={child.studentId} academyId={selectedAcademyId} onSessionExpired={onSessionExpired} />
            )}
            {activeTab === "attendance" && (
              <ChildAttendance studentId={child.studentId} academyId={selectedAcademyId} onSessionExpired={onSessionExpired} />
            )}
            {activeTab === "reports" && (
              <ChildReports studentId={child.studentId} academyId={selectedAcademyId} onSessionExpired={onSessionExpired} />
            )}
            {activeTab === "videos" && (
              <ChildVideos studentId={child.studentId} academyId={selectedAcademyId} onSessionExpired={onSessionExpired} />
            )}
          </div>
        </div>
      );
    }
  }

  // === Overview / dashboard view ===
  return (
    <div className="space-y-4">
      {/* Academy selector (if multiple) */}
      {parentMemberships.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor="parent-academy-select" className="text-xs text-muted-foreground">Akademi</Label>
          <Select value={selectedAcademyId} onValueChange={onSelectAcademy}>
            <SelectTrigger id="parent-academy-select" className="w-full sm:w-72">
              <SelectValue placeholder="Pilih akademi" />
            </SelectTrigger>
            <SelectContent>
              {parentMemberships.map((m) => (
                <SelectItem key={m.academyId} value={m.academyId}>
                  Akademi {m.academyId.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showLoading && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat dashboard…</p>
          </CardContent>
        </Card>
      )}

      {showError && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1">
                <p className="text-sm font-medium text-destructive">{(state as { message: string }).message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={() => fetchSummary(selectedAcademyId)}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {showSuccess && state.data && (
        <ParentOverview
          data={state.data}
          onSelectChild={(id) => { setSelectedStudent({ studentId: id, academyId: selectedAcademyId }); setActiveTab("schedule"); }}
        />
      )}
    </div>
  );
}

// === Tab button sub-component ============================================

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden /> {label}
    </button>
  );
}

// === Overview dashboard sub-component ====================================

function ParentOverview({ data, onSelectChild }: { data: DashboardSummary; onSelectChild: (studentId: string) => void }) {
  if (data.childrenCount === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <Users className="h-10 w-10 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-base font-medium">Belum ada anak terdaftar</p>
            <p className="text-sm text-muted-foreground mt-1">
              Hubungi akademi untuk mendaftarkan anak Anda dan menghubungkannya ke akun ini.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Children cards */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">Anak Saya</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {data.children.map((child) => (
            <Card key={child.studentId} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onSelectChild(child.studentId)}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{child.fullName}</p>
                    <p className="text-sm text-muted-foreground">{child.className ?? "Kelas belum ditentukan"}</p>
                  </div>
                  {child.enrollmentActive ? (
                    <Badge variant="default">Aktif</Badge>
                  ) : (
                    <Badge variant="outline">Tidak Aktif</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Upcoming sessions */}
      {data.upcomingSessions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="h-4 w-4" aria-hidden /> Sesi Mendatang
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.upcomingSessions.slice(0, 5).map((s, i) => {
              const dt = formatDateTime(s.startAt);
              return (
                <div key={i} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.studentName}</p>
                    <p className="text-muted-foreground truncate">{s.className}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="font-medium">{dt.date}</p>
                    <p className="text-muted-foreground">{dt.time}</p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Recent attendance */}
      {data.recentAttendance.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4" aria-hidden /> Kehadiran Terbaru
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.recentAttendance.slice(0, 5).map((a, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{a.studentName}</span>
                <Badge variant={a.status === "present" ? "default" : a.status === "excused" ? "outline" : "destructive"}>
                  {a.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Active packages */}
      {data.activePackages.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" aria-hidden /> Paket Aktif
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.activePackages.slice(0, 5).map((p, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.studentName}</p>
                  <p className="text-muted-foreground truncate">{p.packageName}</p>
                </div>
                <Badge variant="secondary">{p.activeEntitlements} sesi aktif</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Available reports */}
      {data.availableReports.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" aria-hidden /> Laporan Tersedia
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.availableReports.slice(0, 5).map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{r.studentName}</span>
                <Badge variant="outline">{r.semesterName}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
