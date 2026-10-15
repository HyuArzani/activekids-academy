"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Package,
  ClipboardCheck,
  Wallet,
  FileText,
  FileCheck,
  Globe,
  AlertCircle,
  Loader2,
  RefreshCw,
  UserPlus,
  ArrowLeft,
  Search,
  Pencil,
  UserCog,
  Trash2,
  ArrowRightLeft,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DashboardOverview } from "@/components/dashboard/DashboardOverview";
import { AttendanceManagement } from "@/components/admin/AttendanceManagement";
import { PackagesManagement } from "@/components/admin/PackagesManagement";
import { PaymentsManagement } from "@/components/admin/PaymentsManagement";
import { RegistrationsManagement } from "@/components/admin/RegistrationsManagement";
import { WebsiteContentManagement } from "@/components/admin/WebsiteContentManagement";
import { ReportsManagement } from "@/components/admin/ReportsManagement";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { toast } from "@/hooks/use-toast";

// Shared fetch helper for mutations (CSRF + JSON)
async function adminFetch(url: string, method: string, body: unknown): Promise<Response> {
  const csrfMatch = document.cookie.split("; ").find((c) => c.startsWith("futsal_csrf="));
  const csrfToken = csrfMatch?.split("=")[1] ?? "";
  return fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", [CSRF_HEADER]: csrfToken },
    body: JSON.stringify(body),
  });
}

// === Types (match the actual API responses) ===============================

interface StudentRow {
  id: string;
  academy_id: string;
  full_name: string;
  date_of_birth: string | null;
  gender: string | null;
  notes: string | null;
  archived_at: string | null;
}

interface StudentDetail {
  id: string;
  academy_id: string;
  full_name: string;
  date_of_birth: string | null;
  gender: string | null;
  notes: string | null;
  archived_at: string | null;
}

interface GuardianLink {
  id: string;
  guardian_user_id: string;
  student_id: string;
  is_primary: boolean;
  relationship: string | null;
  /** Guardian's email (joined from users on the server). NULL only if
   * the user row is somehow missing (FK + ON DELETE RESTRICT). */
  guardian_email: string | null;
  /** Guardian's display name (joined from users). NULL if not set. */
  guardian_full_name: string | null;
}

/** Build the best-available display label for a guardian link.
 * Prefers full_name, then email, then a masked UUID prefix (never the
 * raw UUID — that's an internal identifier). */
function guardianDisplayName(g: GuardianLink): string {
  if (g.guardian_full_name && g.guardian_full_name.trim()) return g.guardian_full_name.trim();
  if (g.guardian_email && g.guardian_email.trim()) return g.guardian_email.trim();
  // Last-resort fallback: a masked UUID prefix (no full UUID exposure).
  return `User ${g.guardian_user_id.slice(0, 8)}…`;
}

/** Build the secondary/sub-label for a guardian link. Shows the email
 * when the primary label is the name; empty string when the primary
 * label IS the email (no need to repeat). */
function guardianSecondaryLabel(g: GuardianLink): string {
  if (g.guardian_full_name && g.guardian_full_name.trim() && g.guardian_email && g.guardian_email.trim()) {
    return g.guardian_email.trim();
  }
  return "";
}

type AdminSection =
  | "dashboard"
  | "students"
  | "classes"
  | "packages"
  | "attendance"
  | "payments"
  | "registrations"
  | "reports"
  | "website";

// === Navigation config ===================================================

const NAV_ITEMS: { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }>; enabled: boolean }[] = [
  { id: "dashboard", label: "Dasbor", icon: LayoutDashboard, enabled: true },
  { id: "students", label: "Siswa", icon: Users, enabled: true },
  { id: "classes", label: "Kelas", icon: CalendarDays, enabled: true },
  { id: "packages", label: "Paket", icon: Package, enabled: true },
  { id: "attendance", label: "Kehadiran", icon: ClipboardCheck, enabled: true },
  { id: "payments", label: "Pembayaran & Pengeluaran", icon: Wallet, enabled: true },
  { id: "registrations", label: "Pendaftaran", icon: FileCheck, enabled: true },
  { id: "reports", label: "Laporan", icon: FileText, enabled: true },
  { id: "website", label: "Konten Website", icon: Globe, enabled: true },
];

/** Translate an API gender value (male/female/unspecified) for display. */
function genderLabel(g: string | null | undefined): string {
  if (g === "male") return "Laki-laki";
  if (g === "female") return "Perempuan";
  if (g === "unspecified") return "Tidak Disebutkan";
  return "—";
}

// === Main component =======================================================

interface AdminShellProps {
  memberships: { academyId: string; role: string }[];
  selectedAcademyId: string;
  onSelectAcademy: (academyId: string) => void;
}

export function AdminShell({ memberships, selectedAcademyId, onSelectAcademy }: AdminShellProps) {
  const [section, setSection] = useState<AdminSection>("dashboard");
  const adminMemberships = memberships.filter((m) => m.role === "admin");

  return (
    <div className="space-y-4">
      {/* Academy selector */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          {adminMemberships.length > 1 ? (
            <>
              <Label htmlFor="admin-academy-select" className="text-xs text-muted-foreground">
                Akademi
              </Label>
              <Select value={selectedAcademyId} onValueChange={onSelectAcademy}>
                <SelectTrigger id="admin-academy-select" className="w-full sm:w-72">
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
      </div>

      {/* Navigation */}
      <div className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label="Bagian admin">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              disabled={!item.enabled}
              onClick={() => item.enabled && setSection(item.id)}
              className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                section === item.id
                  ? "bg-background text-foreground shadow-sm"
                  : item.enabled
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/50 cursor-not-allowed"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden /> {item.label}
              {!item.enabled && <span className="text-xs">(segera)</span>}
            </button>
          );
        })}
      </div>

      {/* Section content */}
      <div className="min-h-[300px]">
        {section === "dashboard" && (
          <DashboardOverview
            memberships={memberships}
            selectedAcademyId={selectedAcademyId}
            onSelectAcademy={onSelectAcademy}
          />
        )}
        {section === "students" && (
          <StudentManagement
            academyId={selectedAcademyId}
          />
        )}
        {section === "classes" && (
          <ClassManagement academyId={selectedAcademyId} />
        )}
        {section === "packages" && (
          <PackagesManagement academyId={selectedAcademyId} />
        )}
        {section === "attendance" && (
          <AttendanceManagement academyId={selectedAcademyId} />
        )}
        {section === "payments" && (
          <PaymentsManagement academyId={selectedAcademyId} />
        )}
        {section === "registrations" && (
          <RegistrationsManagement academyId={selectedAcademyId} />
        )}
        {section === "website" && (
          <WebsiteContentManagement key={selectedAcademyId} academyId={selectedAcademyId} />
        )}
        {section === "reports" && (
          <ReportsManagement key={selectedAcademyId} academyId={selectedAcademyId} />
        )}
        {section !== "dashboard" && section !== "students" && section !== "classes" && section !== "packages" && section !== "attendance" && section !== "payments" && section !== "registrations" && section !== "website" && section !== "reports" && (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-sm font-medium text-muted-foreground">Segera hadir</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Bagian ini akan diterapkan di fase mendatang.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// === Student Management ==================================================

type ListState =
  | { status: "loading" }
  | { status: "success"; data: StudentRow[] }
  | { status: "error"; message: string };

function StudentManagement({ academyId }: { academyId: string }) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const academyIdRef = useRef(academyId);
  useEffect(() => { academyIdRef.current = academyId; }, [academyId]);

  // Request-ordering token (stale-response guard). Mirrors the
  // RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchList = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/students?academyId=${aid}`, { credentials: "same-origin" });
      const data = (await res.json()) as { students?: StudentRow[]; error?: { message?: string } };
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok || !data.students) {
        setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
        return;
      }
      setState({ status: "success", data: data.students });
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/students?academyId=${aid}`, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        const data = (await res.json()) as { students?: StudentRow[]; error?: { message?: string } };
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok || !data.students) {
          setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.students });
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setState({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => { cancelled = true; };
  }, [academyId]);

  // Client-side search filtering (API doesn't support search params)
  const filteredStudents = useMemo(() => {
    if (state.status !== "success") return [];
    const q = searchQuery.toLowerCase().trim();
    if (!q) return state.data;
    return state.data.filter((s) =>
      s.full_name.toLowerCase().includes(q)
    );
  }, [state, searchQuery]);

  // Student detail view
  if (selectedStudentId) {
    return (
      <StudentDetail
        studentId={selectedStudentId}
        academyId={academyId}
        onBack={() => { setSelectedStudentId(null); fetchList(); }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            placeholder="Cari siswa…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
            disabled={state.status === "loading"}
          />
        </div>
        <Button className="gap-2" onClick={() => setShowCreateDialog(true)}>
          <UserPlus className="h-4 w-4" aria-hidden /> Tambah Siswa
        </Button>
      </div>

      {/* States */}
      {state.status === "loading" && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat siswa…</p>
          </CardContent>
        </Card>
      )}

      {state.status === "error" && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm font-medium text-destructive">Gagal memuat siswa</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={fetchList}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {state.status === "success" && (
        <>
          {filteredStudents.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <Users className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
                <p className="mt-3 text-sm font-medium">
                  {searchQuery ? "Tidak ada siswa yang cocok dengan pencarian" : "Tidak ada siswa"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {searchQuery
                    ? "Coba kata kunci lain."
                    : "Klik 'Tambah Siswa' untuk membuat siswa pertama."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <Badge variant="secondary">
                {filteredStudents.length} siswa
              </Badge>
              {/* Desktop: table */}
              <Card>
                <CardContent className="p-0">
                  <div className="hidden sm:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Nama</TableHead>
                          <TableHead>Tanggal Lahir</TableHead>
                          <TableHead>Jenis Kelamin</TableHead>
                          <TableHead className="hidden md:table-cell">Catatan</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredStudents.map((s) => (
                          <TableRow
                            key={s.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setSelectedStudentId(s.id)}
                          >
                            <TableCell className="font-medium">{s.full_name}</TableCell>
                            <TableCell className="tabular-nums">{s.date_of_birth ?? "—"}</TableCell>
                            <TableCell>{genderLabel(s.gender)}</TableCell>
                            <TableCell className="max-w-xs truncate text-muted-foreground hidden md:table-cell">
                              {s.notes ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {/* Mobile: cards */}
                  <div className="divide-y sm:hidden">
                    {filteredStudents.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="w-full p-4 text-left hover:bg-muted/50"
                        onClick={() => setSelectedStudentId(s.id)}
                      >
                        <p className="font-medium">{s.full_name}</p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
                          {s.date_of_birth && <span className="tabular-nums">{s.date_of_birth}</span>}
                          {s.gender && <span>{genderLabel(s.gender)}</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}

      {/* Create student dialog */}
      <CreateStudentDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        academyId={academyId}
        onCreated={() => { setShowCreateDialog(false); fetchList(); }}
      />
    </div>
  );
}

// === Create Student Dialog ===============================================

function CreateStudentDialog({
  open,
  onClose,
  academyId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  academyId: string;
  onCreated: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFullName(""); setDateOfBirth(""); setGender(""); setNotes("");
      setSubmitting(false); setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!fullName.trim()) { setError("Nama lengkap wajib diisi."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const csrfMatch = document.cookie.split("; ").find((c) => c.startsWith("futsal_csrf="));
      const csrfToken = csrfMatch?.split("=")[1] ?? "";
      const body: Record<string, unknown> = { fullName: fullName.trim() };
      if (dateOfBirth) body.dateOfBirth = dateOfBirth;
      if (gender) body.gender = gender;
      if (notes.trim()) body.notes = notes.trim();
      const res = await fetch(`/api/admin/students?academyId=${academyId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: csrfToken },
        body: JSON.stringify(body),
      });
      if (res.status === 201) { toast({ title: "Siswa ditambahkan" }); onCreated(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menambah siswa", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan — tidak dapat menjangkau server.");
      toast({ title: "Gagal menambah siswa", description: "Kesalahan jaringan", variant: "destructive" });
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
          <DialogTitle>Tambah Siswa Baru</DialogTitle>
          <DialogDescription>Tambah siswa baru di akademi ini.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="create-fullName">Nama Lengkap *</Label>
            <Input id="create-fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={submitting} placeholder="cth., Budi Santoso" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-dob">Tanggal Lahir</Label>
            <Input id="create-dob" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-gender">Jenis Kelamin</Label>
            <Select value={gender} onValueChange={setGender} disabled={submitting}>
              <SelectTrigger id="create-gender"><SelectValue placeholder="Pilih jenis kelamin" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="male">Laki-laki</SelectItem>
                <SelectItem value="female">Perempuan</SelectItem>
                <SelectItem value="unspecified">Tidak Disebutkan</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-notes">Catatan</Label>
            <Textarea id="create-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} rows={2} placeholder="Catatan opsional…" />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Membuat…</> : "Tambah Siswa"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Student Detail ======================================================

type DetailState =
  | { status: "loading" }
  | { status: "success"; student: StudentDetail; guardians: GuardianLink[]; enrollments: EnrollmentRow[] }
  | { status: "error"; message: string };

interface EnrollmentRow {
  id: string;
  student_id: string;
  class_id: string;
  class_name: string | null;
  effective_from: string;
  effective_to: string | null;
}

function StudentDetail({
  studentId,
  academyId,
  onBack,
}: {
  studentId: string;
  academyId: string;
  onBack: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [showEdit, setShowEdit] = useState(false);
  const [showAddGuardian, setShowAddGuardian] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  const refetch = useCallback(async () => {
    let cancelled = false;
    setState({ status: "loading" });
    try {
      const [studentRes, guardianRes, enrollRes] = await Promise.all([
        fetch(`/api/admin/students/${studentId}?academyId=${academyId}`, { credentials: "same-origin" }),
        fetch(`/api/admin/students/${studentId}/guardians?academyId=${academyId}`, { credentials: "same-origin" }),
        fetch(`/api/admin/students/${studentId}/enrollments?academyId=${academyId}`, { credentials: "same-origin" }),
      ]);
      if (cancelled) return;
      if (!studentRes.ok) {
        const err = (await studentRes.json()) as { error?: { message?: string } };
        setState({ status: "error", message: err.error?.message ?? `Kesalahan ${studentRes.status}` });
        return;
      }
      const student = (await studentRes.json()) as StudentDetail;
      const guardianData = guardianRes.ok ? ((await guardianRes.json()) as { guardians?: GuardianLink[] }).guardians ?? [] : [];
      const enrollmentData = enrollRes.ok ? ((await enrollRes.json()) as { enrollments?: EnrollmentRow[] }).enrollments ?? [] : [];
      if (cancelled) return;
      setState({ status: "success", student, guardians: guardianData, enrollments: enrollmentData });
    } catch {
      if (cancelled) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
    return () => { cancelled = true; };
  }, [studentId, academyId]);

  // Initial load — use an IIFE pattern to avoid the cascading-render
  // lint warning that occurs when calling a useCallback that triggers
  // setState. The IIFE captures the fetch inline.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [studentRes, guardianRes, enrollRes] = await Promise.all([
          fetch(`/api/admin/students/${studentId}?academyId=${academyId}`, { credentials: "same-origin" }),
          fetch(`/api/admin/students/${studentId}/guardians?academyId=${academyId}`, { credentials: "same-origin" }),
          fetch(`/api/admin/students/${studentId}/enrollments?academyId=${academyId}`, { credentials: "same-origin" }),
        ]);
        if (cancelled) return;
        if (!studentRes.ok) {
          const err = (await studentRes.json()) as { error?: { message?: string } };
          if (!cancelled) setState({ status: "error", message: err.error?.message ?? `Kesalahan ${studentRes.status}` });
          return;
        }
        const student = (await studentRes.json()) as StudentDetail;
        const guardianData = guardianRes.ok ? ((await guardianRes.json()) as { guardians?: GuardianLink[] }).guardians ?? [] : [];
        const enrollmentData = enrollRes.ok ? ((await enrollRes.json()) as { enrollments?: EnrollmentRow[] }).enrollments ?? [] : [];
        if (cancelled) return;
        setState({ status: "success", student, guardians: guardianData, enrollments: enrollmentData });
      } catch {
        if (!cancelled) setState({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => { cancelled = true; };
  }, [studentId, academyId]);

  if (state.status === "loading") {
    return (
      <Card><CardContent className="flex items-center gap-3 p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">Memuat siswa…</p>
      </CardContent></Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card className="border-destructive/30">
        <CardContent className="p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-sm font-medium text-destructive">Gagal memuat siswa</p>
              <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
              <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali ke daftar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { student, guardians, enrollments } = state;
  const activeEnrollment = enrollments.find((e) => e.effective_to === null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali
          </Button>
          <div>
            <h2 className="text-lg font-semibold">{student.full_name}</h2>
            {student.archived_at && <Badge variant="outline">Diarsipkan</Badge>}
          </div>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowEdit(true)}>
          <Pencil className="h-4 w-4" aria-hidden /> Ubah
        </Button>
      </div>

      {/* Student info */}
      <Card>
        <CardHeader><CardTitle className="text-base">Informasi Siswa</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Tanggal Lahir</span><span>{student.date_of_birth ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Jenis Kelamin</span><span>{genderLabel(student.gender)}</span></div>
          {student.notes && <div className="pt-2"><span className="text-muted-foreground">Catatan: </span>{student.notes}</div>}
        </CardContent>
      </Card>

      {/* Guardians */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Wali</CardTitle>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowAddGuardian(true)}>
            <UserCog className="h-4 w-4" aria-hidden /> Tambah Wali
          </Button>
        </CardHeader>
        <CardContent>
          {guardians.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada wali yang terhubung.</p>
          ) : (
            <div className="space-y-2">
              {guardians.map((g) => (
                <div key={g.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{guardianDisplayName(g)}</p>
                    {guardianSecondaryLabel(g) && (
                      <p className="text-muted-foreground truncate">{guardianSecondaryLabel(g)}</p>
                    )}
                    {g.relationship && <p className="text-muted-foreground text-xs">{g.relationship}</p>}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {g.is_primary && <Badge>Utama</Badge>}
                    <RemoveGuardianButton
                      linkId={g.id}
                      studentId={studentId}
                      academyId={academyId}
                      onRemoved={refetch}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Enrollment */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Pendaftaran Kelas</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowEnroll(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> Daftarkan
            </Button>
            {activeEnrollment && (
              <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowTransfer(true)}>
                <ArrowRightLeft className="h-4 w-4" aria-hidden /> Pindahkan
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {enrollments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum terdaftar di kelas mana pun.</p>
          ) : (
            <div className="space-y-2">
              {enrollments.map((e) => (
                <div key={e.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                  <div>
                    <p className="font-medium">{e.class_name ?? `Kelas ${e.class_id.slice(0, 8)}…`}</p>
                    <p className="text-muted-foreground">Dari: {e.effective_from}{e.effective_to ? ` → Sampai: ${e.effective_to}` : " (aktif)"}</p>
                  </div>
                  {!e.effective_to && <Badge>Aktif</Badge>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      {showEdit && (
        <EditStudentDialog
          open={showEdit}
          onClose={() => setShowEdit(false)}
          student={student}
          academyId={academyId}
          onSaved={() => { setShowEdit(false); refetch(); }}
        />
      )}
      {showAddGuardian && (
        <AddGuardianDialog
          open={showAddGuardian}
          onClose={() => setShowAddGuardian(false)}
          studentId={studentId}
          academyId={academyId}
          onAdded={() => { setShowAddGuardian(false); refetch(); }}
        />
      )}
      {showEnroll && (
        <EnrollDialog
          open={showEnroll}
          onClose={() => setShowEnroll(false)}
          studentId={studentId}
          academyId={academyId}
          onEnrolled={() => { setShowEnroll(false); refetch(); }}
        />
      )}
      {showTransfer && activeEnrollment && (
        <TransferDialog
          open={showTransfer}
          onClose={() => setShowTransfer(false)}
          studentId={studentId}
          academyId={academyId}
          currentClassName={activeEnrollment.class_name ?? "Kelas saat ini"}
          onTransferred={() => { setShowTransfer(false); refetch(); }}
        />
      )}
    </div>
  );
}

// === Remove Guardian Button =============================================

function RemoveGuardianButton({ linkId, studentId, academyId, onRemoved }: {
  linkId: string; studentId: string; academyId: string; onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async () => {
    setSubmitting(true); setError(null);
    try {
      const res = await adminFetch(
        `/api/admin/students/${studentId}/guardians/${linkId}?academyId=${academyId}`,
        "DELETE", {},
      );
      if (res.ok) { toast({ title: "Wali dihapus" }); onRemoved(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menghapus wali", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal menghapus wali", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button variant="destructive" size="sm" disabled={submitting} onClick={handleRemove}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "Konfirmasi"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => { setConfirming(false); setError(null); }}>Batal</Button>
      </div>
    );
  }

  return (
    <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label="Hapus wali">
      <Trash2 className="h-4 w-4" aria-hidden />
    </Button>
  );
}

// === Edit Student Dialog ================================================

function EditStudentDialog({ open, onClose, student, academyId, onSaved }: {
  open: boolean; onClose: () => void; student: StudentDetail; academyId: string; onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(student.full_name);
  const [dateOfBirth, setDateOfBirth] = useState(student.date_of_birth ?? "");
  const [gender, setGender] = useState(student.gender ?? "");
  const [notes, setNotes] = useState(student.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!fullName.trim()) { setError("Nama lengkap wajib diisi."); return; }
    setSubmitting(true); setError(null);
    try {
      const body: Record<string, unknown> = { fullName: fullName.trim() };
      body.dateOfBirth = dateOfBirth || null;
      body.gender = gender || null;
      body.notes = notes.trim() || null;
      const res = await adminFetch(`/api/admin/students/${student.id}?academyId=${academyId}`, "PUT", body);
      if (res.ok) { toast({ title: "Siswa diperbarui" }); onSaved(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memperbarui siswa", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal memperbarui siswa", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Ubah Siswa</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-fullName">Nama Lengkap *</Label>
            <Input id="edit-fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-dob">Tanggal Lahir</Label>
            <Input id="edit-dob" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-gender">Jenis Kelamin</Label>
            <Select value={gender} onValueChange={setGender} disabled={submitting}>
              <SelectTrigger id="edit-gender"><SelectValue placeholder="Pilih jenis kelamin" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="male">Laki-laki</SelectItem>
                <SelectItem value="female">Perempuan</SelectItem>
                <SelectItem value="unspecified">Tidak Disebutkan</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-notes">Catatan</Label>
            <Textarea id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} rows={2} />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menyimpan…</> : "Simpan Perubahan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Add Guardian Dialog =================================================

/** A single eligible-guardian search result. Mirrors the API response. */
interface EligibleGuardian {
  id: string;
  email: string;
  fullName: string | null;
  isAlreadyLinked: boolean;
}

/** Build the best-available display label for an eligible guardian. */
function eligibleDisplayName(g: EligibleGuardian): string {
  if (g.fullName && g.fullName.trim()) return g.fullName.trim();
  return g.email.trim();
}

function AddGuardianDialog({ open, onClose, studentId, academyId, onAdded }: {
  open: boolean; onClose: () => void; studentId: string; academyId: string; onAdded: () => void;
}) {
  // Search state.
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<EligibleGuardian[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Selected guardian (the one that will be linked).
  const [selectedGuardian, setSelectedGuardian] = useState<EligibleGuardian | null>(null);
  // Link options.
  const [isPrimary, setIsPrimary] = useState(false);
  const [relationship, setRelationship] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset all state when the dialog opens.
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setResults([]);
      setSearching(false);
      setSearchError(null);
      setSelectedGuardian(null);
      setIsPrimary(false);
      setRelationship("");
      setSubmitting(false);
      setSubmitError(null);
    }
  }, [open]);

  // Debounced search (300ms after the user stops typing). Only fires
  // when the query is at least 2 chars; shorter queries clear results.
  useEffect(() => {
    // If the dialog isn't open, don't search.
    if (!open) return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    // Clear any previous selection if the search query changed.
    setSelectedGuardian(null);
    setSearching(true);
    setSearchError(null);
    const debounceMs = 300;
    const timer = setTimeout(() => {
      // Use an AbortController per search so a stale fetch can't
      // overwrite newer results (request-ID guard at the network layer).
      const controller = new AbortController();
      void (async () => {
        try {
          const res = await fetch(
            `/api/admin/students/${studentId}/guardians/eligible?academyId=${academyId}&q=${encodeURIComponent(trimmed)}`,
            { credentials: "same-origin", signal: controller.signal },
          );
          if (!res.ok) {
            const data = (await res.json()) as { error?: { message?: string } };
            setResults([]);
            setSearchError(data.error?.message ?? `Pencarian gagal (${res.status})`);
            return;
          }
          const data = (await res.json()) as { eligible?: EligibleGuardian[] };
          setResults(data.eligible ?? []);
        } catch (err) {
          // AbortError is expected when a newer search supersedes this one.
          if (err instanceof DOMException && err.name === "AbortError") return;
          setResults([]);
          setSearchError("Kesalahan jaringan");
        } finally {
          setSearching(false);
        }
      })();
      // Cleanup: abort this search if the effect re-runs (new query).
      return () => controller.abort();
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [searchQuery, open, studentId, academyId]);

  const handleSubmit = async () => {
    if (!selectedGuardian) {
      setSubmitError("Silakan cari dan pilih wali terlebih dahulu.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: Record<string, unknown> = { guardianUserId: selectedGuardian.id };
      if (isPrimary) body.isPrimary = true;
      if (relationship.trim()) body.relationship = relationship.trim();
      const res = await adminFetch(`/api/admin/students/${studentId}/guardians?academyId=${academyId}`, "POST", body);
      if (res.status === 201) { toast({ title: "Wali ditambahkan" }); onAdded(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setSubmitError(failMsg);
      toast({ title: "Gagal menambah wali", description: failMsg, variant: "destructive" });
    } catch { setSubmitError("Kesalahan jaringan"); toast({ title: "Gagal menambah wali", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  // Whether to show the "type at least 2 characters" hint.
  const queryTooShort = searchQuery.trim().length > 0 && searchQuery.trim().length < 2;
  // Whether to show the "no results" message.
  const showNoResults = !searching && !searchError && results.length === 0 && searchQuery.trim().length >= 2;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tambah Wali</DialogTitle>
          <DialogDescription>Cari akun wali yang sudah ada untuk dihubungkan dengan siswa ini.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="guardian-search">Cari berdasarkan nama atau email *</Label>
            <Input
              id="guardian-search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={submitting}
              placeholder="Ketik minimal 2 karakter…"
              autoComplete="off"
              aria-describedby="guardian-search-hint"
            />
            <p id="guardian-search-hint" className="text-xs text-muted-foreground">
              Hanya akun wali yang aktif di akademi ini yang ditampilkan.
            </p>
          </div>

          {/* Search results list */}
          {searching && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Mencari…
            </div>
          )}
          {searchError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{searchError}</p>
            </div>
          )}
          {queryTooShort && (
            <p className="text-sm text-muted-foreground py-2">Ketik minimal 2 karakter untuk mencari.</p>
          )}
          {showNoResults && (
            <p className="text-sm text-muted-foreground py-2">Tidak ada akun wali yang cocok.</p>
          )}
          {results.length > 0 && (
            <div className="max-h-60 overflow-y-auto rounded-md border divide-y" role="listbox" aria-label="Wali yang tersedia">
              {results.map((g) => {
                const isSelected = selectedGuardian?.id === g.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={submitting || g.isAlreadyLinked}
                    onClick={() => setSelectedGuardian(g)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors
                      ${isSelected ? "bg-primary/10" : "hover:bg-muted"}
                      ${g.isAlreadyLinked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{eligibleDisplayName(g)}</p>
                      {g.fullName && g.fullName.trim() && (
                        <p className="text-muted-foreground text-xs truncate">{g.email}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {g.isAlreadyLinked && <Badge variant="secondary">Terhubung</Badge>}
                      {isSelected && <Badge>Dipilih</Badge>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Selected guardian summary (shown after a selection) */}
          {selectedGuardian && (
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground mb-1">Wali terpilih</p>
              <p className="font-medium text-sm">{eligibleDisplayName(selectedGuardian)}</p>
              {selectedGuardian.fullName && (
                <p className="text-muted-foreground text-xs">{selectedGuardian.email}</p>
              )}
            </div>
          )}

          {/* Link options */}
          <div className="flex items-center gap-2">
            <input type="checkbox" id="guardian-primary" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} disabled={submitting} className="h-4 w-4 rounded border-gray-300" />
            <Label htmlFor="guardian-primary" className="text-sm">Wali utama</Label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="guardian-relationship">Hubungan (opsional)</Label>
            <Input id="guardian-relationship" value={relationship} onChange={(e) => setRelationship(e.target.value)} disabled={submitting} placeholder="cth., Ayah, Ibu, Bibi…" />
          </div>
          {submitError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{submitError}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting || !selectedGuardian}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menambah…</> : "Tambah Wali"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Class Selector (shared by Enroll + Transfer) ========================

interface ClassListItem { id: string; name: string; capacity: number; isActive: boolean }

function useClasses(academyId: string) {
  const [classes, setClasses] = useState<ClassListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/classes?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled) return;
        if (!res.ok) { setError(`Kesalahan ${res.status}`); return; }
        const data = (await res.json()) as { classes?: ClassListItem[] };
        setClasses(data.classes ?? []);
      } catch { if (!cancelled) setError("Kesalahan jaringan"); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [academyId]);

  return { classes, loading, error };
}

// === Enroll Dialog =======================================================

function EnrollDialog({ open, onClose, studentId, academyId, onEnrolled }: {
  open: boolean; onClose: () => void; studentId: string; academyId: string; onEnrolled: () => void;
}) {
  const { classes, loading, error: classError } = useClasses(academyId);
  const [classId, setClassId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().split("T")[0]!);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setClassId(""); setSubmitting(false); setError(null); } }, [open]);

  const handleSubmit = async () => {
    if (!classId) { setError("Silakan pilih kelas."); return; }
    if (!effectiveFrom) { setError("Tanggal efektif wajib diisi."); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await adminFetch(`/api/admin/students/${studentId}/enrollments?academyId=${academyId}`, "POST", { classId, effectiveFrom });
      if (res.status === 201) { toast({ title: "Siswa terdaftar di kelas" }); onEnrolled(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal mendaftarkan siswa", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal mendaftarkan siswa", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Daftarkan ke Kelas</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memuat kelas…</div>
          ) : classError ? (
            <p className="text-sm text-destructive">{classError}</p>
          ) : classes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada kelas tersedia. Buat kelas terlebih dahulu.</p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="enroll-class">Kelas *</Label>
              <Select value={classId} onValueChange={setClassId} disabled={submitting}>
                <SelectTrigger id="enroll-class"><SelectValue placeholder="Pilih kelas" /></SelectTrigger>
                <SelectContent>
                  {classes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name} (kap: {c.capacity}){!c.isActive ? " [tidak aktif]" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="enroll-date">Berlaku dari *</Label>
            <Input id="enroll-date" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} disabled={submitting} />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting || !classId}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Mendaftarkan…</> : "Daftarkan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Transfer Dialog =====================================================

function TransferDialog({ open, onClose, studentId, academyId, currentClassName, onTransferred }: {
  open: boolean; onClose: () => void; studentId: string; academyId: string; currentClassName: string; onTransferred: () => void;
}) {
  const { classes, loading, error: classError } = useClasses(academyId);
  const [newClassId, setNewClassId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().split("T")[0]!);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setNewClassId(""); setReason(""); setSubmitting(false); setError(null); } }, [open]);

  const handleSubmit = async () => {
    if (!newClassId) { setError("Silakan pilih kelas baru."); return; }
    setSubmitting(true); setError(null);
    try {
      const body: Record<string, unknown> = { newClassId, effectiveFrom };
      if (reason.trim()) body.reason = reason.trim();
      const res = await adminFetch(`/api/admin/students/${studentId}/transfer?academyId=${academyId}`, "POST", body);
      if (res.ok) { toast({ title: "Siswa dipindahkan" }); onTransferred(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memindahkan siswa", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal memindahkan siswa", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pindahkan Kelas</DialogTitle>
          <DialogDescription>Pindahkan dari <strong>{currentClassName}</strong> ke kelas baru.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memuat kelas…</div>
          ) : classError ? (
            <p className="text-sm text-destructive">{classError}</p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="transfer-class">Kelas Baru *</Label>
              <Select value={newClassId} onValueChange={setNewClassId} disabled={submitting}>
                <SelectTrigger id="transfer-class"><SelectValue placeholder="Pilih kelas baru" /></SelectTrigger>
                <SelectContent>
                  {classes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name} (kap: {c.capacity})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="transfer-date">Berlaku dari *</Label>
            <Input id="transfer-date" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="transfer-reason">Alasan (opsional)</Label>
            <Input id="transfer-reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={submitting} placeholder="cth., Pindah ke kelompok lanjutan" />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting || !newClassId}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memindahkan…</> : "Pindahkan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Class Management ====================================================

interface ClassRow {
  id: string;
  name: string;
  capacity: number;
  isActive: boolean;
}

type ClassListState =
  | { status: "loading" }
  | { status: "success"; data: ClassRow[] }
  | { status: "error"; message: string };

function ClassManagement({ academyId }: { academyId: string }) {
  const [state, setState] = useState<ClassListState>({ status: "loading" });
  const [showCreate, setShowCreate] = useState(false);
  const [editClass, setEditClass] = useState<ClassRow | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);

  const academyIdRef = useRef(academyId);
  useEffect(() => { academyIdRef.current = academyId; }, [academyId]);

  const fetchList = useCallback(async () => {
    const aid = academyId;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/classes?academyId=${aid}`, { credentials: "same-origin" });
      const data = (await res.json()) as { classes?: ClassRow[]; error?: { message?: string } };
      if (aid !== academyIdRef.current) return;
      if (!res.ok || !data.classes) {
        setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
        return;
      }
      setState({ status: "success", data: data.classes });
    } catch {
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/classes?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled) return;
        const data = (await res.json()) as { classes?: ClassRow[]; error?: { message?: string } };
        if (cancelled) return;
        if (!res.ok || !data.classes) {
          setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.classes });
      } catch {
        if (cancelled) return;
        setState({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => { cancelled = true; };
  }, [academyId]);

  if (selectedClassId) {
    return (
      <ClassDetail
        classId={selectedClassId}
        academyId={academyId}
        onBack={() => { setSelectedClassId(null); fetchList(); }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Kelas</h3>
        <Button className="gap-2" onClick={() => setShowCreate(true)}>
          <UserPlus className="h-4 w-4" aria-hidden /> Tambah Kelas
        </Button>
      </div>

      {state.status === "loading" && (
        <Card><CardContent className="flex items-center gap-3 p-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">Memuat kelas…</p>
        </CardContent></Card>
      )}

      {state.status === "error" && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm font-medium text-destructive">Gagal memuat kelas</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={fetchList}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {state.status === "success" && (
        <>
          {state.data.length === 0 ? (
            <Card><CardContent className="p-8 text-center">
              <CalendarDays className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-sm font-medium">Tidak ada kelas</p>
              <p className="mt-1 text-sm text-muted-foreground">Klik &ldquo;Tambah Kelas&rdquo; untuk membuat kelas pertama.</p>
            </CardContent></Card>
          ) : (
            <div className="space-y-2">
              {state.data.map((c) => (
                <Card key={c.id} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => setSelectedClassId(c.id)}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <p className="font-medium">{c.name}</p>
                      <p className="text-sm text-muted-foreground">Kapasitas: {c.capacity}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!c.isActive && <Badge variant="outline">Tidak Aktif</Badge>}
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setEditClass(c); }} aria-label={`Ubah kelas ${c.name}`}><Pencil className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {showCreate && (
        <CreateClassDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          academyId={academyId}
          onCreated={() => { setShowCreate(false); fetchList(); }}
        />
      )}
      {editClass && (
        <EditClassDialog
          open={editClass !== null}
          onClose={() => setEditClass(null)}
          classRow={editClass}
          academyId={academyId}
          onSaved={() => { setEditClass(null); fetchList(); }}
        />
      )}
    </div>
  );
}

// === Class Detail (with schedule versions, slots, occurrences) =========

interface ScheduleVersion {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
}

interface SlotRow {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  capacityOverride: number | null;
}

interface OccurrenceRow {
  id: string;
  occurrenceDate: string;
  startAt: string;
  endAt: string;
  status: string;
  capacity: number;
  cancelledReason: string | null;
}

const WEEKDAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

function ClassDetail({ classId, academyId, onBack }: {
  classId: string; academyId: string; onBack: () => void;
}) {
  const [className, setClassName] = useState("Memuat…");
  const [versions, setVersions] = useState<ScheduleVersion[]>([]);
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [occurrences, setOccurrences] = useState<OccurrenceRow[]>([]);
  const [showCreateVersion, setShowCreateVersion] = useState(false);
  const [showAddSlot, setShowAddSlot] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [genResult, setGenResult] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    try {
      const [classRes, versionRes, occRes] = await Promise.all([
        fetch(`/api/admin/classes/${classId}?academyId=${academyId}`, { credentials: "same-origin" }),
        fetch(`/api/admin/classes/${classId}/schedule-versions?academyId=${academyId}`, { credentials: "same-origin" }),
        fetch(`/api/admin/classes/${classId}/occurrences?academyId=${academyId}`, { credentials: "same-origin" }),
      ]);
      if (cancelled) return;
      if (!classRes.ok) { setError("Gagal memuat kelas"); return; }
      const classData = (await classRes.json()) as { name?: string };
      if (cancelled) return;
      setClassName(classData.name ?? "Tidak diketahui");
      const versionData = versionRes.ok ? ((await versionRes.json()) as { versions?: ScheduleVersion[] }).versions ?? [] : [];
      setVersions(versionData);
      const activeVersion = versionData.find((v) => v.status === "active");
      if (activeVersion) {
        const slotsRes = await fetch(`/api/admin/schedule-versions/${activeVersion.id}/slots?academyId=${academyId}`, { credentials: "same-origin" });
        if (slotsRes.ok) {
          const slotsData = (await slotsRes.json()) as { slots?: SlotRow[] };
          if (!cancelled) setSlots(slotsData.slots ?? []);
        }
      } else {
        setSlots([]);
      }
      const occData = occRes.ok ? ((await occRes.json()) as { occurrences?: OccurrenceRow[] }).occurrences ?? [] : [];
      if (!cancelled) setOccurrences(occData);
    } catch { if (!cancelled) setError("Kesalahan jaringan"); }
    finally { if (!cancelled) setLoading(false); }
    return () => { cancelled = true; };
  }, [classId, academyId]);

  useEffect(() => { void refetch(); }, [refetch]);

  if (loading) {
    return <Card><CardContent className="flex items-center gap-3 p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden /><p className="text-sm text-muted-foreground">Memuat kelas…</p></CardContent></Card>;
  }
  if (error) {
    return <Card className="border-destructive/30"><CardContent className="p-6"><div className="flex items-start gap-3"><AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden /><div><p className="text-sm font-medium text-destructive">{error}</p><Button variant="outline" size="sm" className="mt-3 gap-2" onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden /> Kembali</Button></div></div></CardContent></Card>;
  }

  const activeVersion = versions.find((v) => v.status === "active");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2"><ArrowLeft className="h-4 w-4" aria-hidden /> Kembali</Button>
        <h2 className="text-lg font-semibold">{className}</h2>
      </div>

      {/* Schedule Versions */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Versi Jadwal</CardTitle>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowCreateVersion(true)}>
            <UserPlus className="h-4 w-4" aria-hidden /> Versi Baru
          </Button>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada versi jadwal. Buat versi untuk menentukan hari dan jam latihan.</p>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                  <div>
                    <p className="font-medium">Dari: {v.effectiveFrom}{v.effectiveTo ? ` → Sampai: ${v.effectiveTo}` : ""}</p>
                    <p className="text-muted-foreground">Status: {v.status === "active" ? "Aktif" : v.status === "superseded" ? "Digantikan" : v.status}</p>
                  </div>
                  {v.status === "active" && <Badge>Aktif</Badge>}
                  {v.status === "superseded" && <Badge variant="outline">Digantikan</Badge>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Slots (for active version) */}
      {activeVersion && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Jadwal Latihan</CardTitle>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowAddSlot(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> Tambah Jadwal
            </Button>
          </CardHeader>
          <CardContent>
            {slots.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada jadwal latihan. Tambah jadwal latihan (cth., Selasa 15:00-16:00).</p>
            ) : (
              <div className="space-y-2">
                {slots.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                    <div>
                      <p className="font-medium">{WEEKDAY_NAMES[s.weekday]} {s.startTime}–{s.endTime}</p>
                      {s.capacityOverride && <p className="text-muted-foreground">Override kapasitas: {s.capacityOverride}</p>}
                    </div>
                    <DeleteSlotButton slotId={s.id} academyId={academyId} onDeleted={refetch} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Occurrence Generation */}
      {activeVersion && slots.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Sesi Latihan</CardTitle>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowGenerate(true)}>
              <CalendarDays className="h-4 w-4" aria-hidden /> Buat
            </Button>
          </CardHeader>
          <CardContent>
            {genResult && <p className="text-sm text-emerald-600 mb-3">{genResult}</p>}
            {occurrences.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada sesi latihan yang dibuat.</p>
            ) : (
              <div className="max-h-96 overflow-y-auto space-y-1.5">
                {occurrences.slice(0, 50).map((o) => (
                  <div key={o.id} className="flex items-center justify-between rounded border p-2 text-sm">
                    <span>{o.occurrenceDate}</span>
                    <div className="flex items-center gap-2">
                      {o.status === "cancelled" && <Badge variant="destructive">Dibatalkan</Badge>}
                      {o.status === "planned" && <Badge variant="secondary">Direncanakan</Badge>}
                      {o.status === "completed" && <Badge>Selesai</Badge>}
                      <span className="text-muted-foreground text-xs">{o.capacity} kap</span>
                    </div>
                  </div>
                ))}
                {occurrences.length > 50 && <p className="text-xs text-muted-foreground">Menampilkan 50 dari {occurrences.length}</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dialogs */}
      {showCreateVersion && (
        <CreateVersionDialog open={showCreateVersion} onClose={() => setShowCreateVersion(false)} classId={classId} academyId={academyId} onCreated={() => { setShowCreateVersion(false); refetch(); }} />
      )}
      {showAddSlot && activeVersion && (
        <AddSlotDialog open={showAddSlot} onClose={() => setShowAddSlot(false)} versionId={activeVersion.id} academyId={academyId} onAdded={() => { setShowAddSlot(false); refetch(); }} />
      )}
      {showGenerate && (
        <GenerateDialog open={showGenerate} onClose={() => setShowGenerate(false)} classId={classId} academyId={academyId} onGenerated={(msg) => { setShowGenerate(false); setGenResult(msg); refetch(); }} />
      )}
    </div>
  );
}

// === Delete Slot Button =================================================

function DeleteSlotButton({ slotId, academyId, onDeleted }: { slotId: string; academyId: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setSubmitting(true); setError(null);
    try {
      const res = await adminFetch(`/api/admin/schedule-slots/${slotId}?academyId=${academyId}`, "DELETE", {});
      if (res.ok) { toast({ title: "Jadwal latihan dihapus" }); onDeleted(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menghapus jadwal latihan", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal menghapus jadwal latihan", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button variant="destructive" size="sm" disabled={submitting} onClick={handleDelete}>{submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "Konfirmasi"}</Button>
        <Button variant="outline" size="sm" onClick={() => { setConfirming(false); setError(null); }}>Batal</Button>
      </div>
    );
  }
  return <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label="Hapus jadwal latihan"><Trash2 className="h-4 w-4" aria-hidden /></Button>;
}

// === Create Version Dialog =============================================

function CreateVersionDialog({ open, onClose, classId, academyId, onCreated }: {
  open: boolean; onClose: () => void; classId: string; academyId: string; onCreated: () => void;
}) {
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().split("T")[0]!);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setSubmitting(false); setError(null); } }, [open]);

  const handleSubmit = async () => {
    if (!effectiveFrom) { setError("Tanggal efektif wajib diisi."); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await adminFetch(`/api/admin/classes/${classId}/schedule-versions?academyId=${academyId}`, "POST", { effectiveFrom });
      if (res.status === 201) { toast({ title: "Versi jadwal dibuat" }); onCreated(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal membuat versi jadwal", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal membuat versi jadwal", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Versi Jadwal Baru</DialogTitle><DialogDescription>Ini akan menggantikan versi aktif yang ada.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="version-date">Berlaku dari *</Label>
            <Input id="version-date" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} disabled={submitting} />
          </div>
          {error && <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"><AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden /><p className="text-sm text-destructive">{error}</p></div>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Membuat…</> : "Buat Versi"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Add Slot Dialog ===================================================

function AddSlotDialog({ open, onClose, versionId, academyId, onAdded }: {
  open: boolean; onClose: () => void; versionId: string; academyId: string; onAdded: () => void;
}) {
  const [weekday, setWeekday] = useState("2");
  const [startTime, setStartTime] = useState("15:00");
  const [endTime, setEndTime] = useState("16:00");
  const [capacityOverride, setCapacityOverride] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setSubmitting(false); setError(null); } }, [open]);

  const handleSubmit = async () => {
    if (startTime >= endTime) { setError("Jam selesai harus setelah jam mulai."); return; }
    setSubmitting(true); setError(null);
    try {
      const body: Record<string, unknown> = { weekday: parseInt(weekday, 10), startTime, endTime };
      if (capacityOverride) { const n = parseInt(capacityOverride, 10); if (n > 0) body.capacityOverride = n; }
      const res = await adminFetch(`/api/admin/schedule-versions/${versionId}/slots?academyId=${academyId}`, "POST", body);
      if (res.status === 201) { toast({ title: "Jadwal latihan ditambahkan" }); onAdded(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menambah jadwal latihan", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal menambah jadwal latihan", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Tambah Jadwal Latihan</DialogTitle><DialogDescription>Tentukan hari dan jam latihan berulang.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="slot-weekday">Hari *</Label>
            <Select value={weekday} onValueChange={setWeekday} disabled={submitting}>
              <SelectTrigger id="slot-weekday"><SelectValue /></SelectTrigger>
              <SelectContent>
                {WEEKDAY_NAMES.map((name, i) => (<SelectItem key={i} value={String(i)}>{name}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2"><Label htmlFor="slot-start">Jam Mulai *</Label><Input id="slot-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={submitting} /></div>
            <div className="space-y-2"><Label htmlFor="slot-end">Jam Selesai *</Label><Input id="slot-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={submitting} /></div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="slot-capacity">Override Kapasitas (opsional)</Label>
            <Input id="slot-capacity" type="number" value={capacityOverride} onChange={(e) => setCapacityOverride(e.target.value)} disabled={submitting} placeholder="Gunakan default kelas" />
          </div>
          {error && <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"><AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden /><p className="text-sm text-destructive">{error}</p></div>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menambah…</> : "Tambah Jadwal"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Generate Occurrences Dialog ======================================

function GenerateDialog({ open, onClose, classId, academyId, onGenerated }: {
  open: boolean; onClose: () => void; classId: string; academyId: string; onGenerated: (msg: string) => void;
}) {
  const [weeksAhead, setWeeksAhead] = useState("16");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setSubmitting(false); setError(null); } }, [open]);

  const handleSubmit = async () => {
    const weeks = parseInt(weeksAhead, 10);
    if (!weeks || weeks < 1 || weeks > 52) { setError("Jumlah minggu harus 1-52."); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await adminFetch(`/api/admin/classes/${classId}/generate-occurrences?academyId=${academyId}`, "POST", { weeksAhead: weeks });
      if (res.ok) {
        const data = (await res.json()) as { generated: number; idempotent: boolean };
        toast({ title: `${data.generated} sesi latihan dibuat` });
        onGenerated(`${data.generated} sesi latihan baru dibuat.${data.idempotent ? " Semua sudah ada." : ""}`);
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal membuat sesi latihan", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal membuat sesi latihan", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Buat Sesi Latihan Otomatis</DialogTitle><DialogDescription>Buat sesi latihan mendatang dari versi jadwal aktif.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="gen-weeks">Minggu ke depan *</Label>
            <Input id="gen-weeks" type="number" value={weeksAhead} onChange={(e) => setWeeksAhead(e.target.value)} disabled={submitting} min={1} max={52} />
            <p className="text-xs text-muted-foreground">1-52 minggu. Pembuatan bersifat idempoten — menjalankan dua kali tidak membuat duplikat.</p>
          </div>
          {error && <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"><AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden /><p className="text-sm text-destructive">{error}</p></div>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Membuat…</> : "Buat"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Create Class Dialog ================================================

function CreateClassDialog({ open, onClose, academyId, onCreated }: {
  open: boolean; onClose: () => void; academyId: string; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setName(""); setCapacity(""); setSubmitting(false); setError(null); } }, [open]);

  const handleSubmit = async () => {
    if (!name.trim()) { setError("Nama kelas wajib diisi."); return; }
    setSubmitting(true); setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (capacity) { const n = parseInt(capacity, 10); if (n > 0) body.capacity = n; }
      const res = await adminFetch(`/api/admin/classes?academyId=${academyId}`, "POST", body);
      if (res.status === 201) { toast({ title: "Kelas dibuat" }); onCreated(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal membuat kelas", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal membuat kelas", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tambah Kelas Baru</DialogTitle>
          <DialogDescription>Buat kelas latihan baru di akademi ini.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="create-class-name">Nama Kelas *</Label>
            <Input id="create-class-name" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} placeholder="cth., Kelompok Pemula" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-class-capacity">Kapasitas (opsional, default 12)</Label>
            <Input id="create-class-capacity" type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} disabled={submitting} placeholder="12" />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Membuat…</> : "Buat Kelas"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// === Edit Class Dialog ==================================================

function EditClassDialog({ open, onClose, classRow, academyId, onSaved }: {
  open: boolean; onClose: () => void; classRow: ClassRow; academyId: string; onSaved: () => void;
}) {
  const [name, setName] = useState(classRow.name);
  const [capacity, setCapacity] = useState(String(classRow.capacity));
  const [isActive, setIsActive] = useState(classRow.isActive);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) { setError("Nama kelas wajib diisi."); return; }
    setSubmitting(true); setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      const capNum = parseInt(capacity, 10);
      if (capNum > 0) body.capacity = capNum;
      body.isActive = isActive;
      const res = await adminFetch(`/api/admin/classes/${classRow.id}?academyId=${academyId}`, "PUT", body);
      if (res.ok) { toast({ title: "Kelas diperbarui" }); onSaved(); return; }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Kesalahan ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memperbarui kelas", description: failMsg, variant: "destructive" });
    } catch { setError("Kesalahan jaringan"); toast({ title: "Gagal memperbarui kelas", description: "Kesalahan jaringan", variant: "destructive" }); }
    finally { setSubmitting(false); }
  };

  const handleClose = () => { if (submitting) return; onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Ubah Kelas</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-class-name">Nama Kelas *</Label>
            <Input id="edit-class-name" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-class-capacity">Kapasitas</Label>
            <Input id="edit-class-capacity" type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} disabled={submitting} />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="edit-class-active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={submitting} className="h-4 w-4 rounded border-gray-300" />
            <Label htmlFor="edit-class-active" className="text-sm">Aktif</Label>
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menyimpan…</> : "Simpan Perubahan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
