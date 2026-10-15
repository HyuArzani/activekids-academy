"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Users,
  UserX,
  AlertCircle,
  RefreshCw,
  Loader2,
  Inbox,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

// === Types (match the API response from GET /api/admin/students) ======

interface StudentRow {
  id: string;
  academy_id: string;
  full_name: string;
  date_of_birth: string | null; // ISO date or null
  gender: string | null;
  notes: string | null;
  archived_at: string | null;
}

interface ListResponse {
  students: StudentRow[];
}

type LoadState =
  | { status: "loading"; academyId: string }
  | { status: "success"; academyId: string; data: StudentRow[] }
  | { status: "error"; academyId: string; message: string };

// === Date formatter (Indonesian locale, safe for null) =================

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatGender(gender: string | null): string {
  if (!gender) return "—";
  if (gender === "male") return "Laki-laki";
  if (gender === "female") return "Perempuan";
  return gender;
}

// === Main component =====================================================

interface StudentListProps {
  /** The admin's academy memberships from the authenticated principal. */
  memberships: { academyId: string; role: string }[];
  /** The currently selected academy ID (shared with the dashboard). */
  selectedAcademyId: string;
  /** Callback when the academy selection changes (shared with dashboard). */
  onSelectAcademy: (academyId: string) => void;
}

export function StudentList({
  memberships,
  selectedAcademyId,
  onSelectAcademy,
}: StudentListProps) {
  const adminMemberships = memberships.filter((m) => m.role === "admin");
  const [state, setState] = useState<LoadState>({
    status: "loading",
    academyId: selectedAcademyId,
  });

  // Ref to read the latest selectedAcademyId inside async callbacks
  // (retry handler) without re-creating the handler on every academy change.
  const selectedAcademyIdRef = useRef(selectedAcademyId);
  useEffect(() => {
    selectedAcademyIdRef.current = selectedAcademyId;
  }, [selectedAcademyId]);

  // Retry handler — captures the academyId at call time; only applies
  // the result if the academy hasn't changed during the fetch.
  const handleRetry = useCallback(async () => {
    const academyId = selectedAcademyId;
    if (!academyId) return;
    setState({ status: "loading", academyId });
    try {
      const res = await fetch(`/api/admin/students?academyId=${academyId}`, {
        credentials: "same-origin",
      });
      const data = (await res.json()) as { error?: { message?: string } } & Partial<ListResponse>;
      if (academyId !== selectedAcademyIdRef.current) return;
      if (!res.ok || !data.students) {
        setState({
          status: "error",
          academyId,
          message: data.error?.message ?? `Kesalahan ${res.status}: gagal memuat data siswa`,
        });
        return;
      }
      setState({ status: "success", academyId, data: data.students });
    } catch {
      if (academyId !== selectedAcademyIdRef.current) return;
      setState({ status: "error", academyId, message: "Kesalahan jaringan — tidak dapat menjangkau server" });
    }
  }, [selectedAcademyId]);

  // Initial load + reload when academy changes.
  // Same IIFE + cancellation pattern as DashboardOverview — a slow
  // response from a previous academy cannot overwrite the latest.
  useEffect(() => {
    if (!selectedAcademyId) return;
    let cancelled = false;
    const academyId = selectedAcademyId;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/students?academyId=${academyId}`, {
          credentials: "same-origin",
        });
        if (cancelled) return;
        const data = (await res.json()) as { error?: { message?: string } } & Partial<ListResponse>;
        if (cancelled) return;
        if (!res.ok || !data.students) {
          setState({
            status: "error",
            academyId,
            message: data.error?.message ?? `Kesalahan ${res.status}: gagal memuat data siswa`,
          });
          return;
        }
        setState({ status: "success", academyId, data: data.students });
      } catch {
        if (cancelled) return;
        setState({ status: "error", academyId, message: "Kesalahan jaringan — tidak dapat menjangkau server" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAcademyId]);

  // Derived: is the current state for the selected academy?
  const isStale = state.academyId !== selectedAcademyId;
  const showLoading = state.status === "loading" || isStale;
  const showError = !isStale && state.status === "error";
  const showSuccess = !isStale && state.status === "success" && state.data;

  return (
    <div className="space-y-4">
      {/* Academy selector */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          {adminMemberships.length > 1 ? (
            <>
              <Label htmlFor="student-academy-select" className="text-xs text-muted-foreground">
                Akademi
              </Label>
              <Select value={selectedAcademyId} onValueChange={onSelectAcademy}>
                <SelectTrigger id="student-academy-select" className="w-full sm:w-72">
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
          <Badge variant="secondary">
            {state.data.length} siswa
          </Badge>
        )}
      </div>

      {/* Loading state */}
      {showLoading && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat data siswa…</p>
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
                <p className="text-sm font-medium text-destructive">Gagal memuat data siswa</p>
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

      {/* Success — render the student list */}
      {showSuccess && state.status === "success" && state.data && (
        <StudentListContent students={state.data} />
      )}
    </div>
  );
}

// === Student list content (success state) ===============================

function StudentListContent({ students }: { students: StudentRow[] }) {
  if (students.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <Inbox className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium">Belum ada siswa</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Belum ada siswa aktif di akademi ini. Siswa yang diarsipkan
            disembunyikan secara default.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <Users className="h-5 w-5 text-primary" aria-hidden /> Siswa
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Siswa aktif (tidak diarsipkan) di akademi ini
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {/* Desktop: table view */}
        <div className="hidden sm:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nama</TableHead>
                <TableHead>Tanggal lahir</TableHead>
                <TableHead>Jenis kelamin</TableHead>
                <TableHead className="hidden md:table-cell">Catatan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.full_name}</TableCell>
                  <TableCell className="tabular-nums">{formatDate(s.date_of_birth)}</TableCell>
                  <TableCell>{formatGender(s.gender)}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground hidden md:table-cell">
                    {s.notes ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Mobile: card list */}
        <div className="divide-y sm:hidden">
          {students.map((s) => (
            <div key={s.id} className="p-4">
              <p className="font-medium">{s.full_name}</p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
                <span className="tabular-nums">{formatDate(s.date_of_birth)}</span>
                <span>{formatGender(s.gender)}</span>
              </div>
              {s.notes && (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{s.notes}</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// === Non-admin fallback (used by AuthShell) ============================

export function StudentListNoAccess() {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-start gap-3">
          <UserX className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" aria-hidden />
          <div>
            <p className="text-sm font-medium">Akses Admin diperlukan</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Daftar siswa hanya tersedia untuk peran Admin. Akun Anda
              tidak memiliki akses Admin ke akademi mana pun.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
