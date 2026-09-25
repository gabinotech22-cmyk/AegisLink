# Debian slim (glibc), not Alpine: the relay's crypto runs on native libsodium
# (sodium-native, F-1), whose prebuilt binaries are glibc-only (>= 2.33) and do
# not load on musl. bookworm ships glibc 2.36.

# ── Build stage ────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS builder

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
FROM node:26-bookworm-slim AS runtime

# Non-root user for least-privilege operation. uid 100 / gid 101 are EXACTLY what
# the former Alpine image's `adduser -S` produced: existing self-hosted volumes
# (/data, /app/uploads) are owned by them, so a different uid would leave the
# relay unable to write its own DB after the image switch.
RUN groupadd --system --gid 101 aegis \
 && useradd --system --uid 100 --gid 101 --no-create-home --shell /usr/sbin/nologin aegis

WORKDIR /app

# Only copy production deps manifest then install (no devDeps)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source (tsx runs TypeScript directly in production to avoid a compile step)
COPY --from=builder /app/src ./src

# Persistent volume mount points: SQLite DB and the 24 h blob store. Both must
# belong to `aegis` IN THE IMAGE — a fresh named volume copies the mount
# point's ownership on first use, and the relay writes as uid 100. Without the
# uploads line every self-hosted relay answered POST /blob/upload with 500
# (EACCES on a root-owned volume): no attachment could ever be sent through it.
RUN mkdir -p /data /app/uploads && chown aegis:aegis /data /app/uploads

USER aegis

# Environment defaults — override via docker-compose or secrets
# AEGIS_DB_PATH is the name the app actually reads (server/src/db/client.ts).
ENV NODE_ENV=production \
    PORT=3001 \
    AEGIS_DB_PATH=/data/aegislink.db \
    TRUST_PROXY=1

EXPOSE 3001

# Health check — no user data, just liveness. Uses node's fetch: the slim image
# has no wget/curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>r.json()).then(j=>process.exit(j.ok===true?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
