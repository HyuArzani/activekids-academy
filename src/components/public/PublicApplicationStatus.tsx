"use client";

import { useState } from "react";
import {
  ArrowLeft,
  Search,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// ============================================================================
// Types
// ============================================================================

interface ApplicationStatus {
  id: string;
  status: "pending" | "approved" | "rejected";
  childFullName: string;
  submittedAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
}

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "error"; message: string }
  | { status: "found"; data: ApplicationStatus };

// ============================================================================
// Component
// ============================================================================

interface PublicApplicationStatusProps {
  onBack: () => void;
}

export function PublicApplicationStatus({ onBack }: PublicApplicationStatusProps) {
  const [referenceId, setReferenceId] = useState("");
  const [state, setState] = useState<LookupState>({ status: "idle" });

  const handleLookup = async () => {
    if (!referenceId.trim()) {
      setState({ status: "error", message: "Silakan masukkan nomor referensi pendaftaran Anda." });
      return;
    }
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/public/application?id=${encodeURIComponent(referenceId.trim())}`);
      if (res.status === 404) {
        setState({ status: "not_found" });
        return;
      }
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        setState({ status: "error", message: data.error?.message ?? `Kesalahan ${res.status}` });
        return;
      }
      const data = (await res.json()) as { application: ApplicationStatus };
      setState({ status: "found", data: data.application });
    } catch {
      setState({ status: "error", message: "Kesalahan jaringan. Silakan coba lagi." });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handleLookup();
  };

  const formatDate = (iso: string | null): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* ===== Top Bar ===== */}
      <div className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3 sm:px-6">
          <p className="text-sm font-semibold">Cek Status Pendaftaran</p>
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali ke Akademi
          </Button>
        </div>
      </div>

      <div className="mx-auto max-w-md px-4 py-12 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Search className="h-5 w-5 text-primary" aria-hidden />
              Cek Status Pendaftaran
            </CardTitle>
            <CardDescription>
              Masukkan nomor referensi yang Anda terima setelah mengirim pendaftaran.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ref-id">Nomor Referensi Pendaftaran</Label>
                <Input
                  id="ref-id"
                  value={referenceId}
                  onChange={(e) => setReferenceId(e.target.value)}
                  placeholder="e.g. a9e0c865-d10d-4c2b-a956-bf5704b6641d"
                  className="font-mono text-sm"
                  disabled={state.status === "loading"}
                />
              </div>
              {state.status === "error" && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
                  <p className="text-sm text-destructive">{state.message}</p>
                </div>
              )}
              <Button type="submit" className="w-full gap-2" disabled={state.status === "loading"}>
                {state.status === "loading" ? (
                  <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memeriksa…</>
                ) : (
                  <><Search className="h-4 w-4" aria-hidden /> Cek Status</>
                )}
              </Button>
            </form>

            {/* Not found */}
            {state.status === "not_found" && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/50">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Pendaftaran tidak ditemukan</p>
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      Kami tidak dapat menemukan pendaftaran dengan nomor referensi tersebut. Silakan periksa kembali nomor referensi dari
                      konfirmasi Anda dan coba lagi. Jika masih bermasalah, silakan hubungi akademi langsung.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Found */}
            {state.status === "found" && (
              <div className="mt-4 space-y-3">
                {/* Status banner */}
                <div
                  className={`rounded-lg border p-4 ${
                    state.data.status === "approved"
                      ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/50"
                      : state.data.status === "rejected"
                        ? "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/50"
                        : "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {state.data.status === "approved" && (
                      <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    )}
                    {state.data.status === "rejected" && (
                      <XCircle className="h-8 w-8 text-rose-600 dark:text-rose-400" aria-hidden />
                    )}
                    {state.data.status === "pending" && (
                      <Clock className="h-8 w-8 text-amber-600 dark:text-amber-400" aria-hidden />
                    )}
                    <div>
                      <p
                        className={`text-lg font-semibold capitalize ${
                          state.data.status === "approved"
                            ? "text-emerald-800 dark:text-emerald-300"
                            : state.data.status === "rejected"
                              ? "text-rose-800 dark:text-rose-300"
                              : "text-amber-800 dark:text-amber-300"
                        }`}
                      >
                        {state.data.status === "approved" ? "Disetujui" : state.data.status === "rejected" ? "Ditolak" : "Menunggu"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Pendaftaran untuk {state.data.childFullName}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Details */}
                <div className="space-y-2 rounded-lg border p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Calendar className="h-3.5 w-3.5" aria-hidden /> Dikirim
                    </span>
                    <span className="font-medium">{formatDate(state.data.submittedAt)}</span>
                  </div>
                  {state.data.reviewedAt && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Ditinjau
                      </span>
                      <span className="font-medium">{formatDate(state.data.reviewedAt)}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Nomor Referensi</span>
                    <span className="font-mono text-xs text-muted-foreground">{state.data.id.slice(0, 8)}…</span>
                  </div>
                </div>

                {/* Status-specific message */}
                {state.data.status === "pending" && (
                  <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
                    Pendaftaran Anda sedang ditinjau. Tim kami akan menghubungi Anda dalam 1–2 hari kerja.
                  </div>
                )}
                {state.data.status === "approved" && (
                  <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                    Pendaftaran Anda telah disetujui! Akun siswa dan login wali telah dibuat.
                    Anda akan menerima petunjuk login sebentar lagi.
                  </div>
                )}
                {state.data.status === "rejected" && state.data.rejectionReason && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950/50">
                    <p className="text-xs font-medium uppercase tracking-wide text-rose-600 dark:text-rose-400">
                      Alasan
                    </p>
                    <p className="mt-1 text-sm text-rose-700 dark:text-rose-400">{state.data.rejectionReason}</p>
                  </div>
                )}
                {state.data.status === "rejected" && !state.data.rejectionReason && (
                  <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-400">
                    Pendaftaran Anda tidak disetujui. Silakan hubungi akademi untuk informasi lebih lanjut.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Kehilangan nomor referensi? Silakan hubungi akademi langsung.
        </p>
      </div>
    </div>
  );
}
