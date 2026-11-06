# Deployment & Local Development Guide

ActiveKids Academy runs as a standard Next.js 16 app (16.4.5, current
latest). The application code is **database-agnostic** behind the
`DbClient` interface — both deployment options below use the same build.
The JS runtime is **Bun-only**: `bun.lock` is the lockfile, all scripts
run through `bun run`, and the Docker images are `oven/bun` with no
Node.js installed. Two always-available deployment paths:

1. **Vercel** (recommended for simplicity)
2. **Docker** (self-hosted — `Dockerfile` + `docker-compose.yml` already exist)

---

## Database layer: Supabase

The project uses Supabase **only as the PostgreSQL database layer** (no
Supabase Auth/Storage — auth is the app's own Argon2id + session system).

1. Create a Supabase project → *Project Settings → Database → Connection
   string (URI)*. Use the **session pooler** URI for Vercel (port 5432).
2. Run migrations against it (see below). All 18 migration files apply
   cleanly to plain PostgreSQL — no extensions required.
3. Configure the app env:

```env
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
SESSION_SECRET=<random ≥32 chars>
CSRF_SECRET=<random ≥32 chars>
ACADEMY_TIMEZONE=Asia/Jakarta
DB_POOL_MAX=1        # Vercel serverless; use 5-10 for Docker
```

TLS is automatic: the adapter enables SSL for Supabase/Neon hosts or
`?sslmode=require`, or force it with `DB_SSL=true`
(see `src/lib/db/pg-adapter.ts`).

### Running migrations

```bash
bun run db:migrate            # apply pending migrations
bun run db:migrate:status     # list applied / pending
bun run provision-admin       # create the first admin (prompts for password)
bun run db:seed               # optional demo data (local dev only)
```

## Option A — Vercel

1. Import the repo into Vercel (framework auto-detected as Next.js).
2. Set the env vars above in *Project → Settings → Environment Variables*.
3. Deploy. No extra config needed — `next.config.ts` is Vercel-compatible.
4. After the first deploy, run `bun run db:migrate` and
   `bun run provision-admin` locally with the same `DATABASE_URL` to
   initialize the schema and admin account.

> Serverless notes: keep `DB_POOL_MAX=1` (each function instance gets its
> own pool) and use the Supabase session pooler to avoid connection limits.

## Option B — Docker (self-hosted)

The repo ships `Dockerfile` (multi-stage, bun-only — `oven/bun:1.4-slim`
base, no Node.js in the image),
`docker-compose.yml` (app + PostgreSQL service) and `.env.docker`.

```bash
cp .env.docker .env           # fill in POSTGRES_*, DATABASE_URL, secrets
docker compose up -d --build
docker compose exec app bun run db:migrate
docker compose exec app bun run provision-admin
```

To use **Supabase instead of the bundled `db` service** with Docker, point
`DATABASE_URL` at Supabase in `.env` and remove the `db:` service from
`docker-compose.yml`.

## Local development (no database install needed)

By default (no `DATABASE_URL`), the app runs on **embedded PostgreSQL
(PgLite)** — zero external services:

```bash
bun install
bun run db:migrate      # migrates the local PgLite database
bun run db:seed         # optional demo data
bun run provision-admin # first admin account
bun run dev             # http://localhost:3000
```

To develop against Supabase instead, set `DATABASE_URL` in `.env` before
running `bun run db:migrate` and `bun run dev`.

## Roles & first login

- **admin** — full management panel (schedule, students, payments with
  manual photo upload, landing-page CMS incl. YouTube preview video).
- **parent** — child reports, videos, schedule, packages, attendance,
  and coach-shared training plans.
- **coach** — own schedule, roster + attendance marking, per-session
  training plans (optional parent visibility).

Provision the admin with `bun run provision-admin`; parents register via
the public landing page, coaches are linked by an admin.
