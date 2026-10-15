"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Package,
  Plus,
  AlertCircle,
  Loader2,
  RefreshCw,
  Pencil,
  Check,
  X,
  Calendar,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { toast } from "@/hooks/use-toast";

// ============================================================================
// Types
// ============================================================================

interface PackagePlan {
  id: string;
  name: string;
  sessionCount: number;
  isActive: boolean;
}

/** Raw shape returned by GET /api/admin/package-plans (snake_case from DB). */
interface PackagePlanApi {
  id: string;
  name: string;
  session_count: number;
  is_active: boolean;
}

function mapPlan(p: PackagePlanApi): PackagePlan {
  return {
    id: p.id,
    name: p.name,
    sessionCount: p.session_count,
    isActive: p.is_active,
  };
}

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: PackagePlan[] };

// ============================================================================
// Shared fetch helper
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
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ============================================================================
// Main component
// ============================================================================

export function PackagesManagement({ academyId }: { academyId: string }) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [showCreate, setShowCreate] = useState(false);
  const [editPlan, setEditPlan] = useState<PackagePlan | null>(null);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token (stale-response guard). Mirrors the
  // RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchList = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/package-plans?academyId=${aid}`, { credentials: "same-origin" });
      const data = (await res.json()) as { plans?: PackagePlanApi[]; error?: { message?: string } };
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok || !data.plans) {
        setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      setState({ status: "success", data: data.plans.map(mapPlan) });
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    const myRequestId = ++requestIdRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/package-plans?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        const data = (await res.json()) as { plans?: PackagePlanApi[]; error?: { message?: string } };
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok || !data.plans) {
          setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.plans.map(mapPlan) });
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setState({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">Paket</h3>
          <p className="text-xs text-muted-foreground">
            Kelola paket latihan sesi. Tiap paket menentukan jumlah sesi yang diterima siswa saat membelinya.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchList} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" aria-hidden /> Tambah Paket
          </Button>
        </div>
      </div>

      {/* Loading */}
      {state.status === "loading" && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat paket latihan…</p>
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
                <p className="text-sm font-medium text-destructive">Gagal memuat paket latihan</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={fetchList}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty */}
      {state.status === "success" && state.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <Package className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">Belum ada paket latihan</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Klik &ldquo;Tambah Paket&rdquo; untuk membuat paket sesi pertama Anda (mis. &ldquo;Starter 4&rdquo; untuk 4 sesi).
            </p>
          </CardContent>
        </Card>
      )}

      {/* Plans grid */}
      {state.status === "success" && state.data.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {state.data.map((plan) => (
            <PackagePlanCard key={plan.id} plan={plan} academyId={academyId} onEdit={() => setEditPlan(plan)} />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {showCreate && (
        <CreatePlanDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          academyId={academyId}
          onCreated={() => {
            setShowCreate(false);
            void fetchList();
          }}
        />
      )}
      {editPlan && (
        <EditPlanDialog
          open={editPlan !== null}
          onClose={() => setEditPlan(null)}
          plan={editPlan}
          academyId={academyId}
          onSaved={() => {
            setEditPlan(null);
            void fetchList();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Package Plan Card
// ============================================================================

function PackagePlanCard({
  plan,
  academyId: _academyId,
  onEdit,
}: {
  plan: PackagePlan;
  academyId: string;
  onEdit: () => void;
}) {
  return (
    <Card className="group transition-all hover:border-primary/40 hover:shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Package className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <CardTitle className="text-base leading-tight">{plan.name}</CardTitle>
              <CardDescription className="mt-0.5">
                {plan.sessionCount} sesi
              </CardDescription>
            </div>
          </div>
          {plan.isActive ? (
            <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
              Aktif
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Tidak Aktif
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{plan.sessionCount}</span> sesi latihan per pembelian
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            aria-label={`Ubah ${plan.name}`}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Create Plan Dialog
// ============================================================================

function CreatePlanDialog({
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
  const [name, setName] = useState("");
  const [sessionCount, setSessionCount] = useState("4");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setSessionCount("4");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Nama wajib diisi.");
      return;
    }
    const count = parseInt(sessionCount, 10);
    if (!count || count < 1) {
      setError("Jumlah sesi harus bilangan bulat positif.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/package-plans?academyId=${academyId}`, "POST", {
        name: name.trim(),
        sessionCount: count,
      });
      if (res.status === 201) {
        toast({ title: "Paket latihan ditambahkan" });
        onCreated();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menambah paket latihan", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal menambah paket latihan", description: "Kesalahan jaringan", variant: "destructive" });
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
          <DialogTitle>Tambah Paket Latihan</DialogTitle>
          <DialogDescription>Buat paket latihan sesi baru.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plan-name">Nama Paket *</Label>
            <Input
              id="plan-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              placeholder="mis. Starter 4"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plan-sessions">Jumlah Sesi *</Label>
            <Input
              id="plan-sessions"
              type="number"
              min={1}
              value={sessionCount}
              onChange={(e) => setSessionCount(e.target.value)}
              disabled={submitting}
              placeholder="4"
            />
            <p className="text-xs text-muted-foreground">
              Jumlah sesi latihan yang diterima siswa saat membeli paket ini.
            </p>
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
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menambah…
              </>
            ) : (
              "Tambah Paket"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Edit Plan Dialog
// ============================================================================

function EditPlanDialog({
  open,
  onClose,
  plan,
  academyId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  plan: PackagePlan;
  academyId: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(plan.name);
  const [sessionCount, setSessionCount] = useState(String(plan.sessionCount));
  const [isActive, setIsActive] = useState(plan.isActive);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(plan.name);
      setSessionCount(String(plan.sessionCount));
      setIsActive(plan.isActive);
      setSubmitting(false);
      setError(null);
    }
  }, [open, plan]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Nama wajib diisi.");
      return;
    }
    const count = parseInt(sessionCount, 10);
    if (!count || count < 1) {
      setError("Jumlah sesi harus bilangan bulat positif.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/package-plans/${plan.id}?academyId=${academyId}`, "PATCH", {
        name: name.trim(),
        sessionCount: count,
        isActive,
      });
      if (res.ok) {
        toast({ title: "Paket latihan diperbarui" });
        onSaved();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memperbarui paket latihan", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal memperbarui paket latihan", description: "Kesalahan jaringan", variant: "destructive" });
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
          <DialogTitle>Ubah Paket Latihan</DialogTitle>
          <DialogDescription>Perbarui nama paket, jumlah sesi, atau status aktif.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-plan-name">Nama Paket *</Label>
            <Input
              id="edit-plan-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-plan-sessions">Jumlah Sesi *</Label>
            <Input
              id="edit-plan-sessions"
              type="number"
              min={1}
              value={sessionCount}
              onChange={(e) => setSessionCount(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="edit-plan-active" className="text-sm">Aktif</Label>
              <p className="text-xs text-muted-foreground">Paket tidak aktif tidak dapat dibeli.</p>
            </div>
            <Switch id="edit-plan-active" checked={isActive} onCheckedChange={setIsActive} disabled={submitting} />
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
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menyimpan…
              </>
            ) : (
              <>
                <Check className="h-4 w-4" aria-hidden /> Simpan Perubahan
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
