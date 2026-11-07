"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publicSiteConfig } from "@/config/public-site";
import {
  PhotoPlaceholder,
  PublicFooter,
  PublicNavbar,
  SectionEyebrow,
  VideoPreview,
} from "@/components/public/PublicSiteChrome";

interface CoachContent {
  name: string;
  role?: string;
  bio?: string;
}

interface CoachProfile {
  name: string;
  position: string;
  biography: string;
  experience: string;
  portrait: string;
}

interface CoachVideo {
  id?: string;
  title: string;
  description?: string;
  videoId: string;
  thumbnail: string;
  isFeatured?: boolean;
}

interface CoachesPageData {
  content: {
    coaches?: CoachContent[];
    contact?: { phone?: string; email?: string; whatsapp?: string };
  };
  videos: { id: string; title: string; videoId: string; isFeatured?: boolean }[];
}

const philosophyIcons = {
  activity: Activity,
  shield: ShieldCheck,
  users: Users,
  sparkles: Sparkles,
} as const;

function getCoachPlaceholder(index: number): CoachProfile {
  const profile = publicSiteConfig.coaches.profiles[
    index % publicSiteConfig.coaches.profiles.length
  ];
  if (!profile) throw new Error("At least one coach placeholder is required.");
  return profile;
}

function getVideoPlaceholder(index: number): CoachVideo {
  const video = publicSiteConfig.coaches.trainingVideos[
    index % publicSiteConfig.coaches.trainingVideos.length
  ];
  if (!video) throw new Error("At least one training video placeholder is required.");
  return video;
}

export function CoachesPage() {
  const [page, setPage] = useState<CoachesPageData | null>(null);
  const [cmsNotice, setCmsNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          "/api/public/landing?academyId=00000000-0000-0000-0000-000000000001",
        );
        if (cancelled) return;
        if (response.status === 404) {
          setCmsNotice("Menampilkan profil contoh. Konten akademi belum dipublikasikan.");
          return;
        }
        if (!response.ok) {
          setCmsNotice("Konten CMS tidak dapat dimuat. Menampilkan profil contoh.");
          return;
        }
        setPage((await response.json()) as CoachesPageData);
      } catch {
        if (!cancelled) setCmsNotice("Tidak dapat terhubung ke CMS. Menampilkan profil contoh.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const publishedCoaches = page?.content?.coaches;
  const coaches: CoachProfile[] = publishedCoaches?.length
    ? publishedCoaches.map((coach, index) => {
        const placeholder = getCoachPlaceholder(index);
        return {
          ...placeholder,
          name: coach.name,
          position: coach.role ?? placeholder.position,
          biography: coach.bio ?? placeholder.biography,
        };
      })
    : [...publicSiteConfig.coaches.profiles];
  const videos: CoachVideo[] = page?.videos.length
    ? page.videos.map((video, index) => ({
        ...getVideoPlaceholder(index),
        ...video,
      }))
    : [...publicSiteConfig.coaches.trainingVideos];

  return (
    <div className="min-h-screen bg-[#08251a] text-[#f5f5ef]">
      <PublicNavbar activePage="coaches" />
      {cmsNotice && (
        <p role="status" className="border-b border-[#c8e600]/20 bg-[#103a29] px-4 py-2 text-center text-xs text-[#f5f5ef]/70">
          {cmsNotice}
        </p>
      )}

      <main>
        <section className="grid min-h-[430px] overflow-hidden bg-[#08251a] lg:grid-cols-[0.85fr_1.15fr]">
          <div className="flex flex-col justify-center px-5 py-14 sm:px-8 sm:py-20 lg:pl-[max(2rem,calc((100vw-80rem)/2))] lg:pr-10">
            <SectionEyebrow>Meet Our Team</SectionEyebrow>
            <h1 className="mt-5 text-5xl font-black italic leading-[0.98] tracking-tight sm:text-6xl xl:text-7xl">
              GUIDED BY
              <span className="block text-[#c8e600]">EXPERIENCE.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-[#f5f5ef]/75 sm:text-lg">
              Pelatih kami mendampingi setiap pemain dengan latihan yang terarah,
              lingkungan yang positif, dan semangat untuk terus berkembang.
            </p>
            <div className="mt-8">
              <Link href="/domain?view=register">
                <Button size="lg" className="bg-[#c8e600] font-bold text-[#08251a] hover:bg-[#d9f528]">
                  Gabung Sekarang <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              </Link>
            </div>
          </div>
          <div className="relative min-h-[300px] sm:min-h-[380px] lg:min-h-[430px]">
            <PhotoPlaceholder
              src={publicSiteConfig.coaches.heroImage}
              alt={publicSiteConfig.coaches.heroImageAlt}
              className="inset-0"
              position="absolute"
              imageClassName="object-[center_35%]"
              label="Foto tim pelatih"
              priority
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#08251a] via-[#08251a]/10 to-transparent" />
          </div>
        </section>

        <section id="team" className="scroll-mt-20 bg-[#f5f5ef] px-5 py-16 text-[#08251a] sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <SectionEyebrow>Coaching Team</SectionEyebrow>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-3xl font-black italic sm:text-4xl">Meet The Coaches</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-[#526258]">
                  Kenali tim yang hadir untuk membimbing proses belajar dan perkembangan pemain.
                </p>
              </div>
              <span className="text-xs font-semibold uppercase tracking-wider text-[#547b25]">
                {coaches.length} {coaches.length === 1 ? "Coach" : "Coaches"}
              </span>
            </div>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {coaches.map((coach, index) => (
                <article key={`${coach.name}-${index}`} className="group overflow-hidden rounded-xl border border-[#08251a]/10 bg-white shadow-sm">
                  <PhotoPlaceholder
                    src={coach.portrait}
                    alt={`Foto ${coach.name}`}
                    className="aspect-[4/3]"
                    imageClassName="transition-transform duration-300 group-hover:scale-105"
                    label="Foto pelatih akan diperbarui"
                  />
                  <div className="p-5">
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#547b25]">Coach 0{index + 1}</p>
                    <h3 className="mt-2 text-xl font-black italic">{coach.name}</h3>
                    <p className="mt-1 text-xs font-semibold text-[#547b25]">{coach.position}</p>
                    <p className="mt-4 text-sm leading-6 text-[#526258]">{coach.biography}</p>
                    <p className="mt-4 border-t border-[#08251a]/10 pt-3 text-xs font-semibold text-[#315d3d]">
                      {coach.experience}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#103a29] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <SectionEyebrow>Our Philosophy</SectionEyebrow>
            <div className="mt-3 max-w-2xl">
              <h2 className="text-3xl font-black italic sm:text-4xl">More Than The Game</h2>
              <p className="mt-3 text-sm leading-6 text-[#b8c5bb]">
                Setiap sesi latihan adalah kesempatan untuk mengembangkan kemampuan,
                karakter, dan kecintaan terhadap permainan.
              </p>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {publicSiteConfig.coaches.philosophy.map((item) => {
                const Icon = philosophyIcons[item.icon];
                return (
                  <article key={item.title} className="rounded-xl border border-white/10 bg-[#08251a]/45 p-5">
                    <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#c8e600] text-[#08251a]">
                      <Icon className="h-5 w-5" aria-hidden />
                    </span>
                    <h3 className="mt-4 font-bold">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-[#b8c5bb]">{item.description}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="training" className="scroll-mt-20 bg-[#08251a] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <SectionEyebrow>On The Pitch</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-black italic sm:text-4xl">Training In Action</h2>
            <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {publicSiteConfig.coaches.trainingPhotos.map((photo) => (
                <figure key={photo.caption} className="overflow-hidden rounded-lg border border-white/10 bg-[#103a29]">
                  <PhotoPlaceholder
                    src={photo.image}
                    alt={photo.alt}
                    className="aspect-[4/3]"
                    imageClassName="transition-transform duration-300 hover:scale-105"
                    label="Foto latihan akan diperbarui"
                  />
                  <figcaption className="px-4 py-3 text-sm font-semibold">{photo.caption}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#103a29] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <SectionEyebrow>Watch Our Sessions</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-black italic sm:text-4xl">Training Videos</h2>
            <div className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {videos.slice(0, 4).map((video) => (
                <VideoPreview
                  key={video.id || video.title}
                  title={video.title}
                  description={video.description ?? "Cuplikan sesi latihan akademi."}
                  thumbnail={video.thumbnail}
                  videoId={video.videoId}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden bg-[#08251a] px-5 py-16 sm:px-8 sm:py-20">
          <PhotoPlaceholder
            src={publicSiteConfig.coaches.heroImage}
            alt=""
            className="inset-0"
            position="absolute"
            label=""
          />
          <div className="absolute inset-0 bg-[#08251a]/85" />
          <div className="relative mx-auto flex max-w-7xl flex-col items-start justify-between gap-7 md:flex-row md:items-center">
            <div>
              <SectionEyebrow>Start Your Journey</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-black italic sm:text-4xl">READY TO GROW?</h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/75">
                Mulai perjalanan futsal dan berkembang bersama tim academy kami.
              </p>
            </div>
            <Link href="/domain?view=register">
              <Button size="lg" className="bg-[#c8e600] font-bold text-[#08251a] hover:bg-[#d9f528]">
                Daftar Sekarang <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      <PublicFooter contact={page?.content?.contact ?? publicSiteConfig.contact} />
    </div>
  );
}
