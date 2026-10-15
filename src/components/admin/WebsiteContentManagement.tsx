"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Globe,
  AlertCircle,
  Loader2,
  RefreshCw,
  Save,
  Upload,
  Video,
  Image as ImageIcon,
  FileText,
  History,
  Rocket,
  Undo2,
  Plus,
  Trash2,
  Star,
  ExternalLink,
  Check,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { toast } from "@/hooks/use-toast";

// ============================================================================
// Types
// ============================================================================

interface LandingContent {
  hero?: { title?: string; subtitle?: string; ctaText?: string };
  about?: { title?: string; body?: string };
  programs?: { name: string; description?: string }[];
  schedules?: { day: string; time: string; className?: string }[];
  coaches?: { name: string; role?: string; bio?: string }[];
  location?: { address?: string; mapUrl?: string };
  contact?: { phone?: string; email?: string; whatsapp?: string };
  registrationCta?: { text?: string };
  galleryItemIds?: string[];
  youtubeVideoIds?: string[];
}

interface LandingPage {
  id: string;
  academyId: string;
  draftContent: LandingContent;
  publishedPublicationId: string | null;
  draftUpdatedAt: string;
  draftUpdatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GalleryItem {
  id: string;
  academyId: string;
  title: string;
  mediaKey: string | null;
  mediaType: string;
  displayOrder: number;
  isFeatured: boolean;
  isPublished: boolean;
  createdBy: string;
  createdAt: string;
}

interface YoutubeVideo {
  id: string;
  academyId: string;
  title: string;
  videoId: string;
  url: string;
  displayOrder: number;
  isFeatured: boolean;
  isPublished: boolean;
  createdBy: string;
  createdAt: string;
}

interface Publication {
  id: string;
  landingPageId: string;
  versionNumber: number;
  content: LandingContent;
  publishedBy: string;
  publishedAt: string;
  publishNote: string | null;
}

type SubSection = "landing" | "gallery" | "videos" | "history";

// ============================================================================
// Helpers
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

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
}

function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = p.exec(url);
    if (m && m[1]) return m[1];
  }
  return null;
}

// ============================================================================
// Main component
// ============================================================================

export function WebsiteContentManagement({ academyId }: { academyId: string }) {
  const [sub, setSub] = useState<SubSection>("landing");

  const subTabs: { id: SubSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "landing", label: "Halaman Landing", icon: FileText },
    { id: "gallery", label: "Galeri", icon: ImageIcon },
    { id: "videos", label: "Video", icon: Video },
    { id: "history", label: "Riwayat Publikasi", icon: History },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">Konten Situs Web</h3>
          <p className="text-xs text-muted-foreground">
            Kelola halaman landing publik akademi, galeri, video, dan riwayat publikasi.
          </p>
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label="Bagian konten situs web">
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
      {sub === "landing" && <LandingPageEditor academyId={academyId} />}
      {sub === "gallery" && <GalleryManager academyId={academyId} />}
      {sub === "videos" && <VideosManager academyId={academyId} />}
      {sub === "history" && <PublishHistory academyId={academyId} />}
    </div>
  );
}

// ============================================================================
// Landing Page Editor
// ============================================================================

function LandingPageEditor({ academyId }: { academyId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<LandingPage | null>(null);
  const [draft, setDraft] = useState<LandingContent>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each loadPage/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const loadPage = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/landing?academyId=${aid}`, { credentials: "same-origin" });
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        setError(data.error?.message ?? `Error ${res.status}`);
        return;
      }
      const data = (await res.json()) as { landingPage: LandingPage };
      setPage(data.landingPage);
      setDraft(data.landingPage.draftContent ?? {});
      setDirty(false);
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setError("Kesalahan jaringan");
    } finally {
      setLoading(false);
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/landing?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok) {
          const data = (await res.json()) as { error?: { message?: string } };
          setError(data.error?.message ?? `Error ${res.status}`);
          return;
        }
        const data = (await res.json()) as { landingPage: LandingPage };
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setPage(data.landingPage);
        setDraft(data.landingPage.draftContent ?? {});
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setError("Kesalahan jaringan");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  const updateDraft = (updater: (d: LandingContent) => LandingContent) => {
    setDraft((prev) => {
      const next = updater({ ...prev });
      setDirty(true);
      return next;
    });
  };

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await adminFetch(`/api/admin/landing?academyId=${academyId}`, "PATCH", draft);
      if (res.ok) {
        toast({ title: "Draf tersimpan" });
        setDirty(false);
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setSaveError(failMsg);
      toast({ title: "Gagal menyimpan draf", description: failMsg, variant: "destructive" });
    } catch {
      setSaveError("Kesalahan jaringan");
      toast({ title: "Gagal menyimpan draf", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async (note: string) => {
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await adminFetch(`/api/admin/landing/publish?academyId=${academyId}`, "POST", {
        publishNote: note || null,
      });
      if (res.ok || res.status === 201) {
        toast({ title: "Halaman landing diterbitkan" });
        setShowPublishDialog(false);
        void loadPage();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setPublishError(failMsg);
      toast({ title: "Gagal menerbitkan halaman landing", description: failMsg, variant: "destructive" });
    } catch {
      setPublishError("Kesalahan jaringan");
      toast({ title: "Gagal menerbitkan halaman landing", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setPublishing(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">Memuat halaman landing…</p>
        </CardContent>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-sm font-medium text-destructive">Gagal memuat halaman landing</p>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={loadPage}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isPublished = page?.publishedPublicationId !== null;

  return (
    <div className="space-y-4">
      {/* Status + actions bar */}
      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            {isPublished ? (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                <Check className="h-3 w-3 mr-1" aria-hidden /> Telah diterbitkan
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                <X className="h-3 w-3 mr-1" aria-hidden /> Belum diterbitkan
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              Draf diperbarui {formatTimestamp(page?.draftUpdatedAt ?? null)}
            </span>
            {dirty && (
              <Badge variant="secondary" className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                Perubahan belum tersimpan
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="gap-2"
            >
              {saving ? (
                <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menyimpan…</>
              ) : (
                <><Save className="h-4 w-4" aria-hidden /> Simpan Draf</>
              )}
            </Button>
            <Button
              size="sm"
              onClick={() => setShowPublishDialog(true)}
              disabled={publishing}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700"
            >
              {publishing ? (
                <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menerbitkan…</>
              ) : (
                <><Rocket className="h-4 w-4" aria-hidden /> Terbitkan</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {saveError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
          <p className="text-sm text-destructive">{saveError}</p>
        </div>
      )}
      {publishError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
          <p className="text-sm text-destructive">{publishError}</p>
        </div>
      )}

      {/* Hero section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bagian Hero</CardTitle>
          <CardDescription>Banner atas halaman landing Anda.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="hero-title">Judul</Label>
            <Input
              id="hero-title"
              value={draft.hero?.title ?? ""}
              onChange={(e) => updateDraft((d) => ({ ...d, hero: { ...d.hero, title: e.target.value } }))}
              placeholder="mis. Akademi Futsal Jakarta"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="hero-subtitle">Subjudul</Label>
            <Input
              id="hero-subtitle"
              value={draft.hero?.subtitle ?? ""}
              onChange={(e) => updateDraft((d) => ({ ...d, hero: { ...d.hero, subtitle: e.target.value } }))}
              placeholder="mis. Latih. Bertanding. Unggul."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="hero-cta">Teks Ajakan</Label>
            <Input
              id="hero-cta"
              value={draft.hero?.ctaText ?? ""}
              onChange={(e) => updateDraft((d) => ({ ...d, hero: { ...d.hero, ctaText: e.target.value } }))}
              placeholder="mis. Daftar Sekarang"
            />
          </div>
        </CardContent>
      </Card>

      {/* About section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bagian Tentang</CardTitle>
          <CardDescription>Ceritakan tentang akademi Anda kepada pengunjung.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="about-title">Judul</Label>
            <Input
              id="about-title"
              value={draft.about?.title ?? ""}
              onChange={(e) => updateDraft((d) => ({ ...d, about: { ...d.about, title: e.target.value } }))}
              placeholder="mis. Tentang Kami"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="about-body">Isi</Label>
            <Textarea
              id="about-body"
              value={draft.about?.body ?? ""}
              onChange={(e) => updateDraft((d) => ({ ...d, about: { ...d.about, body: e.target.value } }))}
              placeholder="Uraikan misi, sejarah, dan nilai akademi Anda…"
              rows={4}
            />
          </div>
        </CardContent>
      </Card>

      {/* Programs section */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Program</CardTitle>
            <CardDescription>Program latihan yang ditawarkan akademi Anda.</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateDraft((d) => ({
              ...d,
              programs: [...(d.programs ?? []), { name: "", description: "" }],
            }))}
            className="gap-2"
          >
            <Plus className="h-4 w-4" aria-hidden /> Tambah
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {(!draft.programs || draft.programs.length === 0) && (
            <p className="text-sm text-muted-foreground">Belum ada program ditambahkan.</p>
          )}
          {draft.programs?.map((p, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border p-3">
              <div className="flex-1 space-y-2">
                <Input
                  value={p.name}
                  onChange={(e) => updateDraft((d) => {
                    const programs = [...(d.programs ?? [])];
                    programs[i] = { ...programs[i]!, name: e.target.value };
                    return { ...d, programs };
                  })}
                  placeholder="Nama program"
                />
                <Textarea
                  value={p.description ?? ""}
                  onChange={(e) => updateDraft((d) => {
                    const programs = [...(d.programs ?? [])];
                    programs[i] = { ...programs[i]!, description: e.target.value };
                    return { ...d, programs };
                  })}
                  placeholder="Deskripsi (opsional)"
                  rows={2}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateDraft((d) => ({
                  ...d,
                  programs: (d.programs ?? []).filter((_, idx) => idx !== i),
                }))}
                aria-label={`Hapus program ${p.name || i + 1}`}
              >
                <Trash2 className="h-4 w-4 text-rose-600" aria-hidden />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Schedules section */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Jadwal</CardTitle>
            <CardDescription>Jadwal latihan mingguan yang tampil di halaman landing.</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateDraft((d) => ({
              ...d,
              schedules: [...(d.schedules ?? []), { day: "", time: "", className: "" }],
            }))}
            className="gap-2"
          >
            <Plus className="h-4 w-4" aria-hidden /> Tambah
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {(!draft.schedules || draft.schedules.length === 0) && (
            <p className="text-sm text-muted-foreground">Belum ada jadwal ditambahkan.</p>
          )}
          {draft.schedules?.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={s.day}
                onChange={(e) => updateDraft((d) => {
                  const schedules = [...(d.schedules ?? [])];
                  schedules[i] = { ...schedules[i]!, day: e.target.value };
                  return { ...d, schedules };
                })}
                placeholder="Hari (mis. Selasa)"
                className="w-32"
              />
              <Input
                value={s.time}
                onChange={(e) => updateDraft((d) => {
                  const schedules = [...(d.schedules ?? [])];
                  schedules[i] = { ...schedules[i]!, time: e.target.value };
                  return { ...d, schedules };
                })}
                placeholder="Waktu (mis. 15:00-16:00)"
                className="w-40"
              />
              <Input
                value={s.className ?? ""}
                onChange={(e) => updateDraft((d) => {
                  const schedules = [...(d.schedules ?? [])];
                  schedules[i] = { ...schedules[i]!, className: e.target.value };
                  return { ...d, schedules };
                })}
                placeholder="Nama kelas (opsional)"
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateDraft((d) => ({
                  ...d,
                  schedules: (d.schedules ?? []).filter((_, idx) => idx !== i),
                }))}
                aria-label={`Hapus jadwal ${i + 1}`}
              >
                <Trash2 className="h-4 w-4 text-rose-600" aria-hidden />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Coaches section */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Pelatih</CardTitle>
            <CardDescription>Profil pelatih yang tampil di halaman landing.</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateDraft((d) => ({
              ...d,
              coaches: [...(d.coaches ?? []), { name: "", role: "", bio: "" }],
            }))}
            className="gap-2"
          >
            <Plus className="h-4 w-4" aria-hidden /> Tambah
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {(!draft.coaches || draft.coaches.length === 0) && (
            <p className="text-sm text-muted-foreground">Belum ada pelatih ditambahkan.</p>
          )}
          {draft.coaches?.map((c, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border p-3">
              <div className="flex-1 space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={c.name}
                    onChange={(e) => updateDraft((d) => {
                      const coaches = [...(d.coaches ?? [])];
                      coaches[i] = { ...coaches[i]!, name: e.target.value };
                      return { ...d, coaches };
                    })}
                    placeholder="Nama pelatih"
                  />
                  <Input
                    value={c.role ?? ""}
                    onChange={(e) => updateDraft((d) => {
                      const coaches = [...(d.coaches ?? [])];
                      coaches[i] = { ...coaches[i]!, role: e.target.value };
                      return { ...d, coaches };
                    })}
                    placeholder="Peran (mis. Pelatih Utama)"
                    className="w-40"
                  />
                </div>
                <Textarea
                  value={c.bio ?? ""}
                  onChange={(e) => updateDraft((d) => {
                    const coaches = [...(d.coaches ?? [])];
                    coaches[i] = { ...coaches[i]!, bio: e.target.value };
                    return { ...d, coaches };
                  })}
                  placeholder="Biodata singkat (opsional)"
                  rows={2}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateDraft((d) => ({
                  ...d,
                  coaches: (d.coaches ?? []).filter((_, idx) => idx !== i),
                }))}
                aria-label={`Hapus pelatih ${c.name || i + 1}`}
              >
                <Trash2 className="h-4 w-4 text-rose-600" aria-hidden />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Location + Contact section */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lokasi</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="loc-address">Alamat</Label>
              <Textarea
                id="loc-address"
                value={draft.location?.address ?? ""}
                onChange={(e) => updateDraft((d) => ({ ...d, location: { ...d.location, address: e.target.value } }))}
                placeholder="Alamat akademi"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc-map">URL Peta</Label>
              <Input
                id="loc-map"
                value={draft.location?.mapUrl ?? ""}
                onChange={(e) => updateDraft((d) => ({ ...d, location: { ...d.location, mapUrl: e.target.value } }))}
                placeholder="URL Google Maps"
              />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kontak</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="ct-phone">Telepon</Label>
              <Input
                id="ct-phone"
                value={draft.contact?.phone ?? ""}
                onChange={(e) => updateDraft((d) => ({ ...d, contact: { ...d.contact, phone: e.target.value } }))}
                placeholder="+62…"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ct-email">Email</Label>
              <Input
                id="ct-email"
                value={draft.contact?.email ?? ""}
                onChange={(e) => updateDraft((d) => ({ ...d, contact: { ...d.contact, email: e.target.value } }))}
                placeholder="info@academy.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ct-wa">WhatsApp</Label>
              <Input
                id="ct-wa"
                value={draft.contact?.whatsapp ?? ""}
                onChange={(e) => updateDraft((d) => ({ ...d, contact: { ...d.contact, whatsapp: e.target.value } }))}
                placeholder="+62…"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Registration CTA */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ajakan Pendaftaran</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="reg-cta">Teks Ajakan</Label>
            <Input
              id="reg-cta"
              value={draft.registrationCta?.text ?? ""}
              onChange={(e) => updateDraft((d) => ({ ...d, registrationCta: { ...d.registrationCta, text: e.target.value } }))}
              placeholder="mis. Daftarkan Anak Anda Hari Ini"
            />
          </div>
        </CardContent>
      </Card>

      {/* Publish dialog */}
      {showPublishDialog && (
        <PublishDialog
          key={`publish-${showPublishDialog}`}
          open={showPublishDialog}
          onClose={() => setShowPublishDialog(false)}
          onPublish={handlePublish}
          publishing={publishing}
        />
      )}
    </div>
  );
}

// ============================================================================
// Publish Dialog
// ============================================================================

function PublishDialog({
  open,
  onClose,
  onPublish,
  publishing,
}: {
  open: boolean;
  onClose: () => void;
  onPublish: (note: string) => void;
  publishing: boolean;
}) {
  const [note, setNote] = useState("");
  // Reset note when dialog opens (via key remount in parent, no effect needed).
  // The parent uses key={showPublishDialog} to force remount.

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !publishing) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Terbitkan Halaman Landing</DialogTitle>
          <DialogDescription>
            Ini akan membuat versi terbitan baru halaman landing Anda. Versi terbitan saat ini (jika ada) akan diganti.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="publish-note">Catatan Terbit (opsional)</Label>
            <Textarea
              id="publish-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="mis. Jadwal diperbarui untuk Januari 2026"
              rows={2}
              disabled={publishing}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={publishing}>
            Batal
          </Button>
          <Button
            onClick={() => onPublish(note)}
            disabled={publishing}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700"
          >
            {publishing ? (
              <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menerbitkan…</>
            ) : (
              <><Rocket className="h-4 w-4" aria-hidden /> Terbitkan Sekarang</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Gallery Manager
// ============================================================================

type GalleryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: GalleryItem[] };

function GalleryManager({ academyId }: { academyId: string }) {
  const [state, setState] = useState<GalleryState>({ status: "loading" });
  const [showCreate, setShowCreate] = useState(false);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchList/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchList = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/gallery?academyId=${aid}`, { credentials: "same-origin" });
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      const data = (await res.json()) as { gallery?: GalleryItem[]; error?: { message?: string } };
      if (!res.ok || !data.gallery) {
        setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      setState({ status: "success", data: data.gallery });
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/gallery?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        const data = (await res.json()) as { gallery?: GalleryItem[]; error?: { message?: string } };
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok || !data.gallery) {
          setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.gallery });
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
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Kelola foto dan video yang tampil di galeri akademi Anda.</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchList} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" aria-hidden /> Tambah Item
          </Button>
        </div>
      </div>

      {state.status === "loading" && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat galeri…</p>
          </CardContent>
        </Card>
      )}
      {state.status === "error" && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm font-medium text-destructive">Gagal memuat galeri</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={fetchList}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <ImageIcon className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">Belum ada item galeri</p>
            <p className="mt-1 text-xs text-muted-foreground">Klik &ldquo;Tambah Item&rdquo; untuk mengunggah foto atau video.</p>
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.data.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {state.data.map((item) => (
            <GalleryCard key={item.id} item={item} academyId={academyId} onUpdated={fetchList} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateGalleryDialog
          key={`gallery-${showCreate}`}
          open={showCreate}
          onClose={() => setShowCreate(false)}
          academyId={academyId}
          onCreated={() => {
            setShowCreate(false);
            void fetchList();
          }}
        />
      )}
    </div>
  );
}

function GalleryCard({ item, academyId, onUpdated }: { item: GalleryItem; academyId: string; onUpdated: () => void }) {
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleFeatured = async () => {
    setUpdating(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/gallery/${item.id}?academyId=${academyId}`, "PATCH", {
        isFeatured: !item.isFeatured,
      });
      if (res.ok) {
        toast({ title: "Item galeri diperbarui" });
        onUpdated();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memperbarui item galeri", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal memperbarui item galeri", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setUpdating(false);
    }
  };

  const togglePublished = async () => {
    setUpdating(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/gallery/${item.id}?academyId=${academyId}`, "PATCH", {
        isPublished: !item.isPublished,
      });
      if (res.ok) {
        toast({ title: "Item galeri diperbarui" });
        onUpdated();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memperbarui item galeri", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal memperbarui item galeri", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Card className="group transition-all hover:border-primary/40 hover:shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${item.mediaType === "video" ? "bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400" : "bg-sky-100 text-sky-600 dark:bg-sky-950 dark:text-sky-400"}`}>
              {item.mediaType === "video" ? <Video className="h-5 w-5" aria-hidden /> : <ImageIcon className="h-5 w-5" aria-hidden />}
            </div>
            <div>
              <p className="text-sm font-medium leading-tight">{item.title}</p>
              <p className="text-xs text-muted-foreground capitalize">{item.mediaType}</p>
            </div>
          </div>
          <div className="flex gap-1">
            {item.isFeatured && (
              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                <Star className="h-3 w-3 mr-1" aria-hidden /> Unggulan
              </Badge>
            )}
            {item.isPublished ? (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">Telah diterbitkan</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">Disembunyikan</Badge>
            )}
          </div>
        </div>
        {item.mediaKey && (
          <p className="mt-2 truncate text-xs text-muted-foreground">Kunci: {item.mediaKey}</p>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-3 flex items-center gap-2 border-t pt-2">
          <Button variant="outline" size="sm" onClick={toggleFeatured} disabled={updating} className="gap-1.5 text-xs">
            <Star className={`h-3.5 w-3.5 ${item.isFeatured ? "fill-amber-400 text-amber-500" : ""}`} aria-hidden />
            {item.isFeatured ? "Hapus unggulan" : "Jadikan unggulan"}
          </Button>
          <Button variant="outline" size="sm" onClick={togglePublished} disabled={updating} className="gap-1.5 text-xs">
            {item.isPublished ? <><X className="h-3.5 w-3.5" aria-hidden /> Sembunyikan</> : <><Check className="h-3.5 w-3.5" aria-hidden /> Terbitkan</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateGalleryDialog({ open, onClose, academyId, onCreated }: { open: boolean; onClose: () => void; academyId: string; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [mediaKey, setMediaKey] = useState("");
  const [mediaType, setMediaType] = useState<"image" | "video">("image");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State is reset via key remount in the parent (key={showCreate}).

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError("Judul wajib diisi.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        mediaType,
      };
      if (mediaKey.trim()) body.mediaKey = mediaKey.trim();
      const res = await adminFetch(`/api/admin/gallery?academyId=${academyId}`, "POST", body);
      if (res.status === 201) {
        toast({ title: "Item galeri ditambahkan" });
        onCreated();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menambah item galeri", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal menambah item galeri", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tambah Item Galeri</DialogTitle>
          <DialogDescription>Tambahkan foto atau video ke galeri akademi Anda.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="gal-title">Judul *</Label>
            <Input id="gal-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={submitting} placeholder="mis. Turnamen 2026" />
          </div>
          <div className="space-y-2">
            <Label>Jenis Media</Label>
            <div className="flex gap-2">
              <Button variant={mediaType === "image" ? "default" : "outline"} size="sm" onClick={() => setMediaType("image")} className="gap-2">
                <ImageIcon className="h-4 w-4" aria-hidden /> Gambar
              </Button>
              <Button variant={mediaType === "video" ? "default" : "outline"} size="sm" onClick={() => setMediaType("video")} className="gap-2">
                <Video className="h-4 w-4" aria-hidden /> Video
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="gal-key">Kunci Media / URL (opsional)</Label>
            <Input id="gal-key" value={mediaKey} onChange={(e) => setMediaKey(e.target.value)} disabled={submitting} placeholder="Kunci S3 atau URL" />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting} className="gap-2">
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menambahkan…</> : <><Plus className="h-4 w-4" aria-hidden /> Tambah Item</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Videos Manager
// ============================================================================

type VideosState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: YoutubeVideo[] };

function VideosManager({ academyId }: { academyId: string }) {
  const [state, setState] = useState<VideosState>({ status: "loading" });
  const [showCreate, setShowCreate] = useState(false);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchList/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchList = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/videos?academyId=${aid}`, { credentials: "same-origin" });
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      const data = (await res.json()) as { videos?: YoutubeVideo[]; error?: { message?: string } };
      if (!res.ok || !data.videos) {
        setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      setState({ status: "success", data: data.videos });
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/videos?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        const data = (await res.json()) as { videos?: YoutubeVideo[]; error?: { message?: string } };
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok || !data.videos) {
          setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.videos });
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
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Kelola video YouTube yang tampil di halaman landing akademi Anda.</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchList} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" aria-hidden /> Tambah Video
          </Button>
        </div>
      </div>

      {state.status === "loading" && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat video…</p>
          </CardContent>
        </Card>
      )}
      {state.status === "error" && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm font-medium text-destructive">Gagal memuat video</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={fetchList}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <Video className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">Belum ada video</p>
            <p className="mt-1 text-xs text-muted-foreground">Klik &ldquo;Tambah Video&rdquo; untuk menambah video YouTube.</p>
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.data.length > 0 && (
        <div className="space-y-2">
          {state.data.map((v) => (
            <VideoCard key={v.id} video={v} academyId={academyId} onUpdated={fetchList} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateVideoDialog
          key={`video-${showCreate}`}
          open={showCreate}
          onClose={() => setShowCreate(false)}
          academyId={academyId}
          onCreated={() => {
            setShowCreate(false);
            void fetchList();
          }}
        />
      )}
    </div>
  );
}

function VideoCard({ video, academyId, onUpdated }: { video: YoutubeVideo; academyId: string; onUpdated: () => void }) {
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleFeatured = async () => {
    setUpdating(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/videos/${video.id}?academyId=${academyId}`, "PATCH", {
        isFeatured: !video.isFeatured,
      });
      if (res.ok) {
        toast({ title: "Video diperbarui" });
        onUpdated();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memperbarui video", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal memperbarui video", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setUpdating(false);
    }
  };

  const togglePublished = async () => {
    setUpdating(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/videos/${video.id}?academyId=${academyId}`, "PATCH", {
        isPublished: !video.isPublished,
      });
      if (res.ok) {
        toast({ title: "Video diperbarui" });
        onUpdated();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal memperbarui video", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal memperbarui video", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Card className="transition-all hover:border-primary/40">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-16 w-28 flex-shrink-0 items-center justify-center rounded-lg overflow-hidden bg-rose-100 dark:bg-rose-950">
            <img
              src={`https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg`}
              alt={video.title}
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium leading-tight">{video.title}</p>
                <a
                  href={video.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 flex items-center gap-1 text-xs text-sky-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" aria-hidden /> {video.videoId}
                </a>
              </div>
              <div className="flex gap-1">
                {video.isFeatured && (
                  <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                    <Star className="h-3 w-3 mr-1" aria-hidden /> Unggulan
                  </Badge>
                )}
                {video.isPublished ? (
                  <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">Telah diterbitkan</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">Disembunyikan</Badge>
                )}
              </div>
            </div>
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
            <div className="mt-2 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={toggleFeatured} disabled={updating} className="gap-1.5 text-xs">
                <Star className={`h-3.5 w-3.5 ${video.isFeatured ? "fill-amber-400 text-amber-500" : ""}`} aria-hidden />
                {video.isFeatured ? "Hapus unggulan" : "Jadikan unggulan"}
              </Button>
              <Button variant="outline" size="sm" onClick={togglePublished} disabled={updating} className="gap-1.5 text-xs">
                {video.isPublished ? <><X className="h-3.5 w-3.5" aria-hidden /> Sembunyikan</> : <><Check className="h-3.5 w-3.5" aria-hidden /> Terbitkan</>}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateVideoDialog({ open, onClose, academyId, onCreated }: { open: boolean; onClose: () => void; academyId: string; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State is reset via key remount in the parent (key={showCreate}).

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError("Judul wajib diisi.");
      return;
    }
    if (!url.trim()) {
      setError("URL YouTube wajib diisi.");
      return;
    }
    const videoId = extractYouTubeId(url.trim());
    if (!videoId) {
      setError("URL YouTube tidak valid. Gunakan https://youtube.com/watch?v=… atau https://youtu.be/…");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/videos?academyId=${academyId}`, "POST", {
        title: title.trim(),
        url: url.trim(),
      });
      if (res.status === 201) {
        toast({ title: "Video ditambahkan" });
        onCreated();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal menambah video", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal menambah video", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tambah Video YouTube</DialogTitle>
          <DialogDescription>Tambahkan video YouTube ke halaman landing akademi Anda.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="vid-title">Judul *</Label>
            <Input id="vid-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={submitting} placeholder="mis. Sorotan Turnamen 2026" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vid-url">URL YouTube *</Label>
            <Input id="vid-url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={submitting} placeholder="https://youtube.com/watch?v=…" />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Batal</Button>
          <Button onClick={handleSubmit} disabled={submitting} className="gap-2">
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Menambahkan…</> : <><Plus className="h-4 w-4" aria-hidden /> Tambah Video</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Publish History
// ============================================================================

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: Publication[] };

function PublishHistory({ academyId }: { academyId: string }) {
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [reverting, setReverting] = useState<number | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchList/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchList = useCallback(async () => {
    const aid = academyId;
    const myRequestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/landing/publications?academyId=${aid}`, { credentials: "same-origin" });
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      const data = (await res.json()) as { publications?: Publication[]; error?: { message?: string } };
      if (!res.ok || !data.publications) {
        setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      setState({ status: "success", data: data.publications });
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setState({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/landing/publications?academyId=${academyId}`, { credentials: "same-origin" });
        if (cancelled || myRequestId !== requestIdRef.current) return;
        const data = (await res.json()) as { publications?: Publication[]; error?: { message?: string } };
        if (cancelled || myRequestId !== requestIdRef.current) return;
        if (!res.ok || !data.publications) {
          setState({ status: "error", message: data.error?.message ?? `Error ${res.status}` });
          return;
        }
        setState({ status: "success", data: data.publications });
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setState({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  const handleRevert = async (versionNumber: number) => {
    setReverting(versionNumber);
    setRevertError(null);
    try {
      const res = await adminFetch(`/api/admin/landing/revert?academyId=${academyId}`, "POST", { versionNumber });
      if (res.ok) {
        toast({ title: "Versi halaman landing dipulihkan" });
        void fetchList();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setRevertError(failMsg);
      toast({ title: "Gagal memulihkan versi halaman landing", description: failMsg, variant: "destructive" });
    } catch {
      setRevertError("Kesalahan jaringan");
      toast({ title: "Gagal memulihkan versi halaman landing", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setReverting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Riwayat publikasi halaman landing. Pulihkan ke versi sebelumnya.</p>
        <Button variant="outline" size="sm" onClick={fetchList} className="gap-2">
          <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
        </Button>
      </div>

      {revertError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
          <p className="text-sm text-destructive">{revertError}</p>
        </div>
      )}

      {state.status === "loading" && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Memuat riwayat publikasi…</p>
          </CardContent>
        </Card>
      )}
      {state.status === "error" && (
        <Card className="border-destructive/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm font-medium text-destructive">Gagal memuat riwayat</p>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={fetchList}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Coba lagi
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <History className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">Belum ada publikasi</p>
            <p className="mt-1 text-xs text-muted-foreground">Terbitkan halaman landing dari tab Halaman Landing untuk membuat sebuah versi.</p>
          </CardContent>
        </Card>
      )}
      {state.status === "success" && state.data.length > 0 && (
        <div className="space-y-2">
          {state.data.map((pub) => (
            <Card key={pub.id} className="transition-all hover:border-primary/40">
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <span className="text-sm font-semibold">v{pub.versionNumber}</span>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">Versi {pub.versionNumber}</p>
                      <Badge variant="secondary" className="text-xs">
                        {formatTimestamp(pub.publishedAt)}
                      </Badge>
                    </div>
                    {pub.publishNote && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{pub.publishNote}</p>
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRevert(pub.versionNumber)}
                  disabled={reverting === pub.versionNumber}
                  className="gap-2"
                >
                  {reverting === pub.versionNumber ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Memulihkan…</>
                  ) : (
                    <><Undo2 className="h-3.5 w-3.5" aria-hidden /> Pulihkan ke versi ini</>
                  )}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
