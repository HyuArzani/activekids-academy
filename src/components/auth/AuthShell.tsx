"use client";

import { useState, useEffect } from "react";
import { Database, LogIn, LogOut, KeyRound, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { DashboardOverview } from "@/components/dashboard/DashboardOverview";
import { StudentListNoAccess } from "@/components/students/StudentList";
import { ParentPortal } from "@/components/parent/ParentPortal";
import { AdminShell } from "@/components/admin/AdminShell";
import { PublicLandingPage } from "@/components/public/PublicLandingPage";
import { PublicRegistrationForm } from "@/components/public/PublicRegistrationForm";
import { PublicApplicationStatus } from "@/components/public/PublicApplicationStatus";

interface SanitizedPrincipal {
  userId: string;
  email: string;
  fullName: string | null;
  mustChangePassword: boolean;
  memberships: { academyId: string; role: "admin" | "coach" | "parent" }[];
}

type View = "loading" | "landing" | "loginForm" | "registerForm" | "applicationStatus" | "changePassword" | "loggedIn";

interface FormState {
  loading: boolean;
  error: string | null;
  success: string | null;
}

const INITIAL_FORM: FormState = { loading: false, error: null, success: null };

/**
 * The default academy ID shown on the public landing page when no session
 * is active. This matches the seed script's ACADEMY_ID
 * (00000000-0000-0000-0000-000000000001). In a multi-academy deployment,
 * this would be resolved from the domain or a path parameter.
 */
const DEFAULT_LANDING_ACADEMY_ID = "00000000-0000-0000-0000-000000000001";

export function AuthShell() {
  const [view, setView] = useState<View>("loading");
  const [principal, setPrincipal] = useState<SanitizedPrincipal | null>(null);
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [loginState, setLoginState] = useState<FormState>(INITIAL_FORM);
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "" });
  const [pwState, setPwState] = useState<FormState>(INITIAL_FORM);
  // Shared academy selection across admin + parent views.
  const [selectedAcademyId, setSelectedAcademyId] = useState("");

  // Initial session load. Inlined IIFE so the React Compiler doesn't flag
  // a useCallback dependency on setState (the setState calls happen after
  // await, so they're not synchronous-within-effect, but the compiler's
  // static analysis is conservative).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/session");
        if (cancelled) return;
        if (res.status === 401 || !res.ok) {
          setPrincipal(null);
          setView("landing");
          return;
        }
        const data = (await res.json()) as { principal: SanitizedPrincipal };
        if (cancelled) return;
        setPrincipal(data.principal);
        // Initialize the shared academy selection to the first admin or parent membership.
        const firstAcademy = data.principal.memberships.find(
          (m) => m.role === "admin",
        )?.academyId ?? data.principal.memberships.find(
          (m) => m.role === "parent",
        )?.academyId;
        if (firstAcademy) {
          setSelectedAcademyId(firstAcademy);
        }
        setView(data.principal.mustChangePassword ? "changePassword" : "loggedIn");
      } catch {
        if (cancelled) return;
        setPrincipal(null);
        setView("landing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginState({ loading: true, error: null, success: null });
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      const data = (await res.json()) as { principal?: SanitizedPrincipal; error?: { message?: string } };
      if (!res.ok) {
        setLoginState({
          loading: false,
          error: data.error?.message ?? "Gagal masuk",
          success: null,
        });
        return;
      }
      if (data.principal) {
        setPrincipal(data.principal);
        setView(data.principal.mustChangePassword ? "changePassword" : "loggedIn");
        setLoginForm({ email: "", password: "" });
        setLoginState({ loading: false, error: null, success: "Berhasil masuk" });
      }
    } catch {
      setLoginState({ loading: false, error: "Kesalahan jaringan", success: null });
    }
  }

  async function handleLogout() {
    // Read CSRF cookie (NOT HttpOnly, JS can read it)
    const csrfMatch = document.cookie
      .split("; ")
      .find((c) => c.startsWith("futsal_csrf="));
    const csrfToken = csrfMatch?.split("=")[1] ?? "";
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
      });
    } catch {
      // ignore — logout is idempotent
    }
    setPrincipal(null);
    setSelectedAcademyId("");
    setView("landing");
  }

  // Called when a parent-portal fetch returns 401 (session expired).
  // Resets to the landing view without calling the logout API (the session
  // is already invalid; calling logout would be redundant).
  function handleSessionExpired() {
    setPrincipal(null);
    setSelectedAcademyId("");
    setView("landing");
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwState({ loading: true, error: null, success: null });
    // Read the CSRF cookie (NOT HttpOnly, JS can read it) for the
    // X-CSRF-Token header. The change-password endpoint requires CSRF
    // protection (same as logout).
    const csrfMatch = document.cookie
      .split("; ")
      .find((c) => c.startsWith("futsal_csrf="));
    const csrfToken = csrfMatch?.split("=")[1] ?? "";
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(pwForm),
      });
      const data = (await res.json()) as { principal?: SanitizedPrincipal; error?: { message?: string } };
      if (!res.ok) {
        setPwState({
          loading: false,
          error: data.error?.message ?? "Gagal mengubah kata sandi",
          success: null,
        });
        return;
      }
      if (data.principal) {
        setPrincipal(data.principal);
        setView("loggedIn");
        setPwForm({ currentPassword: "", newPassword: "" });
        setPwState({ loading: false, error: null, success: "Kata sandi diubah" });
      }
    } catch {
      setPwState({ loading: false, error: "Kesalahan jaringan", success: null });
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <Database className="h-6 w-6" aria-hidden />
            </div>
            <div>
              <h1 className="text-xl font-semibold leading-tight sm:text-2xl">
                Futsal Academy Management System
              </h1>
              <p className="text-sm text-muted-foreground">
                {principal?.memberships.some((m) => m.role === "parent") && !principal?.memberships.some((m) => m.role === "admin")
                  ? "Portal Wali"
                  : "Dasbor Admin"}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {view === "loading" && (
          <Card>
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground">Memuat sesi…</p>
            </CardContent>
          </Card>
        )}

        {view === "landing" && (
          <PublicLandingPage
            academyId={DEFAULT_LANDING_ACADEMY_ID}
            onLoginClick={() => setView("loginForm")}
            onRegisterClick={() => setView("registerForm")}
            onCheckStatusClick={() => setView("applicationStatus")}
          />
        )}

        {view === "registerForm" && (
          <PublicRegistrationForm
            academyId={DEFAULT_LANDING_ACADEMY_ID}
            academyName="Futsal Academy"
            onBack={() => setView("landing")}
          />
        )}

        {view === "applicationStatus" && (
          <PublicApplicationStatus onBack={() => setView("landing")} />
        )}

        {view === "loginForm" && (
          <Card className="mx-auto max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LogIn className="h-5 w-5" aria-hidden /> Masuk
              </CardTitle>
              <CardDescription>Masukkan kredensial Anda untuk melanjutkan.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={loginForm.email}
                    onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                    disabled={loginState.loading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Kata Sandi</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={8}
                    value={loginForm.password}
                    onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                    disabled={loginState.loading}
                  />
                </div>
                {loginState.error && (
                  <p className="text-sm text-destructive flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" aria-hidden />
                    {loginState.error}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={loginState.loading}>
                  {loginState.loading ? "Memproses…" : "Masuk"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Tidak ada pendaftaran publik. Akun admin dibuat melalui
                  skrip tepercaya <code>scripts/provision-admin.ts</code>.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setView("landing")}
                >
                  ← Kembali ke halaman akademi
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {view === "changePassword" && principal && (
          <Card className="mx-auto max-w-md border-amber-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <KeyRound className="h-5 w-5" aria-hidden /> Perubahan kata sandi diperlukan
              </CardTitle>
              <CardDescription>
                Akun Anda dibuat dengan kata sandi awal. Anda harus
                mengatur kata sandi baru sebelum mengakses sistem.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="currentPassword">Kata sandi saat ini</Label>
                  <Input
                    id="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={pwForm.currentPassword}
                    onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                    disabled={pwState.loading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newPassword">Kata sandi baru (min 8 karakter)</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={pwForm.newPassword}
                    onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                    disabled={pwState.loading}
                  />
                </div>
                {pwState.error && (
                  <p className="text-sm text-destructive flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" aria-hidden />
                    {pwState.error}
                  </p>
                )}
                {pwState.success && (
                  <p className="text-sm text-emerald-600 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    {pwState.success}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={pwState.loading}>
                  {pwState.loading ? "Mengubah…" : "Ubah Kata Sandi"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {view === "loggedIn" && principal && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
                  Tervalidasi
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Masuk sebagai</p>
                    <p className="text-base font-medium">{principal.email}</p>
                    <ul className="mt-2 space-y-0.5">
                      {principal.memberships.map((m) => (
                        <li key={`${m.academyId}-${m.role}`} className="text-sm">
                          <span className="font-medium capitalize">{m.role}</span>
                          {" · akademi "}
                          <code className="rounded bg-muted px-1 py-0.5 text-xs">
                            {m.academyId.slice(0, 8)}
                          </code>
                        </li>
                      ))}
                      {principal.memberships.length === 0 && (
                        <li className="text-sm text-muted-foreground">Tidak ada keanggotaan aktif</li>
                      )}
                    </ul>
                  </div>
                  <div className="flex-shrink-0">
                    <Button variant="outline" onClick={handleLogout} className="gap-2">
                      <LogOut className="h-4 w-4" aria-hidden /> Keluar
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Role-based views */}
            {principal.memberships.some((m) => m.role === "admin") ? (
              <AdminShell
                memberships={principal.memberships}
                selectedAcademyId={selectedAcademyId}
                onSelectAcademy={setSelectedAcademyId}
              />
            ) : principal.memberships.some((m) => m.role === "parent") ? (
              <ParentPortal
                memberships={principal.memberships}
                selectedAcademyId={selectedAcademyId}
                onSelectAcademy={setSelectedAcademyId}
                onSessionExpired={handleSessionExpired}
              />
            ) : (
              <StudentListNoAccess />
            )}
          </div>
        )}
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="mx-auto max-w-5xl px-4 py-4 text-xs text-muted-foreground sm:px-6">
          Futsal Academy Management System · Argon2id + opaque session tokens + CSRF + DB-backed rate limiting
        </div>
      </footer>
    </div>
  );
}
