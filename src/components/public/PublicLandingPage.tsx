"use client";

import { useState, useEffect } from "react";
import {
  LogIn,
  MapPin,
  Phone,
  Mail,
  MessageSquare,
  Calendar,
  Users,
  Trophy,
  ExternalLink,
  AlertCircle,
  Loader2,
  Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ============================================================================
// Types — match the PublicLandingPage interface from src/lib/domain/cms.ts
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
}

interface GalleryItem {
  id: string;
  title: string;
  mediaKey?: string | null;
  mediaType?: string;
  displayOrder: number;
  isFeatured?: boolean;
}

interface VideoItem {
  id: string;
  title: string;
  videoId: string;
  displayOrder: number;
  isFeatured?: boolean;
}

interface PublicLandingPageData {
  academyId: string;
  academyName: string;
  content: LandingContent;
  publishedAt: string;
  versionNumber: number;
  gallery: GalleryItem[];
  videos: VideoItem[];
}

// ============================================================================
// Component
// ============================================================================

interface PublicLandingPageProps {
  academyId: string;
  onLoginClick: () => void;
  onRegisterClick: () => void;
  onCheckStatusClick: () => void;
}

export function PublicLandingPage({ academyId, onLoginClick, onRegisterClick, onCheckStatusClick }: PublicLandingPageProps) {
  const [page, setPage] = useState<PublicLandingPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/public/landing?academyId=${academyId}`);
        if (cancelled) return;
        if (res.status === 404) {
          setError("NOT_PUBLISHED");
          return;
        }
        if (!res.ok) {
          setError("Gagal memuat halaman landing.");
          return;
        }
        const data = (await res.json()) as PublicLandingPageData;
        if (cancelled) return;
        setPage(data);
      } catch {
        if (cancelled) return;
        setError("Kesalahan jaringan");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
          <p className="text-sm">Memuat halaman akademi…</p>
        </div>
      </div>
    );
  }

  if (error === "NOT_PUBLISHED") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <Card className="max-w-md">
          <CardContent className="p-8 text-center">
            <Rocket className="mx-auto h-12 w-12 text-muted-foreground" aria-hidden />
            <h2 className="mt-4 text-lg font-semibold">Halaman akademi segera hadir</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Akademi ini belum menerbitkan halaman publik. Silakan periksa kembali nanti atau hubungi akademi langsung.
            </p>
            <Button variant="outline" className="mt-6 gap-2" onClick={onLoginClick}>
              <LogIn className="h-4 w-4" aria-hidden /> Masuk Admin
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <Card className="max-w-md border-destructive/30">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-destructive" aria-hidden />
            <h2 className="mt-4 text-lg font-semibold text-destructive">Gagal memuat halaman</h2>
            <p className="mt-2 text-sm text-muted-foreground">{error ?? "Kesalahan tidak diketahui"}</p>
            <Button variant="outline" className="mt-6 gap-2" onClick={onLoginClick}>
              <LogIn className="h-4 w-4" aria-hidden /> Masuk Admin
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const c = page.content;
  const heroTitle = c.hero?.title ?? page.academyName;
  const heroSubtitle = c.hero?.subtitle ?? "Latihan. Bertanding. Berkembang.";
  const ctaText = c.hero?.ctaText ?? c.registrationCta?.text ?? "Daftar Sekarang";

  return (
    <div className="min-h-screen bg-background">
      {/* ===== Top Bar ===== */}
      <div className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <p className="text-sm font-semibold">{page.academyName}</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCheckStatusClick} className="text-xs">
              Cek Status
            </Button>
            <Button variant="outline" size="sm" onClick={onLoginClick} className="gap-2">
              <LogIn className="h-4 w-4" aria-hidden /> Masuk
            </Button>
          </div>
        </div>
      </div>

      {/* ===== Hero Section ===== */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary/10 via-primary/5 to-background">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              {heroTitle}
            </h1>
            {heroSubtitle && (
              <p className="mt-4 text-lg text-muted-foreground sm:text-xl">
                {heroSubtitle}
              </p>
            )}
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={onRegisterClick}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                <Rocket className="h-4 w-4" aria-hidden /> {ctaText}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ===== About Section ===== */}
      {c.about?.title && c.about?.body && (
        <section className="border-t">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <h2 className="text-2xl font-bold sm:text-3xl">{c.about.title}</h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
              {c.about.body}
            </p>
          </div>
        </section>
      )}

      {/* ===== Programs Section ===== */}
      {c.programs && c.programs.length > 0 && (
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="text-center">
              <Trophy className="mx-auto h-8 w-8 text-primary" aria-hidden />
              <h2 className="mt-2 text-2xl font-bold sm:text-3xl">Program</h2>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {c.programs.map((p, i) => (
                <Card key={i} className="transition-all hover:border-primary/40 hover:shadow-sm">
                  <CardContent className="p-5">
                    <h3 className="text-base font-semibold">{p.name}</h3>
                    {p.description && (
                      <p className="mt-2 text-sm text-muted-foreground">{p.description}</p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ===== Schedules Section ===== */}
      {c.schedules && c.schedules.length > 0 && (
        <section className="border-t">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="text-center">
              <Calendar className="mx-auto h-8 w-8 text-primary" aria-hidden />
              <h2 className="mt-2 text-2xl font-bold sm:text-3xl">Jadwal Latihan</h2>
            </div>
            <div className="mt-8 overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Hari</th>
                    <th className="px-4 py-3 text-left font-medium">Jam</th>
                    <th className="px-4 py-3 text-left font-medium">Kelas</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {c.schedules.map((s, i) => (
                    <tr key={i} className="hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{s.day}</td>
                      <td className="px-4 py-3">{s.time}</td>
                      <td className="px-4 py-3 text-muted-foreground">{s.className ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ===== Coaches Section ===== */}
      {c.coaches && c.coaches.length > 0 && (
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="text-center">
              <Users className="mx-auto h-8 w-8 text-primary" aria-hidden />
              <h2 className="mt-2 text-2xl font-bold sm:text-3xl">Pelatih Kami</h2>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {c.coaches.map((coach, i) => (
                <Card key={i} className="text-center transition-all hover:border-primary/40 hover:shadow-sm">
                  <CardContent className="p-5">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-xl font-bold text-primary">
                      {coach.name.charAt(0).toUpperCase()}
                    </div>
                    <h3 className="mt-3 text-base font-semibold">{coach.name}</h3>
                    {coach.role && (
                      <Badge variant="secondary" className="mt-1">{coach.role}</Badge>
                    )}
                    {coach.bio && (
                      <p className="mt-2 text-sm text-muted-foreground">{coach.bio}</p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ===== Gallery Section ===== */}
      {page.gallery.length > 0 && (
        <section className="border-t">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="text-center">
              <h2 className="text-2xl font-bold sm:text-3xl">Galeri</h2>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {page.gallery.map((item) => (
                <Card key={item.id} className="overflow-hidden transition-all hover:border-primary/40 hover:shadow-sm">
                  <div className={`flex h-32 items-center justify-center ${item.mediaType === "video" ? "bg-violet-100 dark:bg-violet-950/50" : "bg-sky-100 dark:bg-sky-950/50"}`}>
                    {item.mediaKey ? (
                      <img
                        src={item.mediaKey}
                        alt={item.title}
                        className="h-full w-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <span className="text-3xl text-muted-foreground">{item.mediaType === "video" ? "🎥" : "🖼️"}</span>
                    )}
                  </div>
                  <CardContent className="p-3">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    {item.isFeatured && (
                      <Badge variant="secondary" className="mt-1 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                        Unggulan
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ===== Videos Section ===== */}
      {page.videos.length > 0 && (
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="text-center">
              <h2 className="text-2xl font-bold sm:text-3xl">Video</h2>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {page.videos.map((video) => (
                <Card key={video.id} className="overflow-hidden transition-all hover:border-primary/40 hover:shadow-sm">
                  <div className="aspect-video bg-black">
                    <iframe
                      src={`https://www.youtube.com/embed/${video.videoId}`}
                      title={video.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      className="h-full w-full"
                    />
                  </div>
                  <CardContent className="p-3">
                    <p className="text-sm font-medium">{video.title}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ===== Location + Contact Section ===== */}
      {(c.location?.address || c.contact?.phone || c.contact?.email || c.contact?.whatsapp) && (
        <section className="border-t">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="grid gap-8 md:grid-cols-2">
              {/* Location */}
              {c.location?.address && (
                <div>
                  <div className="flex items-center gap-2">
                    <MapPin className="h-5 w-5 text-primary" aria-hidden />
                    <h3 className="text-lg font-semibold">Lokasi</h3>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{c.location.address}</p>
                  {c.location.mapUrl && (
                    <a
                      href={c.location.mapUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Lihat di peta
                    </a>
                  )}
                </div>
              )}
              {/* Contact */}
              {(c.contact?.phone || c.contact?.email || c.contact?.whatsapp) && (
                <div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-5 w-5 text-primary" aria-hidden />
                    <h3 className="text-lg font-semibold">Kontak</h3>
                  </div>
                  <div className="mt-3 space-y-2">
                    {c.contact?.phone && (
                      <a href={`tel:${c.contact.phone}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                        <Phone className="h-4 w-4" aria-hidden /> {c.contact.phone}
                      </a>
                    )}
                    {c.contact?.email && (
                      <a href={`mailto:${c.contact.email}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                        <Mail className="h-4 w-4" aria-hidden /> {c.contact.email}
                      </a>
                    )}
                    {c.contact?.whatsapp && (
                      <a
                        href={`https://wa.me/${c.contact.whatsapp.replace(/[^0-9]/g, "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                      >
                        <MessageSquare className="h-4 w-4" aria-hidden /> WhatsApp: {c.contact.whatsapp}
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ===== Registration CTA Section ===== */}
      <section className="border-t bg-primary text-primary-foreground">
        <div className="mx-auto max-w-5xl px-4 py-12 text-center sm:px-6 sm:py-16">
          <h2 className="text-2xl font-bold sm:text-3xl">
            {c.registrationCta?.text ?? "Siap Bergabung?"}
          </h2>
          <p className="mt-3 text-primary-foreground/80">
            Daftarkan anak Anda hari ini dan mulai perjalanan futsalnya.
          </p>
          <button
            type="button"
            onClick={onRegisterClick}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-background px-6 py-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-background/90"
          >
            <Rocket className="h-4 w-4" aria-hidden /> {ctaText}
          </button>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="border-t bg-card">
        <div className="mx-auto max-w-5xl px-4 py-6 text-center text-xs text-muted-foreground sm:px-6">
          <p>© {new Date().getFullYear()} {page.academyName}. Hak cipta dilindungi.</p>
          <p className="mt-1">Diterbitkan {new Date(page.publishedAt).toLocaleDateString("id-ID")} · Versi {page.versionNumber}</p>
        </div>
      </footer>
    </div>
  );
}
