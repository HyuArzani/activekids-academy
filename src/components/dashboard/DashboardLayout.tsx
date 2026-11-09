"use client";

import { Fragment, useState, type ComponentType, type ReactNode } from "react";
import { ArrowUpRight, LogOut, Menu, Trophy, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface DashboardNavItem {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  group?: string;
}

export function DashboardLayout({
  roleLabel,
  userEmail,
  title,
  description,
  navItems,
  activeItem,
  onNavigate,
  onLogout,
  topActions,
  children,
}: {
  roleLabel: string;
  userEmail: string;
  title: string;
  description?: string;
  navItems: DashboardNavItem[];
  activeItem: string;
  onNavigate: (id: string) => void;
  onLogout: () => void;
  topActions?: ReactNode;
  children: ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const renderNavigation = (mobile = false) => (
    <nav aria-label={`${roleLabel} navigation`} className="space-y-5">
      {navItems.map((item, index) => {
        const Icon = item.icon;
        const previousGroup = navItems[index - 1]?.group;
        return (
          <Fragment key={item.id}>
            {item.group !== previousGroup && item.group && (
              <p className="px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
                {item.group}
              </p>
            )}
            <button
              type="button"
              aria-current={activeItem === item.id ? "page" : undefined}
              onClick={() => {
                onNavigate(item.id);
                if (mobile) setMobileNavOpen(false);
              }}
              className={`group flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium transition-colors ${
                activeItem === item.id
                  ? "bg-[#c8e600] text-[#08251a] shadow-[0_8px_24px_rgba(200,230,0,0.12)]"
                  : "text-white/70 hover:bg-white/8 hover:text-white"
              }`}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );

  const sidebar = (mobile = false) => (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[88px] items-center justify-between border-b border-white/10 px-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#c8e600] text-[#08251a]">
            <Trophy className="h-5 w-5" aria-hidden />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-black tracking-[0.12em] text-white">FUTSAL</span>
            <span className="mt-1 block text-[9px] font-semibold tracking-[0.2em] text-white/55">ACADEMY</span>
          </span>
        </div>
        {mobile && (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-6">{renderNavigation(mobile)}</div>

      <div className="border-t border-white/10 p-4">
        <div className="mb-4 flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-[#c8e600]">
            {userEmail.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/45">{roleLabel}</p>
            <p className="truncate text-xs text-white/80">{userEmail}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          onClick={onLogout}
          className="w-full justify-start gap-3 rounded-xl text-white/70 hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Keluar
        </Button>
        <a
          href="/domain"
          className="mt-1 flex min-h-10 items-center gap-3 rounded-xl px-3 text-xs text-white/50 transition-colors hover:bg-white/5 hover:text-white/80"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden />
          Lihat situs publik
        </a>
      </div>
    </div>
  );

  return (
    <div className="dashboard-theme min-h-screen bg-background text-foreground lg:flex">
      <aside className="sticky top-0 hidden h-screen w-[17rem] shrink-0 bg-[#08251a] lg:block">
        {sidebar()}
      </aside>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="absolute inset-0 bg-[#04160f]/65 backdrop-blur-[2px]"
          />
          <aside
            id="dashboard-navigation"
            role="dialog"
            aria-modal="true"
            aria-label={`${roleLabel} navigation`}
            className="relative h-full w-[min(19rem,86vw)] bg-[#08251a] shadow-2xl"
          >
            {sidebar(true)}
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b border-[#08251a]/8 bg-[#f5f5ef]/95 backdrop-blur-xl">
          <div className="flex min-h-[72px] items-center justify-between gap-3 px-4 sm:px-7 lg:px-10">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                aria-label="Open navigation"
                aria-expanded={mobileNavOpen}
                aria-controls="dashboard-navigation"
                onClick={() => setMobileNavOpen(true)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#08251a]/10 bg-white text-[#315d3d] shadow-sm lg:hidden"
              >
                <Menu className="h-5 w-5" aria-hidden />
              </button>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#547b25]">{roleLabel}</p>
                <p className="truncate text-xs text-[#526258] sm:text-sm">{userEmail}</p>
              </div>
            </div>
            {topActions && <div className="flex min-w-0 items-center gap-2">{topActions}</div>}
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] px-4 pb-10 pt-7 sm:px-7 sm:pt-9 lg:px-10">
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#547b25]">Futsal Academy</p>
              <h1 className="mt-2 text-2xl font-black tracking-tight text-[#08251a] sm:text-3xl">{title}</h1>
              {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-[#607166]">{description}</p>}
            </div>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
