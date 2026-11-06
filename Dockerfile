# =============================================================================
# Dockerfile — Futsal Academy Management System
# Multi-stage production build. Bun-only: Bun installs dependencies, runs the
# Next.js build, serves the production server, and runs migration /
# provisioning scripts. No Node.js is installed or used at any stage.
#
# Works for local Docker testing (docker-compose.yml) and for self-hosted
# deployment. For Vercel, no Dockerfile is needed — see docs/deployment.md.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder — install dependencies + build the Next.js application
# -----------------------------------------------------------------------------
FROM oven/bun:1.4-slim AS builder

WORKDIR /app

# Copy lockfile + package.json first for Docker layer caching.
COPY package.json bun.lock ./

# Install dependencies reproducibly from the existing lockfile.
RUN bun install --frozen-lockfile

# Copy the full source for the build.
COPY . .

# Build the Next.js application (uses Turbopack via `next build`).
# `bun run --bun` forces the Bun runtime (instead of spawning Node.js) for
# the `next` binary — Next.js 16 runs its build/dev/start commands on Bun.
RUN bun run --bun next build

# -----------------------------------------------------------------------------
# Stage 2: Runner — production server with PostgreSQL adapter support
# -----------------------------------------------------------------------------
FROM oven/bun:1.4-slim AS runner

# Create a non-root user for security.
RUN groupadd --system --gid 1001 nextjs && \
    useradd --system --uid 1001 --gid nextjs nextjs

WORKDIR /app

# --- Build output + dependencies (for `next start`) ---
COPY --from=builder --chown=nextjs:nextjs /app/.next ./.next
COPY --from=builder --chown=nextjs:nextjs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

# --- Config files (needed by `next start` + scripts) ---
COPY --from=builder --chown=nextjs:nextjs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nextjs /app/bun.lock ./bun.lock
COPY --from=builder --chown=nextjs:nextjs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=nextjs:nextjs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nextjs /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder --chown=nextjs:nextjs /app/tailwind.config.ts ./tailwind.config.ts

# --- Source + scripts (needed for `bun run db:migrate` + `provision-admin`) ---
# The migration and provisioning scripts import from @/lib/... which resolves
# via tsconfig.json paths to ./src/*. Bun respects tsconfig.json paths.
COPY --from=builder --chown=nextjs:nextjs /app/src ./src
COPY --from=builder --chown=nextjs:nextjs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nextjs /app/scripts ./scripts

USER nextjs

EXPOSE 3000

# Production server under the Bun runtime (no Node.js in this image).
CMD ["bun", "run", "--bun", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
