"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  FileText,
  AlertCircle,
  Loader2,
  RefreshCw,
  Users,
  ClipboardCheck,
  Wallet,
  TrendingUp,
  TrendingDown,
  Calendar,
  Download,
  CheckCircle2,
  XCircle,
  Clock,
  UserX,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ============================================================================
// Types
// ============================================================================

interface StudentRosterEntry {
  studentId: string;
  fullName: string;
  dateOfBirth: Date | string | null;
  gender: string | null;
  archivedAt: Date | string | null;
  currentClassName: string | null;
  currentClassId: string | null;
  packageCount: number;
  activeEntitlements: number;
  completedEntitlements: number;
  awaitingMakeupEntitlements: number;
  lastAttendedDate: string | null;
  lastAttendedStatus: string | null;
}

interface StudentRosterReport {
  students: StudentRosterEntry[];
  totalStudents: number;
  activeStudents: number;
  archivedStudents: number;
}

interface AttendanceReportEntry {
  attendanceId: string;
  occurrenceDate: string;
  className: string;
  startAt: string;
  status: string;
  notes: string | null;
  recordedAt: string;
}

interface AttendanceReportSummary {
  total: number;
  present: number;
  absent: number;
  excused: number;
  late: number;
  attendanceRate: number;
}

interface PerStudentAttendanceReport {
  studentId: string;
  studentName: string;
  records: AttendanceReportEntry[];
  summary: AttendanceReportSummary;
}

interface FinanceReportPayment {
  paymentId: string;
  studentName: string;
  amount: string;
  paymentDate: string;
  paymentMethod: string;
  status: string;
  packageName: string | null;
}

interface FinanceReportExpense {
  expenseId: string;
  amount: string;
  category: string;
  incurredOn: string;
  note: string | null;
}

interface FinanceReportSummary {
  totalIncome: string;
  totalExpenses: string;
  net: string;
  paymentCount: number;
  expenseCount: number;
  byMethod: { method: string; count: number; total: string }[];
  byCategory: { category: string; count: number; total: string }[];
}

interface MonthlyFinanceReport {
  fromDate: string;
  toDate: string;
  payments: FinanceReportPayment[];
  expenses: FinanceReportExpense[];
  summary: FinanceReportSummary;
}

interface Student {
  id: string;
  full_name: string;
}

type SubSection = "students" | "attendance" | "finance";

type LoadingState = "loading" | "error" | "success";

// ============================================================================
// Helpers
// ============================================================================

function jakartaTodayYmd(): string {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function jakartaMonthStart(): string {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function formatRupiah(amountStr: string): string {
  const n = Number(amountStr);
  if (Number.isNaN(n)) return `Rp ${amountStr}`;
  return `Rp ${n.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
}

function formatDate(ymd: string | null): string {
  if (!ymd) return "—";
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

const STATUS_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  present: { label: "Hadir", icon: CheckCircle2, color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" },
  absent: { label: "Tidak Hadir", icon: XCircle, color: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400" },
  late: { label: "Terlambat", icon: Clock, color: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400" },
  excused: { label: "Izin", icon: UserX, color: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400" },
};

// ============================================================================
// Main component
// ============================================================================

export function ReportsManagement({ academyId }: { academyId: string }) {
  const [sub, setSub] = useState<SubSection>("students");

  const subTabs: { id: SubSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "students", label: "Daftar Siswa", icon: Users },
    { id: "attendance", label: "Kehadiran", icon: ClipboardCheck },
    { id: "finance", label: "Keuangan", icon: Wallet },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">Laporan</h3>
          <p className="text-xs text-muted-foreground">
            Lihat laporan seluruh akademi: daftar siswa, kehadiran per siswa, dan ringkasan keuangan bulanan.
          </p>
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label="Jenis laporan">
        {subTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={sub === tab.id}
              onClick={() => setSub(tab.id)}
              className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                sub === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden /> {tab.label}
            </button>
          );
        })}
      </div>

      {/* Sub-section content */}
      {sub === "students" && <StudentRosterReport academyId={academyId} />}
      {sub === "attendance" && <AttendanceReport academyId={academyId} />}
      {sub === "finance" && <FinanceReport academyId={academyId} />}
    </div>
  );
}

// ============================================================================
// Student Roster Report
// ============================================================================

function StudentRosterReport({ academyId }: { academyId: string }) {
  const [state, setState] = useState<{ status: LoadingState; data?: StudentRosterReport; error?: string }>({ status: "loading" });
  const [search, setSearch] = useState("");
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchReport/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchReport = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/reports/students?academyId=${aid}`, { credentials: "same-origin" });
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        setState({ status: "error", error: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      const data = (await res.json()) as StudentRosterReport;
      setState({ status: "success", data });
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", error: "Kesalahan jaringan" });
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/reports/students?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok) {
          const data = (await res.json()) as { error?: { message?: string } };
          setState({ status: "error", error: data.error?.message ?? `Error ${res.status}` });
          return;
        }
        const data = (await res.json()) as StudentRosterReport;
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setState({ status: "success", data });
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setState({ status: "error", error: "Kesalahan jaringan" });
      }
    })();
    return () => { cancelled = true; };
  }, [academyId]);

  const filteredStudents = state.data?.students.filter((s) =>
    s.fullName.toLowerCase().includes(search.toLowerCase()),
  ) ?? [];

  if (state.status === "loading") return <LoadingCard text="Memuat daftar siswa…" />;
  if (state.status === "error") return <ErrorCard message={state.error!} onRetry={fetchReport} />;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Total Siswa" value={state.data!.totalStudents} icon={Users} color="primary" />
        <SummaryCard label="Aktif" value={state.data!.activeStudents} icon={CheckCircle2} color="emerald" />
        <SummaryCard label="Diarsipkan" value={state.data!.archivedStudents} icon={XCircle} color="muted" />
      </div>

      {/* Search + refresh + export */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Cari siswa…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={fetchReport} className="gap-2">
          <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadStudentRosterCSV(filteredStudents)}
          disabled={filteredStudents.length === 0}
          className="gap-2"
        >
          <Download className="h-4 w-4" aria-hidden /> CSV
        </Button>
      </div>

      {/* Table */}
      {filteredStudents.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Users className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">{search ? "Tidak ada siswa yang cocok" : "Belum ada siswa"}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[600px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Siswa</TableHead>
                    <TableHead>Kelas</TableHead>
                    <TableHead className="text-center">Paket</TableHead>
                    <TableHead className="text-center">Aktif</TableHead>
                    <TableHead className="text-center">Selesai</TableHead>
                    <TableHead className="text-center">Susulan</TableHead>
                    <TableHead>Kehadiran Terakhir</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredStudents.map((s) => (
                    <TableRow key={s.studentId}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            {s.fullName.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium">{s.fullName}</p>
                            {s.archivedAt && <Badge variant="outline" className="text-xs">Diarsipkan</Badge>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{s.currentClassName ?? "—"}</TableCell>
                      <TableCell className="text-center">{s.packageCount}</TableCell>
                      <TableCell className="text-center">
                        {s.activeEntitlements > 0 ? (
                          <Badge variant="secondary">{s.activeEntitlements}</Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        {s.completedEntitlements > 0 ? (
                          <Badge variant="secondary">{s.completedEntitlements}</Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        {s.awaitingMakeupEntitlements > 0 ? (
                          <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                            {s.awaitingMakeupEntitlements}
                          </Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        {s.lastAttendedDate ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs">{formatDate(s.lastAttendedDate)}</span>
                            {s.lastAttendedStatus && STATUS_META[s.lastAttendedStatus] && (
                              <Badge variant="outline" className={`text-xs ${STATUS_META[s.lastAttendedStatus]!.color}`}>
                                {STATUS_META[s.lastAttendedStatus]!.label}
                              </Badge>
                            )}
                          </div>
                        ) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================================
// Attendance Report
// ============================================================================

function AttendanceReport({ academyId }: { academyId: string }) {
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [report, setReport] = useState<PerStudentAttendanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchReport/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  //
  // Note: this component's report-fetch useEffect (below) delegates to
  // fetchReport directly (`void fetchReport()`) rather than duplicating
  // the fetch logic in an IIFE — so only the useCallback needs the guard.
  // The students-list useEffect IIFE below fetches a DIFFERENT resource
  // (/api/admin/students) and does not race with fetchReport, so it is
  // left unchanged.
  const requestIdRef = useRef(0);

  // Load students list.
  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/students?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled) return;
        const data = (await res.json()) as { students?: Student[] };
        if (cancelled) return;
        setStudents(data.students ?? []);
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [academyId]);

  const fetchReport = useCallback(async () => {
    if (!selectedStudentId) return;
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/reports/attendance?academyId=${aid}&studentId=${selectedStudentId}`,
        { credentials: "same-origin" },
      );
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        setError(data.error?.message ?? `Error ${res.status}`);
        return;
      }
      const data = (await res.json()) as PerStudentAttendanceReport;
      setReport(data);
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setError("Kesalahan jaringan");
    } finally {
      setLoading(false);
    }
  }, [academyId, selectedStudentId]);

  useEffect(() => {
    if (selectedStudentId) void fetchReport();
    else setReport(null);
  }, [fetchReport, selectedStudentId]);

  return (
    <div className="space-y-4">
      {/* Student selector */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-2">
              <Label htmlFor="report-student">Pilih Siswa</Label>
              <Select value={selectedStudentId} onValueChange={setSelectedStudentId}>
                <SelectTrigger id="report-student">
                  <SelectValue placeholder="Pilih siswa…" />
                </SelectTrigger>
                <SelectContent>
                  {students.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={fetchReport} disabled={!selectedStudentId || loading} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Segarkan
            </Button>
          </div>
        </CardContent>
      </Card>

      {!selectedStudentId && (
        <Card>
          <CardContent className="p-8 text-center">
            <ClipboardCheck className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">Pilih siswa untuk melihat laporan kehadirannya</p>
          </CardContent>
        </Card>
      )}

      {error && <ErrorCard message={error} onRetry={fetchReport} />}

      {report && (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryCard label="Total" value={report.summary.total} icon={Calendar} color="primary" />
            <SummaryCard label="Hadir" value={report.summary.present} icon={CheckCircle2} color="emerald" />
            <SummaryCard label="Terlambat" value={report.summary.late} icon={Clock} color="amber" />
            <SummaryCard label="Tidak Hadir" value={report.summary.absent} icon={XCircle} color="rose" />
            <SummaryCard label="Izin" value={report.summary.excused} icon={UserX} color="sky" />
            <SummaryCard label="Tingkat" value={`${report.summary.attendanceRate}%`} icon={TrendingUp} color={report.summary.attendanceRate >= 75 ? "emerald" : "rose"} />
          </div>

          {/* Attendance history table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Riwayat Kehadiran — {report.studentName}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {report.records.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Belum ada catatan kehadiran.</p>
              ) : (
                <div className="max-h-[500px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tanggal</TableHead>
                        <TableHead>Kelas</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Catatan</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.records.map((r) => (
                        <TableRow key={r.attendanceId}>
                          <TableCell className="font-medium">{formatDate(r.occurrenceDate)}</TableCell>
                          <TableCell>{r.className}</TableCell>
                          <TableCell>
                            {STATUS_META[r.status] && (
                              <Badge variant="outline" className={STATUS_META[r.status]!.color}>
                                {STATUS_META[r.status]!.label}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{r.notes ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Finance Report
// ============================================================================

function FinanceReport({ academyId }: { academyId: string }) {
  const [fromDate, setFromDate] = useState(jakartaMonthStart());
  const [toDate, setToDate] = useState(jakartaTodayYmd());
  const [report, setReport] = useState<MonthlyFinanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchReport/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchReport = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/reports/finance?academyId=${aid}&fromDate=${fromDate}&toDate=${toDate}`,
        { credentials: "same-origin" },
      );
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        setError(data.error?.message ?? `Error ${res.status}`);
        return;
      }
      const data = (await res.json()) as MonthlyFinanceReport;
      setReport(data);
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setError("Kesalahan jaringan");
    } finally {
      setLoading(false);
    }
  }, [academyId, fromDate, toDate]);

  useEffect(() => {
    if (!academyId || !fromDate || !toDate) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/reports/finance?academyId=${academyId}&fromDate=${fromDate}&toDate=${toDate}`,
          { credentials: "same-origin" },
        );
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok) {
          const data = (await res.json()) as { error?: { message?: string } };
          setError(data.error?.message ?? `Error ${res.status}`);
          return;
        }
        const data = (await res.json()) as MonthlyFinanceReport;
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setReport(data);
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setError("Kesalahan jaringan");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [academyId, fromDate, toDate]);

  if (loading && !report) return <LoadingCard text="Memuat laporan keuangan…" />;
  if (error && !report) return <ErrorCard message={error} onRetry={fetchReport} />;

  return (
    <div className="space-y-4">
      {/* Date range selector */}
      <Card>
        <CardContent className="flex items-end gap-3 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="finance-from" className="text-xs text-muted-foreground">Dari</Label>
            <Input id="finance-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-36" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="finance-to" className="text-xs text-muted-foreground">Sampai</Label>
            <Input id="finance-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-36" />
          </div>
          <Button variant="outline" size="sm" onClick={fetchReport} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            Segarkan
          </Button>
          {report && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadFinanceCSV(report.payments, report.expenses, fromDate, toDate)}
              disabled={report.payments.length === 0 && report.expenses.length === 0}
              className="gap-2"
            >
              <Download className="h-4 w-4" aria-hidden /> CSV
            </Button>
          )}
        </CardContent>
      </Card>

      {report && (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label="Pemasukan"
              value={formatRupiah(report.summary.totalIncome)}
              icon={TrendingUp}
              color="emerald"
              subtitle={`${report.summary.paymentCount} pembayaran`}
            />
            <SummaryCard
              label="Pengeluaran"
              value={formatRupiah(report.summary.totalExpenses)}
              icon={TrendingDown}
              color="rose"
              subtitle={`${report.summary.expenseCount} pengeluaran`}
            />
            <SummaryCard
              label="Bersih"
              value={formatRupiah(report.summary.net)}
              icon={Wallet}
              color={Number(report.summary.net) >= 0 ? "emerald" : "rose"}
              subtitle={Number(report.summary.net) >= 0 ? "Surplus" : "Defisit"}
            />
            <SummaryCard
              label="Periode"
              value={`${formatDate(report.fromDate).slice(0, 6)}→${formatDate(report.toDate).slice(0, 6)}`}
              icon={Calendar}
              color="primary"
              subtitle={report.fromDate === report.toDate ? "1 hari" : `${Math.round((new Date(report.toDate).getTime() - new Date(report.fromDate).getTime()) / 86400000) + 1} hari`}
            />
          </div>

          {/* Breakdown cards */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* By method */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Pemasukan per Metode Pembayaran</CardTitle>
              </CardHeader>
              <CardContent>
                {report.summary.byMethod.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Tidak ada pemasukan pada periode ini.</p>
                ) : (
                  <div className="space-y-2">
                    {report.summary.byMethod.map((m) => (
                      <div key={m.method} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="capitalize">{m.method.replace("_", " ")}</Badge>
                          <span className="text-xs text-muted-foreground">{m.count} pembayaran</span>
                        </div>
                        <span className="font-medium tabular-nums">{formatRupiah(m.total)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* By category */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Pengeluaran per Kategori</CardTitle>
              </CardHeader>
              <CardContent>
                {report.summary.byCategory.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Tidak ada pengeluaran pada periode ini.</p>
                ) : (
                  <div className="space-y-2">
                    {report.summary.byCategory.map((c) => (
                      <div key={c.category} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={c.category.toLowerCase() === "refund" ? "border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-400" : ""}>
                            {c.category}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{c.count} item</span>
                        </div>
                        <span className="font-medium tabular-nums">{formatRupiah(c.total)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Payments table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pembayaran ({report.payments.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {report.payments.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Tidak ada pembayaran pada periode ini.</p>
              ) : (
                <div className="max-h-[400px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tanggal</TableHead>
                        <TableHead>Siswa</TableHead>
                        <TableHead>Metode</TableHead>
                        <TableHead>Paket</TableHead>
                        <TableHead className="text-right">Jumlah</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.payments.map((p) => (
                        <TableRow key={p.paymentId}>
                          <TableCell className="text-sm">{formatDate(p.paymentDate)}</TableCell>
                          <TableCell className="font-medium">{p.studentName}</TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="capitalize">{p.paymentMethod.replace("_", " ")}</Badge>
                          </TableCell>
                          <TableCell className="text-sm">{p.packageName ?? "—"}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatRupiah(p.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Expenses table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pengeluaran ({report.expenses.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {report.expenses.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Tidak ada pengeluaran pada periode ini.</p>
              ) : (
                <div className="max-h-[400px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tanggal</TableHead>
                        <TableHead>Kategori</TableHead>
                        <TableHead>Catatan</TableHead>
                        <TableHead className="text-right">Jumlah</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.expenses.map((e) => (
                        <TableRow key={e.expenseId}>
                          <TableCell className="text-sm">{formatDate(e.incurredOn)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={e.category.toLowerCase() === "refund" ? "border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-400" : ""}>
                              {e.category}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{e.note ?? "—"}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatRupiah(e.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Shared components
// ============================================================================

function LoadingCard({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{text}</p>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="p-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
          <div>
            <p className="text-sm font-medium text-destructive">Gagal memuat laporan</p>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
            <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={onRetry}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// CSV Export Helpers
// ============================================================================

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote if contains comma, quote, or newline.
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCSV(filename: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map(escapeCSV).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function downloadStudentRosterCSV(students: StudentRosterEntry[]): void {
  const headers = ["Siswa", "Kelas", "Paket", "Paket Aktif", "Selesai", "Menunggu Susulan", "Kehadiran Terakhir", "Status Terakhir"];
  const rows: string[][] = students.map((s) => [
    s.fullName,
    s.currentClassName ?? "",
    String(s.packageCount),
    String(s.activeEntitlements),
    String(s.completedEntitlements),
    String(s.awaitingMakeupEntitlements),
    s.lastAttendedDate ?? "",
    s.lastAttendedStatus ?? "",
  ]);
  downloadCSV(`student-roster-${new Date().toISOString().split("T")[0]}.csv`, [headers, ...rows]);
}

function downloadFinanceCSV(payments: FinanceReportPayment[], expenses: FinanceReportExpense[], fromDate: string, toDate: string): void {
  // Two sections: payments then expenses, separated by a blank row.
  const paymentHeaders = ["Tipe", "Tanggal", "Siswa/Kategori", "Metode/Catatan", "Paket", "Status", "Jumlah"];
  const paymentRows = payments.map((p) => [
    "Pembayaran",
    p.paymentDate,
    p.studentName,
    p.paymentMethod,
    p.packageName ?? "",
    p.status,
    p.amount,
  ]);
  const expenseHeaders = ["Tipe", "Tanggal", "Siswa/Kategori", "Metode/Catatan", "Paket", "Status", "Jumlah"];
  const expenseRows = expenses.map((e) => [
    "Pengeluaran",
    e.incurredOn,
    e.category,
    e.note ?? "",
    "",
    "",
    e.amount,
  ]);
  downloadCSV(`finance-report-${fromDate}-to-${toDate}.csv`, [
    paymentHeaders,
    ...paymentRows,
    [], // blank separator row
    expenseHeaders,
    ...expenseRows,
  ]);
}

// ============================================================================
// Shared components
// ============================================================================

function SummaryCard({
  label,
  value,
  icon: Icon,
  color,
  subtitle,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  color: "emerald" | "rose" | "primary" | "amber" | "sky" | "muted";
  subtitle?: string;
}) {
  const colors: Record<typeof color, string> = {
    emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
    rose: "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400",
    primary: "bg-primary/10 text-primary",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
    sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <div className={`flex h-7 w-7 items-center justify-center rounded-md ${colors[color]}`}>
            <Icon className="h-4 w-4" aria-hidden />
          </div>
        </div>
        <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}
