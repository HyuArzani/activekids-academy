"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ChartNoAxesColumnIncreasing,
  Check,
  ShieldCheck,
  Trophy,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { publicSiteConfig } from "@/config/public-site";
import {
  PhotoPlaceholder,
  PublicFooter,
  PublicNavbar,
  SectionEyebrow,
  VideoPreview,
} from "@/components/public/PublicSiteChrome";

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

interface PublicLandingPageData {
  academyName: string;
  content: LandingContent;
  gallery: {
    id: string;
    title: string;
    mediaKey?: string | null;
    mediaType?: string;
    isFeatured?: boolean;
  }[];
  videos: { id: string; title: string; videoId: string; isFeatured?: boolean }[];
}

const highlightIcons = {
  trophy: Trophy,
  chart: ChartNoAxesColumnIncreasing,
  shield: ShieldCheck,
  users: Users,
} as const;

export function AcademyLandingPage({
  academyId = "00000000-0000-0000-0000-000000000001",
  onLoginClick,
  onRegisterClick,
  onCheckStatusClick,
}: {
  academyId?: string;
  onLoginClick: () => void;
  onRegisterClick: () => void;
  onCheckStatusClick: () => void;
}) {
  const [page, setPage] = useState<PublicLandingPageData | null>(null);
  const [cmsNotice, setCmsNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/public/landing?academyId=${encodeURIComponent(academyId)}`,
        );
        if (cancelled) return;
        if (response.status === 404) {
          setCmsNotice("Menampilkan pratinjau. Konten akademi belum dipublikasikan.");
          return;
        }
        if (!response.ok) {
          setCmsNotice("Konten CMS tidak dapat dimuat. Menampilkan pratinjau academy.");
          return;
        }
        setPage((await response.json()) as PublicLandingPageData);
      } catch {
        if (!cancelled) setCmsNotice("Tidak dapat terhubung ke CMS. Menampilkan pratinjau academy.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  const content = page?.content;
  const cmsPrograms = content?.programs?.filter((program) => program.name.trim()) ?? [];
  const programs = cmsPrograms.length
    ? cmsPrograms.map((program, index) => {
        const fallback =
          publicSiteConfig.landing.programs.find(
            (item) => item.name.trim().toLowerCase() === program.name.trim().toLowerCase(),
          ) ?? publicSiteConfig.landing.programs[index % publicSiteConfig.landing.programs.length]!;
        return {
          ...fallback,
          name: program.name,
          description: program.description ?? fallback.description,
        };
      })
    : publicSiteConfig.landing.programs;
  const academyName = page?.academyName ?? publicSiteConfig.academyName;
  const featuredVideo = page?.videos.find((video) => video.isFeatured) ?? page?.videos[0];
  const heroVideoId = publicSiteConfig.landing.hero.videoId || featuredVideo?.videoId || "";
  const heroVideoTitle = featuredVideo?.title ?? publicSiteConfig.landing.featuredVideo.title;
  const heroTitle = content?.hero?.title;
  const heroSubtitle =
    content?.hero?.subtitle ?? publicSiteConfig.landing.hero.description;

  return (
    <div className="min-h-screen bg-[#08251a] text-[#f5f5ef]">
      <PublicNavbar activePage="home" onLoginClick={onLoginClick} />
      {cmsNotice && (
        <p role="status" className="border-b border-[#c8e600]/20 bg-[#103a29] px-4 py-2 text-center text-xs text-[#f5f5ef]/70">
          {cmsNotice}
        </p>
      )}

      <main>
        <section id="top" className="grid min-h-[530px] overflow-hidden bg-[#08251a] lg:grid-cols-[0.88fr_1.12fr]">
          <div className="flex flex-col justify-center px-5 py-14 sm:px-8 sm:py-20 lg:pl-[max(2rem,calc((100vw-80rem)/2))] lg:pr-10">
            <SectionEyebrow>{publicSiteConfig.landing.hero.eyebrow}</SectionEyebrow>
            <h1 className="mt-6 max-w-2xl text-5xl font-black italic leading-[0.98] tracking-tight sm:text-6xl xl:text-7xl">
              {heroTitle ? (
                heroTitle
              ) : (
                <>
                  PLAY. LEARN.
                  <span className="block text-[#c8e600]">GROW.</span>
                </>
              )}
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-[#f5f5ef]/75 sm:text-lg">
              {heroSubtitle}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                onClick={onRegisterClick}
                className="bg-[#c8e600] font-bold text-[#08251a] hover:bg-[#d9f528]"
              >
                {content?.hero?.ctaText ?? "Gabung Sekarang"}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <a
                href="#programs"
                className="inline-flex h-10 items-center gap-2 rounded-md border border-white/35 px-5 text-sm font-medium text-white transition-colors hover:border-[#c8e600] hover:text-[#c8e600]"
              >
                Lihat Program
              </a>
            </div>
          </div>
          <div className="relative min-h-[300px] sm:min-h-[420px] lg:min-h-[530px]">
            <PhotoPlaceholder
              src={publicSiteConfig.landing.hero.image}
              alt={publicSiteConfig.landing.hero.imageAlt}
              className="inset-0"
              position="absolute"
              imageClassName="object-[center_40%]"
              label="Foto aksi latihan academy"
              priority
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#08251a] via-[#08251a]/25 to-[#08251a]/10 lg:from-[#08251a]/70 lg:via-[#08251a]/10 lg:to-transparent" />
            <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#08251a]/75 to-transparent" />
            <div className="absolute bottom-5 right-5 sm:bottom-8 sm:right-8">
              <VideoPreview
                title={heroVideoTitle}
                description="AKSI DAN KEGIATAN LATIHAN"
                thumbnail={publicSiteConfig.landing.featuredVideo.thumbnail}
                videoId={heroVideoId}
                className="w-56 shadow-xl sm:w-64"
              />
            </div>
          </div>
        </section>

        <section aria-label="Academy highlights" className="border-y border-white/10 bg-[#103a29]">
          <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-white/10 px-4 py-5 sm:px-6 lg:grid-cols-4">
            {publicSiteConfig.landing.highlights.map((highlight) => {
              const Icon = highlightIcons[highlight.icon];
              return (
                <div key={highlight.title} className="flex min-h-20 items-center gap-3 px-3 py-3 sm:justify-center sm:px-5">
                  <Icon className="h-6 w-6 shrink-0 text-[#c8e600]" aria-hidden />
                  <p className="text-xs font-semibold leading-5 text-white sm:text-sm">{highlight.title}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section id="programs" className="scroll-mt-20 bg-[#08251a] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <SectionEyebrow>Our Programs</SectionEyebrow>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-3xl font-black italic sm:text-4xl">Choose Your Class</h2>
              <p className="max-w-md text-sm leading-6 text-[#a7b2aa]">
                Program latihan yang disusun untuk mendukung perjalanan setiap pemain.
              </p>
            </div>
            <div className="mt-8 grid gap-5 md:grid-cols-3">
              {programs.map((program, index) => {
                return (
                  <article key={program.name} className="group overflow-hidden rounded-xl border border-white/15 bg-[#103a29] transition-transform duration-200 hover:-translate-y-1">
                    <PhotoPlaceholder
                      src={program.image}
                      alt={program.imageAlt}
                      className="aspect-[16/10]"
                      imageClassName="transition-transform duration-300 group-hover:scale-105"
                      label={`Foto program ${program.name}`}
                    />
                    <div className="p-5">
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#c8e600]">Program 0{index + 1}</p>
                      <h3 className="mt-2 text-xl font-black italic">{program.name}</h3>
                      <p className="mt-2 min-h-12 text-sm leading-6 text-[#a7b2aa]">
                        {program.description}
                      </p>
                      <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                        <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-white/75">{program.ageGroup}</span>
                        <a href="#about" className="inline-flex items-center gap-1 text-xs font-bold text-[#c8e600] hover:underline">
                          Learn More <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                        </a>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="about" className="scroll-mt-20 bg-[#f5f5ef] text-[#08251a]">
          <div className="mx-auto grid max-w-7xl items-center gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-2">
            <div className="relative">
              <PhotoPlaceholder
                src={publicSiteConfig.landing.about.image}
                alt={publicSiteConfig.landing.about.imageAlt}
                className="aspect-[4/3] rounded-xl"
                label="Foto academy bersama pelatih"
              />
              <span className="absolute left-0 top-0 h-12 w-12 border-l-4 border-t-4 border-[#c8e600]" aria-hidden />
            </div>
            <div>
              <SectionEyebrow>About Our Academy</SectionEyebrow>
              <h2 className="mt-4 text-3xl font-black italic leading-tight sm:text-4xl">
                {content?.about?.title ?? publicSiteConfig.landing.about.title}
              </h2>
              <p className="mt-5 text-sm leading-7 text-[#42564a] sm:text-base">
                {content?.about?.body ?? publicSiteConfig.landing.about.description}
              </p>
              <p className="mt-4 text-sm leading-7 text-[#42564a]">
                {publicSiteConfig.landing.about.mission}
              </p>
              <ul className="mt-6 grid gap-3 sm:grid-cols-2">
                {publicSiteConfig.landing.about.values.map((value) => (
                  <li key={value} className="flex items-start gap-2 text-sm font-medium">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#c8e600]">
                      <Check className="h-3 w-3" aria-hidden />
                    </span>
                    {value}
                  </li>
                ))}
              </ul>
              <Link href="/coaches" className="mt-7 inline-flex items-center gap-2 text-sm font-bold text-[#315d3d] hover:underline">
                Kenali tim pelatih <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
          </div>
        </section>

        <section id="schedule" className="scroll-mt-20 bg-[#103a29] px-5 py-14 sm:px-8">
          <div className="mx-auto max-w-7xl">
            <SectionEyebrow>Training Schedule</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-black italic">Jadwal Latihan</h2>
            {content?.schedules?.length ? (
              <div className="mt-6 overflow-x-auto rounded-lg border border-white/15">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="bg-white/10 text-[#c8e600]">
                    <tr>
                      <th className="px-4 py-3">Hari</th>
                      <th className="px-4 py-3">Jam</th>
                      <th className="px-4 py-3">Kelas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.schedules.map((schedule, index) => (
                      <tr key={`${schedule.day}-${index}`} className="border-t border-white/10">
                        <td className="px-4 py-3 font-semibold">{schedule.day}</td>
                        <td className="px-4 py-3 text-white/75">{schedule.time}</td>
                        <td className="px-4 py-3 text-white/75">{schedule.className ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 text-sm text-[#a7b2aa]">Informasi jadwal latihan akan segera diperbarui.</p>
            )}
          </div>
        </section>

        <section className="bg-[#08251a] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <SectionEyebrow>Behind The Training</SectionEyebrow>
                <h2 className="mt-3 text-3xl font-black italic">AKSI DAN KEGIATAN LATIHAN</h2>
              </div>
              <Link href="/coaches#training" className="inline-flex items-center gap-2 text-sm font-bold text-[#c8e600] hover:underline">
                Lihat kegiatan pelatih <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            <div className="mt-7 grid gap-4 sm:grid-cols-3">
              {publicSiteConfig.landing.trainingPhotos.map((photo) => (
                <PhotoPlaceholder
                  key={photo.alt}
                  src={photo.image}
                  alt={photo.alt}
                  className="aspect-[4/3] rounded-lg"
                  imageClassName="transition-transform duration-300 hover:scale-105"
                  label="Foto kegiatan latihan"
                />
              ))}
            </div>
          </div>
        </section>

        {page?.gallery?.length ? (
          <section className="bg-[#f5f5ef] px-5 py-16 text-[#08251a] sm:px-8 sm:py-20">
            <div className="mx-auto max-w-7xl">
              <SectionEyebrow>Academy Gallery</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-black italic">Galeri</h2>
              <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {page.gallery.map((item) => (
                  <article key={item.id} className="overflow-hidden rounded-lg border border-[#08251a]/10 bg-white">
                    <PhotoPlaceholder
                      src={item.mediaKey ?? ""}
                      alt={item.title}
                      className="aspect-[4/3]"
                      label={item.title}
                    />
                    <div className="p-3">
                      <p className="truncate text-sm font-semibold">{item.title}</p>
                      {item.isFeatured && (
                        <span className="mt-2 inline-block rounded-full bg-[#c8e600]/35 px-2 py-1 text-[10px] font-bold uppercase tracking-wide">
                          Unggulan
                        </span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {content?.coaches?.length ? (
          <section className="bg-[#f5f5ef] px-5 py-16 text-[#08251a] sm:px-8">
            <div className="mx-auto max-w-7xl">
              <SectionEyebrow>Our Coaches</SectionEyebrow>
              <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-3xl font-black italic">Pelatih Kami</h2>
                  <p className="mt-2 text-sm text-[#526258]">Tim yang mendampingi setiap pemain untuk terus berkembang.</p>
                </div>
                <Link href="/coaches" className="inline-flex items-center gap-2 text-sm font-bold text-[#315d3d] hover:underline">
                  Lihat profil pelatih <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
              <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {content.coaches.slice(0, 3).map((coach) => (
                  <article key={coach.name} className="rounded-lg border border-[#08251a]/10 bg-white p-5">
                    <h3 className="font-bold">{coach.name}</h3>
                    {coach.role && <p className="mt-1 text-xs font-semibold text-[#547b25]">{coach.role}</p>}
                    {coach.bio && <p className="mt-3 text-sm leading-6 text-[#526258]">{coach.bio}</p>}
                  </article>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {content?.location?.address && (
          <section className="bg-[#f5f5ef] px-5 py-12 text-[#08251a] sm:px-8">
            <div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 sm:flex-row sm:items-center">
              <div>
                <SectionEyebrow>Visit Us</SectionEyebrow>
                <h2 className="mt-2 text-2xl font-black italic">Lokasi Latihan</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#526258]">{content.location.address}</p>
              </div>
              {content.location.mapUrl && (
                <a
                  href={content.location.mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-2 rounded-md border border-[#08251a]/25 px-4 py-2 text-sm font-bold text-[#315d3d] hover:bg-[#08251a]/5"
                >
                  Lihat di peta <ArrowRight className="h-4 w-4" aria-hidden />
                </a>
              )}
            </div>
          </section>
        )}

        <section className="relative overflow-hidden bg-[#103a29] px-5 py-16 sm:px-8 sm:py-20">
          <PhotoPlaceholder
            src={publicSiteConfig.landing.hero.image}
            alt=""
            className="inset-0"
            position="absolute"
            imageClassName="object-center"
            label=""
          />
          <div className="absolute inset-0 bg-[#08251a]/80" />
          <div className="relative mx-auto flex max-w-7xl flex-col items-start justify-between gap-7 md:flex-row md:items-center">
            <div>
              <SectionEyebrow>Join Our Academy</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-black italic sm:text-4xl">LET&apos;S GROW TOGETHER!</h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/75">
                Bergabunglah dan mulai perjalanan futsal bersama academy kami.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" onClick={onRegisterClick} className="bg-[#c8e600] font-bold text-[#08251a] hover:bg-[#d9f528]">
              {content?.registrationCta?.text ?? "Daftar Sekarang"} <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button size="lg" variant="outline" onClick={onCheckStatusClick} className="border-white/45 bg-transparent text-white hover:bg-white/10 hover:text-white">
              Cek Status Pendaftaran
              </Button>
            </div>
          </div>
        </section>
      </main>

      <div id="contact" className="scroll-mt-20">
        <PublicFooter
          academyName={academyName}
          contact={content?.contact ?? publicSiteConfig.contact}
        />
      </div>
    </div>
  );
}
