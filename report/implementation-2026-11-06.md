# Implementation Report — 2026-11-06 (rev. 2, 2026-11-07)

## Already existed (kept)
Landing page (YouTube video editable from admin CMS), admin panel
(schedule, payments with photo upload + nominal, students, reports,
website CMS), parent portal (reports, videos, schedule, packages,
attendance), auth, migrations, Docker compose, PgLite local dev.

## Created
1. Coach portal (APIs existed but no UI): schedule, roster, attendance
   marking; wired into AuthShell role routing.
2. Training plans: migration 0018, domain module, coach GET/PUT API,
   parent read API (only "visible to parents" plans), coach plan editor,
   new parent "Rencana" tab.
3. Supabase DB layer: PgAdapter auto-enables TLS for Supabase/Neon
   (DB_SSL override); just set DATABASE_URL.
4. Deploy options: docs/deployment.md — Vercel and Docker self-host.

## Rev. 2 — Bun-only + Next.js security bump
- Next.js 16.1.1 → **16.4.5 (latest)**; React 19.3.1; bun.lock updated.
- Dockerfile/Dockerfile.dev: node:22-slim + npm-installed Bun replaced
  with **oven/bun:1.4-slim** — no Node.js anywhere; CMD runs
  `bun run --bun next start`.
- All package scripts run through bun (`bun run --bun ...`); tsx and
  package-lock.json removed; Netlify command switched to bun run build.
- Verified under Bun: next build, tsc, 18 migrations, prod server
  smoke test (landing 200, API OK).
