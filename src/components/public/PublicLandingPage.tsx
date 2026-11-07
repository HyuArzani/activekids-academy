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
  ArrowRight,
  Play,
  Sparkles,
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

  if (error) {
    return (
      <div className="min-h-screen bg-[#f7f8f3] text-[#12251c]">
        <header className="border-b border-[#12251c]/10 bg-[#fbfcf8]">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
            <a href="#top" className="flex items-center gap-3" aria-label="Futsal Academy home">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#c6f36b] text-[#12251c]">
                <Trophy className="h-5 w-5" aria-hidden />
              </span>
              <span>
                <span className="block text-sm font-black uppercase tracking-[0.16em]">Futsal</span>
                <span className="block text-[10px] font-semibold uppercase tracking-[0.24em] text-[#526459]">Academy</span>
              </span>
            </a>
            <nav className="hidden items-center gap-8 text-sm font-medium text-[#526459] md:flex" aria-label="Main navigation">
              <a href="#program" className="transition-colors hover:text-[#12251c]">Program</a>
              <a href="#values" className="transition-colors hover:text-[#12251c]">Keunggulan</a>
            </nav>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onLoginClick}>Masuk</Button>
              <Button size="sm" className="bg-[#12251c] text-white hover:bg-[#244536]" onClick={onRegisterClick}>
                Daftar latihan <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        </header>

        <main id="top">
          {error !== "NOT_PUBLISHED" && (
            <div role="alert" className="border-b border-amber-900/10 bg-amber-50 px-5 py-3 text-center text-sm text-amber-950">
              Konten akademi belum dapat dimuat ({error}). Menampilkan halaman sementara.
            </div>
          )}
          <section className="relative overflow-hidden bg-[#10271e] text-white">
            <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-[#c6f36b]/10 blur-3xl" />
            <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:py-28">
              <div>
                <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#c6f36b]">
                  <Sparkles className="h-4 w-4" aria-hidden /> Akademi futsal untuk generasi hebat
                </p>
                <h1 className="mt-7 max-w-2xl text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl">
                  Bermain dengan hati. <span className="text-[#c6f36b]">Berkembang</span> setiap hari.
                </h1>
                <p className="mt-6 max-w-xl text-base leading-7 text-white/70 sm:text-lg">
                  Tempat anak belajar teknik, kerja sama, dan percaya diri lewat latihan futsal yang seru dan terarah.
                </p>
                <div className="mt-9 flex flex-wrap gap-3">
                  <Button size="lg" className="bg-[#c6f36b] font-bold text-[#12251c] hover:bg-[#d5ff86]" onClick={onRegisterClick}>
                    Mulai perjalanan <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
                  </Button>
                  <Button size="lg" variant="outline" className="border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white" onClick={onCheckStatusClick}>
                    Cek pendaftaran
                  </Button>
                </div>
                <p className="mt-8 text-sm text-white/50">Latihan yang membangun kemampuan — dan karakter.</p>
              </div>

              <div className="relative">
                <div className="absolute -inset-3 rotate-2 rounded-[2rem] bg-[#c6f36b]/20" />
                <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-3xl border border-white/15 bg-[radial-gradient(ellipse_at_70%_20%,rgba(198,243,107,0.22),transparent_35%),linear-gradient(135deg,#294b37,#0b1711)] shadow-2xl">
                  <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.2) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.2) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
                  <div className="relative flex flex-col items-center px-6 text-center">
                    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#c6f36b] text-[#12251c] shadow-lg shadow-black/20">
                      <Play className="ml-1 h-7 w-7 fill-current" aria-hidden />
                    </span>
                    <p className="mt-5 text-lg font-bold">Cerita latihan kami</p>
                    <p className="mt-2 text-sm text-white/65">Video YouTube akademi segera hadir</p>
                  </div>
                  <span className="absolute bottom-5 left-5 rounded-full border border-white/20 bg-black/20 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">Video sorotan</span>
                </div>
              </div>
            </div>
          </section>

          <section id="values" className="mx-auto grid max-w-7xl gap-4 px-5 py-12 sm:grid-cols-3 sm:px-8 sm:py-16">
            {[
              { title: "Teknik dasar", body: "Latihan terarah untuk membangun sentuhan dan kontrol bola." },
              { title: "Kerja sama tim", body: "Belajar berkomunikasi, saling mendukung, dan bermain bersama." },
              { title: "Percaya diri", body: "Ruang positif untuk mencoba, bertumbuh, dan berani tampil." },
            ].map((item, index) => (
              <article key={item.title} className="rounded-2xl border border-[#12251c]/10 bg-white p-6 shadow-sm">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-[#718078]">0{index + 1}</p>
                <h2 className="mt-4 text-xl font-bold">{item.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#617066]">{item.body}</p>
              </article>
            ))}
          </section>

          <section id="program" className="bg-[#eaf0e4]">
            <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-12 sm:px-8 sm:py-16 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#65786a]">Mulai dari sini</p>
                <h2 className="mt-2 text-2xl font-black sm:text-3xl">Siap mencoba latihan pertama?</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-[#617066]">Hubungi kami untuk informasi jadwal dan program yang sesuai.</p>
              </div>
              <Button size="lg" className="shrink-0 bg-[#12251c] text-white hover:bg-[#244536]" onClick={onRegisterClick}>
                Daftar sekarang <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
              </Button>
            </div>
          </section>
        </main>

        <footer className="border-t border-[#12251c]/10 bg-[#fbfcf8]">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-6 text-xs text-[#718078] sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <p>© {new Date().getFullYear()} Futsal Academy</p>
            <Button variant="ghost" size="sm" onClick={onLoginClick}>Masuk pengelola</Button>
          </div>
        </footer>
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
    <div className="min-h-screen bg-[#f7f8f3] text-[#12251c]">
      {/* ===== Top Bar ===== */}
      <div className="sticky top-0 z-50 border-b border-[#12251c]/10 bg-[#fbfcf8]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="#top" className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#c6f36b]">
              <Trophy className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-sm font-black uppercase tracking-[0.12em]">{page.academyName}</span>
          </a>
          <nav className="hidden items-center gap-7 text-sm font-medium text-[#526459] md:flex" aria-label="Main navigation">
            <a href="#about" className="hover:text-[#12251c]">Akademi</a>
            <a href="#programs" className="hover:text-[#12251c]">Program</a>
            <a href="#schedule" className="hover:text-[#12251c]">Jadwal</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCheckStatusClick} className="hidden text-xs sm:inline-flex">
              Cek Status
            </Button>
            <Button size="sm" className="bg-[#12251c] text-white hover:bg-[#244536]" onClick={onLoginClick}>Masuk</Button>
            <Button size="sm" className="bg-[#c6f36b] text-[#12251c] hover:bg-[#d5ff86]" onClick={onRegisterClick}>Daftar</Button>
          </div>
        </div>
      </div>

      {/* ===== Hero Section ===== */}
      <section id="top" className="relative overflow-hidden bg-[#10271e] text-white">
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-[#c6f36b]/10 blur-3xl" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:py-28">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#c6f36b]">
              <Sparkles className="h-4 w-4" aria-hidden /> Akademi futsal untuk generasi hebat
            </p>
            <h1 className="mt-7 max-w-2xl text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl">
              {heroTitle}
            </h1>
            {heroSubtitle && (
              <p className="mt-6 max-w-xl text-base leading-7 text-white/70 sm:text-lg">{heroSubtitle}</p>
            )}
            <div className="mt-9 flex flex-wrap gap-3">
              <Button size="lg" className="bg-[#c6f36b] font-bold text-[#12251c] hover:bg-[#d5ff86]" onClick={onRegisterClick}>
                {ctaText} <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
              </Button>
              <Button size="lg" variant="outline" className="border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white" onClick={onCheckStatusClick}>
                Cek pendaftaran
              </Button>
            </div>
            <p className="mt-8 text-sm text-white/50">Latihan yang membangun kemampuan — dan karakter.</p>
          </div>

          <div className="relative">
            <div className="absolute -inset-3 rotate-2 rounded-[2rem] bg-[#c6f36b]/20" />
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-3xl border border-white/15 bg-[radial-gradient(ellipse_at_70%_20%,rgba(198,243,107,0.22),transparent_35%),linear-gradient(135deg,#294b37,#0b1711)] shadow-2xl">
              <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.2) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.2) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
              <div className="relative flex flex-col items-center px-6 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#c6f36b] text-[#12251c] shadow-lg shadow-black/20">
                  <Play className="ml-1 h-7 w-7 fill-current" aria-hidden />
                </span>
                <p className="mt-5 text-lg font-bold">Cerita latihan kami</p>
                <p className="mt-2 text-sm text-white/65">Video YouTube akademi segera hadir</p>
              </div>
              <span className="absolute bottom-5 left-5 rounded-full border border-white/20 bg-black/20 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">Video sorotan</span>
            </div>
          </div>
        </div>
      </section>

      {/* ===== About Section ===== */}
      {c.about?.title && c.about?.body && (
        <section id="about" className="border-t border-[#12251c]/10 bg-[#f7f8f3]">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#718078]">Tentang kami</p>
            <h2 className="mt-3 max-w-3xl text-3xl font-black sm:text-4xl">{c.about.title}</h2>
            <p className="mt-5 max-w-3xl text-base leading-7 text-[#617066] sm:text-lg">
              {c.about.body}
            </p>
          </div>
        </section>
      )}

      {/* ===== Programs Section ===== */}
      {c.programs && c.programs.length > 0 && (
        <section id="programs" className="border-t border-[#12251c]/10 bg-[#eaf0e4]">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
            <div className="text-center">
              <Trophy className="mx-auto h-8 w-8 text-[#4c702e]" aria-hidden />
              <h2 className="mt-3 text-3xl font-black sm:text-4xl">Program latihan</h2>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {c.programs.map((p, i) => (
                <Card key={i} className="border-[#12251c]/10 bg-[#fbfcf8] transition-all hover:-translate-y-1 hover:shadow-md">
                  <CardContent className="p-6">
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-[#718078]">Program 0{i + 1}</p>
                    <h3 className="mt-3 text-lg font-bold">{p.name}</h3>
                    {p.description && (
                      <p className="mt-2 text-sm leading-6 text-[#617066]">{p.description}</p>
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
        <section id="schedule" className="border-t border-[#12251c]/10 bg-[#f7f8f3]">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
            <div className="text-center">
              <Calendar className="mx-auto h-8 w-8 text-[#4c702e]" aria-hidden />
              <h2 className="mt-3 text-3xl font-black sm:text-4xl">Jadwal latihan</h2>
            </div>
            <div className="mt-8 overflow-hidden rounded-2xl border border-[#12251c]/10 bg-[#fbfcf8]">
              <table className="w-full text-sm">
                <thead className="bg-[#eaf0e4]">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Hari</th>
                    <th className="px-4 py-3 text-left font-medium">Jam</th>
                    <th className="px-4 py-3 text-left font-medium">Kelas</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {c.schedules.map((s, i) => (
                    <tr key={i} className="border-t border-[#12251c]/10 hover:bg-[#eaf0e4]/50">
                      <td className="px-4 py-3 font-semibold">{s.day}</td>
                      <td className="px-4 py-3">{s.time}</td>
                      <td className="px-4 py-3 text-[#617066]">{s.className ?? "—"}</td>
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
        <section className="border-t border-[#12251c]/10 bg-[#eaf0e4]">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
            <div className="text-center">
              <Users className="mx-auto h-8 w-8 text-[#4c702e]" aria-hidden />
              <h2 className="mt-3 text-3xl font-black sm:text-4xl">Kenalan dengan pelatih</h2>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {c.coaches.map((coach, i) => (
                <Card key={i} className="border-[#12251c]/10 bg-[#fbfcf8] text-center transition-all hover:-translate-y-1 hover:shadow-md">
                  <CardContent className="p-6">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[#c6f36b] text-xl font-black text-[#12251c]">
                      {coach.name.charAt(0).toUpperCase()}
                    </div>
                    <h3 className="mt-3 text-base font-semibold">{coach.name}</h3>
                    {coach.role && (
                      <Badge variant="secondary" className="mt-2 bg-[#eaf0e4] text-[#526459]">{coach.role}</Badge>
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
        <section className="border-t border-[#12251c]/10 bg-[#f7f8f3]">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
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
        <section className="border-t border-[#12251c]/10 bg-[#eaf0e4]">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
            <div className="text-center">
              <h2 className="text-2xl font-bold sm:text-3xl">Video</h2>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {page.videos.map((video) => (
                <Card key={video.id} className="overflow-hidden border-[#12251c]/10 bg-[#fbfcf8]">
                  <div className="aspect-video bg-black">
                    <iframe
                      src={`https://www.youtube-nocookie.com/embed/${video.videoId}`}
                      title={video.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      loading="lazy"
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
        <section className="border-t border-[#12251c]/10 bg-[#f7f8f3]">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
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
      <section className="border-t border-white/10 bg-[#10271e] text-white">
        <div className="mx-auto max-w-7xl px-5 py-14 text-center sm:px-8 sm:py-20">
          <h2 className="text-2xl font-bold sm:text-3xl">
            {c.registrationCta?.text ?? "Siap Bergabung?"}
          </h2>
          <p className="mt-3 text-white/70">
            Daftarkan anak Anda hari ini dan mulai perjalanan futsalnya.
          </p>
          <button
            type="button"
            onClick={onRegisterClick}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#c6f36b] px-6 py-3 text-sm font-bold text-[#12251c] shadow-sm transition-colors hover:bg-[#d5ff86]"
          >
            <Rocket className="h-4 w-4" aria-hidden /> {ctaText}
          </button>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="border-t border-[#12251c]/10 bg-[#fbfcf8]">
        <div className="mx-auto max-w-7xl px-5 py-6 text-center text-xs text-[#718078] sm:px-8">
          <p>© {new Date().getFullYear()} {page.academyName}. Hak cipta dilindungi.</p>
          <p className="mt-1">Diterbitkan {new Date(page.publishedAt).toLocaleDateString("id-ID")} · Versi {page.versionNumber}</p>
        </div>
      </footer>
    </div>
  );
}
