#!/usr/bin/env bash
# infra/deploy.sh — AegisLink production deploy script
#
# Run on the server (via SSH from CI or manually):
#   bash /opt/aegislink/infra/deploy.sh
#
# Required environment variables (set in /etc/aegislink.env or CI secrets):
#   TURN_SECRET   — HMAC-SHA1 seed for coturn; rotate every 24 h
#   DEPLOY_PATH   — Absolute path to the project root (default: directory of this script's parent)
#   EXTERNAL_IP   — Public IP of this server (used in turnserver.conf if needed)
#
# AegisLink privacy: this script never logs user data, IPs, or credentials.
# The TURN_SECRET is only ever written to the processed coturn config,
# which lives in a tmpfs or root-only directory.

set -euo pipefail

# ── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${DEPLOY_PATH:-$(dirname "$SCRIPT_DIR")}"

echo "[deploy] Project root: $PROJECT_ROOT"

# ── Validate required secrets ───────────────────────────────────────────────
if [[ -z "${TURN_SECRET:-}" ]]; then
  echo "[deploy] ERROR: TURN_SECRET is not set. Aborting." >&2
  exit 1
fi

# ── Pull latest code ────────────────────────────────────────────────────────
echo "[deploy] Pulling latest code from git..."
git -C "$PROJECT_ROOT" pull --ff-only

# ── coturn: NOT deployed from here any more ─────────────────────────────────
# coturn moved to its own "calls" VM (Etapa 1 of the infra roadmap). Rendering
# its config here would be a no-op at best; restarting a container that no longer
# exists on this box would fail the deploy. See infra/coturn/deploy-coturn.sh and
# docs/COTURN-VM-RUNBOOK.md.
#
# TURN_SECRET is still validated above because the RELAY needs it: it signs the
# ephemeral credentials (server/src/routes/turn.ts) that the remote coturn then
# verifies. If you rotate it, you MUST roll it on BOTH VMs or every relayed call
# breaks with 401.

# ── Build & restart relay container ─────────────────────────────────────────
echo "[deploy] Building relay Docker image..."
docker compose -f "$PROJECT_ROOT/docker-compose.yml" build relay

echo "[deploy] Restarting relay service..."
docker compose -f "$PROJECT_ROOT/docker-compose.yml" up -d --no-deps relay

# ── Run DB migrations if the relay exposes a migration command ───────────────
# Currently aegislink-server uses initDb() at startup (auto-migration).
# If a separate migration script is added later, invoke it here:
#
# echo "[deploy] Running DB migrations..."
# docker compose -f "$PROJECT_ROOT/docker-compose.yml" \
#   exec -T relay node --import tsx src/db/migrate.ts

# ── Health check ────────────────────────────────────────────────────────────
echo "[deploy] Waiting for relay to become healthy..."
RELAY_PORT="${PORT:-3001}"
MAX_RETRIES=12
RETRY_INTERVAL=5

for i in $(seq 1 $MAX_RETRIES); do
  if curl --silent --fail "http://localhost:$RELAY_PORT/health" | grep -q '"ok"'; then
    echo "[deploy] Relay is healthy."
    break
  fi
  if [[ $i -eq $MAX_RETRIES ]]; then
    echo "[deploy] ERROR: relay did not become healthy after $((MAX_RETRIES * RETRY_INTERVAL))s." >&2
    docker compose -f "$PROJECT_ROOT/docker-compose.yml" logs --tail=50 relay >&2
    exit 1
  fi
  echo "[deploy] Attempt $i/$MAX_RETRIES — retrying in ${RETRY_INTERVAL}s..."
  sleep "$RETRY_INTERVAL"
done

# ── ntfy (Fase 4 · Slice 2b — mailbox wake-up push) ─────────────────────────
# Must be up BEFORE tor restarts below: tor resolves BOTH HiddenServicePort
# targets ("relay" and "ntfy") once at (re)start, so a stale/absent ntfy
# container at that moment leaves virtual port 8090 dangling until the next
# tor restart. No image to build (upstream binwiederhier/ntfy:latest).
echo "[deploy] Restarting ntfy service..."
if docker compose -f "$PROJECT_ROOT/docker-compose.yml" ps ntfy 2>/dev/null | grep -q "running"; then
  docker compose -f "$PROJECT_ROOT/docker-compose.yml" restart ntfy
else
  docker compose -f "$PROJECT_ROOT/docker-compose.yml" up -d ntfy
fi

# ── Tor onion service (Fase 4 · mailbox mode) ───────────────────────────────
# tor resolves the HiddenServicePort targets ("relay", "ntfy" — Slice 2b) when
# it (re)starts, so this runs AFTER both the relay and ntfy are up — a
# recreated relay container can get a new IP on aegis_internal, and a stale
# tor would keep dialing the old one. Restarting tor is cheap: the onion key
# persists in the tor_keys volume, so the .onion address never changes across
# restarts.
echo "[deploy] Building Tor onion-service image..."
docker compose -f "$PROJECT_ROOT/docker-compose.yml" build tor

echo "[deploy] Restarting Tor onion service..."
if docker compose -f "$PROJECT_ROOT/docker-compose.yml" ps tor 2>/dev/null | grep -q "running"; then
  docker compose -f "$PROJECT_ROOT/docker-compose.yml" restart tor
else
  docker compose -f "$PROJECT_ROOT/docker-compose.yml" up -d tor
fi

# Surface the onion hostname (generated on first boot, persisted in tor_keys).
# The address itself is public client config (EXPO_PUBLIC_ONION_URL), not a
# secret — printing it here leaks nothing.
ONION_HOST=""
for i in $(seq 1 15); do
  ONION_HOST="$(docker compose -f "$PROJECT_ROOT/docker-compose.yml" exec -T tor \
    cat /var/lib/tor/aegislink_relay/hostname 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "$ONION_HOST" ]] && break
  sleep 2
done

if [[ -n "$ONION_HOST" ]]; then
  echo "[deploy] Relay onion service: http://$ONION_HOST"
  echo "[deploy]   -> mobile mailbox builds need EXPO_PUBLIC_ONION_URL=http://$ONION_HOST"
else
  echo "[deploy] WARNING: onion hostname not ready — check: docker compose logs tor" >&2
fi

echo "[deploy] Deploy complete."

# ── Rotate TURN_SECRET: MUST be rolled on BOTH VMs ──────────────────────────
# WARNING: since coturn moved to its own VM, TURN_SECRET is a SHARED secret
# between two machines. The relay signs credentials with it; the remote coturn
# verifies that HMAC. Rotating it HERE ONLY silently breaks every relayed call
# with 401 until coturn is updated too.
#
# The previously suggested one-liner
#   0 3 * * * TURN_SECRET=$(openssl rand -hex 32) bash /opt/aegislink/infra/deploy.sh
# is therefore NO LONGER SAFE and must not be installed as-is. (Verified
# 2026-08-01: no such cron exists on the relay VM — the secret is static today.)
#
# To rotate, roll both sides in one operation: write the new value to
# /etc/aegislink.env here AND to /etc/aegislink-coturn.env on the calls VM, then
# run this script here and infra/coturn/deploy-coturn.sh there. Brief overlap is
# unavoidable: in-flight allocations keep the old credential until they expire.
echo "[deploy] Reminder: TURN_SECRET is SHARED with the calls VM — rotate on BOTH or calls break."

# ── Reload nginx if installed (picks up any config changes) ─────────────────
# This is a no-op when nginx is absent so the script stays environment-agnostic.
if command -v nginx &>/dev/null && systemctl is-active --quiet nginx 2>/dev/null; then
  echo "[deploy] Reloading nginx..."
  nginx -t && nginx -s reload
  echo "[deploy] nginx reloaded."
else
  echo "[deploy] nginx not active — skipping reload."
fi
