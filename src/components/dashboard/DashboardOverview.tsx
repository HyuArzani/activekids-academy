"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Users,
  UserPlus,
  CalendarDays,
  ClipboardCheck,
  Package,
  PackageCheck,
  AlertCircle,
  Clock,
  CalendarClock,
  Wallet,
  TrendingDown,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatRupiah } from "@/lib/format/rupiah";

// === Types (match the API response) =====================================

interface DashboardSummary {
  today: string;
  monthStart: string;
  monthEnd: string;
  students: { currentlyEnrolled: number; startingToday: number };
  sessions: {
    scheduledToday: number;
    attendanceToday: { present: number; absent: number; excused: number; late: number };
  };
  packages: { withUsableSessions: number; exhausted: number };
  entitlements: { awaitingMakeup: number; unassignedActive: number };
  finances: { monthPaymentTotal: string; monthExpenseTotal: string };
}

type LoadState =
  | { status: "loading"; academyId: string }
  | { status: "success"; academyId: string; data: DashboardSummary }
  | { status: "error"; academyId: string; message: string };

// === Metric card sub-component ==========================================

interface MetricCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  hint?: string;
  variant?: "default" | "warning" | "success";
}

function MetricCard({ icon: Icon, label, value, hint, variant = "default" }: MetricCardProps) {
  const variantStyles = {
    default: "text-foreground",
    warning: "text-amber-600 dark:text-amber-400",
    success: "text-emerald-600 dark:text-emerald-400",
  };
  const iconBg = {
    default: "bg-primary/10 text-primary",
    warning: "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400",
    success: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400",
  };
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
            <p
              className={`mt-1 text-xl font-semibold tabular-nums sm:text-2xl ${variantStyles[variant]}`}
            >
              {value}
            </p>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          </div>
          <div className={`rounded-lg p-2 ${iconBg[variant]}`}>
            <Icon className="h-5 w-5" aria-hidden />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// === Section wrapper ====================================================

function SectionCard({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description?: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base sm:text-lg">{title}</CardTitle>
            {description && <CardDescription className="text-xs sm:text-sm">{description}</CardDescription>}
          </div>
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// === Main dashboard component ===========================================

interface DashboardOverviewProps {
  memberships: { academyId: string; role: string }[];
  selectedAcademyId: string;
  onSelectAcademy: (academyId: string) => void;
}

export function DashboardOverview({
  memberships,
  selectedAcademyId,
  onSelectAcademy,
}: DashboardOverviewProps) {
  const adminMemberships = memberships.filter((m) => m.role === "admin");
  const [state, setState] = useState<LoadState>({
    status: "loading",
    academyId: selectedAcademyId,
  });

  const selectedAcademyIdRef = useRef(selectedAcademyId);
  useEffect(() => {
    selectedAcademyIdRef.current = selectedAcademyId;
  }, [selectedAcademyId]);

  const handleRetry = useCallback(async () => {
    const academyId = selectedAcademyId;
    if (!academyId) return;
    setState({ status: "loading", academyId });
    try {
      const res = await fetch(`/api/admin/dashboard/summary?academyId=${academyId}`, {
        credentials: "same-origin",
      });
      const data = (await res.json()) as { error?: { message?: string } } & Partial<DashboardSummary>;
      if (academyId !== selectedAcademyIdRef.current) return;
      if (!res.ok || !data.today) {
        setState({
          status: "error",
          academyId,
          message: data.error?.message ?? `Kesalahan ${res.status}: gagal memuat dasbor`,
        });
        return;
      }
      setState({ status: "success", academyId, data: data as DashboardSummary });
    } catch {
      if (academyId !== selectedAcademyIdRef.current) return;
      setState({ status: "error", academyId, message: "Kesalahan jaringan — tidak dapat menjangkau server" });
    }
  }, [selectedAcademyId]);

  useEffect(() => {
    if (!selectedAcademyId) return;
    let cancelled = false;
    const academyId = selectedAcademyId;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/dashboard/summary?academyId=${academyId}`, {
          credentials: "same-origin",
        });
        if (cancelled) return;
        const data = (await res.json()) as { error?: { message?: string } } & Partial<DashboardSummary>;
        if (cancelled) return;
        if (!res.ok || !data.today) {
          setState({
            status: "error",
            academyId,
            message: data.error?.message ?? `Kesalahan ${res.status}: gagal memuat dasbor`,
          });
          return;
        }
        setState({ status: "success", academyId, data: data as DashboardSummary });
      } catch {
        if (cancelled) return;
        setState({ status: "error", academyId, message: "Kesalahan jaringan — tidak dapat menjangkau server" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAcademyId]);

  const isStale = state.academyId !== selectedAcademyId;
  const showLoading = state.status === "loading" || isStale;
  const showError = !isStale && state.status === "error";
  const showSuccess = !isStale && state.status === "success" && state.data;

  if (adminMemberships.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">
            Anda tidak memiliki akses Admin ke akademi mana pun. Hubungi administrator
            jika Anda merasa ini adalah kesalahan.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Academy selector + reporting period */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          {adminMemberships.length > 1 ? (
            <>
              <Label htmlFor="academy-select" className="text-xs text-muted-foreground">
                Akademi
              </Label>
              <Select value={selectedAcademyId} onValueChange={onSelectAcademy}>
                <SelectTrigger id="academy-select" className="w-full sm:w-72">
                  <SelectValue placeholder="Pilih akademi" />
                </SelectTrigger>
                <SelectContent>
                  {adminMemberships.map((m) => (
                    <SelectItem key={m.academyId} value={m.academyId}>
                      Akademi {m.academyId.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Akademi{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                {selectedAcademyId.slice(0, 8)}
              </code>
            </p>
          )}
        </div>
        {showSuccess && state.status === "success" && state.data && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Hari ini</p>
            <p className="text-sm font-medium tabular-nums">{state.data.today}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Bulan: {state.data.monthStart} – {state.data.monthEnd}
            </p>
          </div>
        )}
      </div>

      {/* Loading state */}
      {showLoading && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat dasbor…</p>
          </CardContent>
        </Card>
      )}

      {/* Error state with retry */}
      {showError && state.status === "error" && (
        <Card className="border-destructive/50">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1">
                <p className="text-sm font-medium text-destructive">Gagal memuat dasbor</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 gap-2"
                  onClick={() => void handleRetry()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Success — render the dashboard */}
      {showSuccess && state.status === "success" && state.data && <DashboardContent data={state.data} />}
    </div>
  );
}

// === Dashboard content (success state) ==================================

function DashboardContent({ data }: { data: DashboardSummary }) {
  const attendanceTotal =
    data.sessions.attendanceToday.present +
    data.sessions.attendanceToday.absent +
    data.sessions.attendanceToday.excused +
    data.sessions.attendanceToday.late;

  const isEmpty =
    data.students.currentlyEnrolled === 0 &&
    data.sessions.scheduledToday === 0 &&
    data.packages.withUsableSessions === 0 &&
    data.packages.exhausted === 0 &&
    data.entitlements.awaitingMakeup === 0 &&
    data.entitlements.unassignedActive === 0 &&
    data.finances.monthPaymentTotal === "0.00" &&
    data.finances.monthExpenseTotal === "0.00";

  if (isEmpty) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <ClipboardCheck className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium">Belum ada data</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Belum ada siswa terdaftar, sesi terjadwal, paket, atau
            transaksi tercatat untuk akademi ini pada periode berjalan.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Students */}
      <section>
        <SectionCard title="Siswa" badge="Hari ini">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-2">
            <MetricCard
              icon={Users}
              label="Terdaftar saat ini"
              value={data.students.currentlyEnrolled}
              hint="Pendaftaran aktif pada tanggal hari ini"
            />
            <MetricCard
              icon={UserPlus}
              label="Mulai hari ini"
              value={data.students.startingToday}
              hint="Pendaftaran efektif mulai hari ini"
              variant={data.students.startingToday > 0 ? "success" : "default"}
            />
          </div>
        </SectionCard>
      </section>

      {/* Today's sessions */}
      <section>
        <SectionCard
          title="Sesi latihan hari ini"
          description="Sesi latihan terjadwal dan kehadiran"
          badge={data.sessions.scheduledToday === 0 ? "Tidak ada" : undefined}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard
              icon={CalendarDays}
              label="Terjadwal"
              value={data.sessions.scheduledToday}
              hint="Sesi terencana (yang dibatalkan tidak dihitung)"
            />
            <MetricCard
              icon={ClipboardCheck}
              label="Hadir"
              value={data.sessions.attendanceToday.present}
              variant={data.sessions.attendanceToday.present > 0 ? "success" : "default"}
            />
            <MetricCard
              icon={Clock}
              label="Terlambat"
              value={data.sessions.attendanceToday.late}
              variant={data.sessions.attendanceToday.late > 0 ? "warning" : "default"}
            />
            <MetricCard
              icon={ClipboardCheck}
              label="Tidak hadir"
              value={data.sessions.attendanceToday.absent}
            />
            <MetricCard
              icon={ClipboardCheck}
              label="Izin"
              value={data.sessions.attendanceToday.excused}
            />
          </div>
          {attendanceTotal === 0 && data.sessions.scheduledToday > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Ada sesi terjadwal hari ini namun kehadiran belum dicatat.
            </p>
          )}
        </SectionCard>
      </section>

      {/* Packages + follow-up */}
      <section>
        <SectionCard
          title="Paket latihan dan tindak lanjut"
          description="Sesi tersisa yang dapat digunakan dan hak sesi yang perlu diperhatikan"
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <MetricCard
              icon={Package}
              label="Memiliki sesi tersisa"
              value={data.packages.withUsableSessions}
              hint="≥1 hak sesi aktif"
              variant={data.packages.withUsableSessions > 0 ? "success" : "default"}
            />
            <MetricCard
              icon={PackageCheck}
              label="Paket habis"
              value={data.packages.exhausted}
              hint="Semua sesi telah digunakan/dibatalkan"
              variant={data.packages.exhausted > 0 ? "warning" : "default"}
            />
            <MetricCard
              icon={CalendarClock}
              label="Menunggu makeup"
              value={data.entitlements.awaitingMakeup}
              hint="Dilewati atau menunggu makeup"
              variant={data.entitlements.awaitingMakeup > 0 ? "warning" : "default"}
            />
            <MetricCard
              icon={AlertCircle}
              label="Aktif belum terjadwal"
              value={data.entitlements.unassignedActive}
              hint="Perlu dijadwalkan"
              variant={data.entitlements.unassignedActive > 0 ? "warning" : "default"}
            />
          </div>
        </SectionCard>
      </section>

      {/* Finances — current month */}
      <section>
        <SectionCard
          title="Keuangan"
          description={`Bulan berjalan: ${data.monthStart} sampai ${data.monthEnd} (eksklusif)`}
          badge="Bulan ini"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetricCard
              icon={Wallet}
              label="Pembayaran diterima"
              value={formatRupiah(data.finances.monthPaymentTotal)}
              hint="Pembayaran dikonfirmasi bulan ini"
              variant="success"
            />
            <MetricCard
              icon={TrendingDown}
              label="Pengeluaran"
              value={formatRupiah(data.finances.monthExpenseTotal)}
              hint="Semua kategori bulan ini"
              variant="warning"
            />
          </div>
        </SectionCard>
      </section>
    </div>
  );
}
