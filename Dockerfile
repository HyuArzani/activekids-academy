# =============================================================================
# Dockerfile — Futsal Academy Management System
# Multi-stage production build for local Docker testing with real PostgreSQL.
#
# This Dockerfile is INDEPENDENT of the Netlify deployment configuration.
# Netlify remains the production deployment target (see netlify.toml).
# This Dockerfile exists solely for local manual testing with a real
# PostgreSQL database via docker-compose.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder — install dependencies + build the Next.js application
# -----------------------------------------------------------------------------
FROM node:22-slim AS builder

# Install Bun for dependency installation (bun.lock is the lockfile) and
# for running migration/provisioning scripts later in the runner stage.
RUN npm install -g bun

WORKDIR /app

# Copy lockfile + package.json first for Docker layer caching.
COPY package.json bun.lock ./

# Install dependencies reproducibly from the existing lockfile.
RUN bun install --frozen-lockfile

# Copy the full source for the build.
COPY . .

# Build the Next.js application (uses Turbopack via `next build`).
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 2: Runner — production server with PostgreSQL adapter support
# -----------------------------------------------------------------------------
FROM node:22-slim AS runner

# Install Bun for migration + admin-provisioning scripts
# (package.json scripts use `bun run --bun scripts/migrate.ts`).
RUN npm install -g bun

# Create a non-root user for security.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

WORKDIR /app

# --- Build output + dependencies (for `next start`) ---
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# --- Config files (needed by `next start` + scripts) ---
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/bun.lock ./bun.lock
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/tailwind.config.ts ./tailwind.config.ts

# --- Source + scripts (needed for `bun run db:migrate` + `provision-admin`) ---
# The migration and provisioning scripts import from @/lib/... which resolves
# via tsconfig.json paths to ./src/*. Bun respects tsconfig.json paths.
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

USER nextjs

EXPOSE 3000

# Next.js 16 `next start` defaults to 0.0.0.0:3000.
CMD ["npx", "next", "start"]
