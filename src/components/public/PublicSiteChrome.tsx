"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, Trophy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publicSiteConfig } from "@/config/public-site";

const navigation = [
  { label: "Home", href: "/domain#top", id: "home" },
  { label: "Programs", href: "/domain#programs", id: "programs" },
  { label: "Schedule", href: "/domain#schedule", id: "schedule" },
  { label: "About", href: "/domain#about", id: "about" },
  { label: "Coaches", href: "/coaches", id: "coaches" },
  { label: "Contact", href: "/domain#contact", id: "contact" },
];

export function PublicNavbar({
  activePage,
  onLoginClick,
}: {
  activePage: "home" | "coaches";
  onLoginClick?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#08251a] text-white">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/domain#top" className="flex shrink-0 items-center gap-2.5" aria-label="Futsal Academy home">
          {publicSiteConfig.logo.image ? (
            <PhotoPlaceholder
              src={publicSiteConfig.logo.image}
              alt={publicSiteConfig.logo.imageAlt}
              className="h-9 w-9 rounded-lg"
              imageClassName="object-contain p-0.5"
              label={publicSiteConfig.logo.text}
            />
          ) : (
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#c8e600] text-[#08251a]">
              <Trophy className="h-5 w-5" aria-hidden />
            </span>
          )}
          <span className="leading-tight">
            <span className="block text-sm font-black tracking-wide">{publicSiteConfig.logo.text}</span>
            <span className="block text-[10px] font-semibold tracking-[0.18em] text-white/65">{publicSiteConfig.logo.subtext}</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-5 lg:flex" aria-label="Main navigation">
          {navigation.map((item) => {
            const active = item.id === activePage || (activePage === "coaches" && item.id === "coaches");
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`text-xs font-medium transition-colors hover:text-[#c8e600] ${active ? "text-[#c8e600]" : "text-white/85"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-2 sm:flex">
          {onLoginClick ? (
            <Button variant="ghost" size="sm" onClick={onLoginClick} className="text-white hover:bg-white/10 hover:text-white">
              Login
            </Button>
          ) : (
            <Link href="/admin" className="rounded-md px-3 py-2 text-sm text-white/85 transition-colors hover:bg-white/10 hover:text-white">
              Login
            </Link>
          )}
          <Link href="/domain?view=register" className="rounded-md bg-[#c8e600] px-4 py-2 text-sm font-bold text-[#08251a] transition-colors hover:bg-[#d9f528]">
            Register
          </Link>
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/20 text-white sm:hidden"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {menuOpen && (
        <nav className="border-t border-white/10 bg-[#08251a] px-4 py-3 sm:hidden" aria-label="Mobile navigation">
          <div className="mx-auto flex max-w-7xl flex-col gap-1">
            {navigation.map((item) => {
              const active = item.id === activePage || (activePage === "coaches" && item.id === "coaches");
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={`rounded-md px-3 py-2.5 text-sm font-medium ${active ? "bg-white/10 text-[#c8e600]" : "text-white/85 hover:bg-white/5"}`}
                >
                  {item.label}
                </Link>
              );
            })}
            <div className="mt-2 flex gap-2 border-t border-white/10 pt-3">
              {onLoginClick ? (
                <Button variant="outline" onClick={() => { setMenuOpen(false); onLoginClick(); }} className="border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white">
                  Login
                </Button>
              ) : (
                <Link href="/admin" onClick={() => setMenuOpen(false)} className="rounded-md border border-white/25 px-4 py-2 text-sm text-white">
                  Login
                </Link>
              )}
              <Link href="/domain?view=register" onClick={() => setMenuOpen(false)} className="rounded-md bg-[#c8e600] px-4 py-2 text-sm font-bold text-[#08251a]">
                Register
              </Link>
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}

export function PublicFooter({
  academyName = publicSiteConfig.academyName,
  contact = publicSiteConfig.contact,
}: {
  academyName?: string;
  contact?: { email?: string; phone?: string; whatsapp?: string };
}) {
  const footerLinks = [
    { label: "Home", href: "/domain#top" },
    { label: "Programs", href: "/domain#programs" },
    { label: "Schedule", href: "/domain#schedule" },
    { label: "About", href: "/domain#about" },
    { label: "Coaches", href: "/coaches" },
    { label: "Contact", href: "/domain#contact" },
  ];

  return (
    <footer className="border-t border-white/10 bg-[#08251a] text-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 sm:px-8 md:grid-cols-[1.2fr_1fr_1fr]">
        <div>
          <Link href="/domain#top" className="flex w-fit items-center gap-2.5">
            {publicSiteConfig.logo.image ? (
              <PhotoPlaceholder
                src={publicSiteConfig.logo.image}
                alt={publicSiteConfig.logo.imageAlt}
                className="h-9 w-9 rounded-lg"
                imageClassName="object-contain p-0.5"
                label={publicSiteConfig.logo.text}
              />
            ) : (
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#c8e600] text-[#08251a]">
                <Trophy className="h-5 w-5" aria-hidden />
              </span>
            )}
            <span className="leading-tight">
              <span className="block text-sm font-black tracking-wide">{publicSiteConfig.logo.text}</span>
              <span className="block text-[10px] font-semibold tracking-[0.18em] text-white/65">{publicSiteConfig.logo.subtext}</span>
            </span>
          </Link>
          <p className="mt-4 max-w-sm text-sm leading-6 text-white/65">
            Tempat belajar futsal, membangun karakter, dan berkembang bersama.
          </p>
        </div>

        <div>
          <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-[#c8e600]">Explore</h2>
          <nav className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2" aria-label="Footer navigation">
            {footerLinks.map((item) => (
              <Link key={item.label} href={item.href} className="text-sm text-white/70 transition-colors hover:text-white">
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div>
          <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-[#c8e600]">Contact</h2>
          <div className="mt-3 space-y-2 text-sm text-white/70">
            {contact.phone && <a className="block hover:text-white" href={`tel:${contact.phone}`}>{contact.phone}</a>}
            {contact.email && <a className="block hover:text-white" href={`mailto:${contact.email}`}>{contact.email}</a>}
            {contact.whatsapp && (
              <a
                className="block hover:text-white"
                href={`https://wa.me/${contact.whatsapp.replace(/\D/g, "")}`}
                target="_blank"
                rel="noreferrer"
              >
                WhatsApp
              </a>
            )}
            {!contact.phone && !contact.email && !contact.whatsapp && (
              <p>Informasi kontak academy akan segera diperbarui.</p>
            )}
          </div>
          <div className="mt-4 flex gap-4 text-xs">
            {Object.entries(publicSiteConfig.socialLinks)
              .filter(([, href]) => href)
              .map(([network, href]) => (
                <a key={network} href={href} target="_blank" rel="noreferrer" className="capitalize text-white/70 hover:text-white">
                  {network}
                </a>
              ))}
          </div>
        </div>
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto max-w-7xl px-5 py-4 text-xs text-white/50 sm:px-8">
          © {new Date().getFullYear()} {academyName}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

export function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-[#c8e600]">
      <span className="h-1 w-6 rounded-full bg-[#c8e600]" aria-hidden />
      {children}
    </p>
  );
}

export function PhotoPlaceholder({
  src,
  alt,
  className,
  imageClassName,
  label = "Foto latihan",
  priority = false,
  position = "relative",
}: {
  src: string;
  alt: string;
  className: string;
  imageClassName?: string;
  label?: string;
  priority?: boolean;
  position?: "absolute" | "relative";
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className={`${position} overflow-hidden bg-[#183d2d] ${className}`}>
      {!failed ? (
        <img
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          onError={() => setFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover ${imageClassName ?? ""}`}
        />
      ) : label ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#183d2d] px-4 text-center text-sm font-medium text-white/75">
          {label}
        </div>
      ) : null}
    </div>
  );
}

export function VideoPreview({
  title,
  description,
  thumbnail,
  videoId,
  className = "",
}: {
  title: string;
  description: string;
  thumbnail: string;
  videoId: string;
  className?: string;
}) {
  const [playing, setPlaying] = useState(false);

  if (playing && videoId) {
    return (
      <div className={`aspect-video overflow-hidden rounded-xl bg-black ${className}`}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`}
          title={title}
          allow="encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
          className="h-full w-full"
        />
      </div>
    );
  }

  return (
    <div className={`overflow-hidden rounded-xl border border-white/10 bg-[#103a29] ${className}`}>
      <button
        type="button"
        onClick={() => { if (videoId) setPlaying(true); }}
        disabled={!videoId}
        aria-label={videoId ? `Play ${title}` : `${title}; video coming soon`}
        className={`group relative block aspect-video w-full text-left ${videoId ? "cursor-pointer" : "cursor-default"}`}
      >
        <PhotoPlaceholder src={thumbnail} alt="" className="h-full w-full" label="Video latihan segera hadir" />
        <span className="absolute inset-0 bg-gradient-to-t from-[#08251a]/90 via-[#08251a]/15 to-transparent" />
        <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-[#08251a]/70 text-white transition-colors group-hover:bg-[#c8e600] group-hover:text-[#08251a]">
          <span className="ml-1 border-y-[7px] border-y-transparent border-l-[11px] border-l-current" aria-hidden />
        </span>
        {!videoId && <span className="absolute bottom-3 right-3 rounded bg-[#08251a]/80 px-2 py-1 text-[10px] font-semibold text-white/85">VIDEO SEGERA HADIR</span>}
      </button>
      <div className="px-4 py-3">
        <h3 className="font-bold text-white">{title}</h3>
        <p className="mt-1 text-sm leading-5 text-white/65">{description}</p>
      </div>
    </div>
  );
}
