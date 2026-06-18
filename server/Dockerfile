# ── Build stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first so Docker layer-caches the install step
COPY package.json package-lock.json ./

# Install all deps (including devDeps needed for tsx / tsc)
RUN npm ci

# Copy source
COPY . .

# Type-check — fail the build if TypeScript is unhappy
RUN npx tsc --noEmit

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Non-root user for least-privilege operation
RUN addgroup -S aegis && adduser -S aegis -G aegis

WORKDIR /app

# Only copy production deps manifest then install (no devDeps)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source (tsx runs TypeScript directly in production to avoid a compile step)
COPY --from=builder /app/src ./src

# Persistent volume mount point for SQLite DB
RUN mkdir -p /data && chown aegis:aegis /data

USER aegis

# Environment defaults — override via docker-compose or secrets
# AEGIS_DB_PATH is the name the app actually reads (server/src/db/client.ts).
ENV NODE_ENV=production \
    PORT=3001 \
    AEGIS_DB_PATH=/data/aegislink.db \
    TRUST_PROXY=1

EXPOSE 3001

# Health check — no user data, just liveness
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health | grep -q '"ok"'

CMD ["node", "--import", "tsx", "src/index.ts"]
