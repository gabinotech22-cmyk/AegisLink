#!/usr/bin/env bash
# infra/coturn/deploy-coturn.sh — deploy coturn on the DEDICATED calls VM.
#
# Run on the calls VM (NOT the relay VM):
#   set -a; . /etc/aegislink-coturn.env; set +a
#   bash /opt/aegislink/infra/coturn/deploy-coturn.sh
#
# Required environment (put in /etc/aegislink-coturn.env, chmod 600):
#   TURN_SECRET      — MUST be byte-identical to the relay's TURN_SECRET.
#                      The relay SIGNS ephemeral credentials with it
#                      (server/src/routes/turn.ts); coturn VERIFIES that HMAC.
#                      A mismatch means every relayed call fails with 401.
# Optional:
#   EXTERNAL_IP      — this VM's public IP. Auto-detected when unset.
#   TURN_TLS_DOMAIN  — enable the TURNS (TLS) listener on 5349 using the certbot
#                      cert for this domain. Left unset = plain TURN on 3478
#                      only, which is exactly what production advertises today.
#   DEPLOY_PATH      — project root (default: two levels up from this script).
#
# AegisLink privacy: this script never logs user data, IPs of clients, or the
# TURN_SECRET. The rendered config is written root-only (chmod 640).

set -euo pipefail

# ── Resolve paths (relative to THIS script — never a personal machine path) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${DEPLOY_PATH:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.coturn.yml"
CONF_TEMPLATE="$SCRIPT_DIR/turnserver.conf"
CONF_RENDERED="/etc/coturn/turnserver.conf"

echo "[coturn] Project root: $PROJECT_ROOT"

# ── Validate required secret ────────────────────────────────────────────────
if [[ -z "${TURN_SECRET:-}" ]]; then
  echo "[coturn] ERROR: TURN_SECRET is not set." >&2
  echo "[coturn]        It must MATCH the relay's TURN_SECRET exactly, or every" >&2
  echo "[coturn]        relayed call fails with 401. Aborting." >&2
  exit 1
fi

# ── Pull latest code ────────────────────────────────────────────────────────
if git -C "$PROJECT_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "[coturn] Pulling latest code from git..."
  git -C "$PROJECT_ROOT" pull --ff-only
fi

# ── external-ip ─────────────────────────────────────────────────────────────
# coturn runs in host-network mode and sees several interfaces (public + docker
# bridges 172.x). With external-ip EMPTY it advertises a WRONG relay candidate
# (a private 172.x the peer cannot reach) and relay-only calls get ONE-WAY audio
# — the exact bug the security audit 2026-07 caught on the relay VM.
if [[ -z "${EXTERNAL_IP:-}" ]]; then
  EXTERNAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)"
  echo "[coturn] EXTERNAL_IP not set — auto-detected: ${EXTERNAL_IP:-<none>}"
fi
if [[ -z "${EXTERNAL_IP:-}" ]]; then
  echo "[coturn] ERROR: EXTERNAL_IP could not be determined. coturn would advertise" >&2
  echo "[coturn]        an unreachable relay candidate and calls would be one-way." >&2
  echo "[coturn]        Export EXTERNAL_IP=<public-ip> and re-run. Aborting." >&2
  exit 1
fi

# ── Render config (expand TURN_SECRET + EXTERNAL_IP only) ───────────────────
echo "[coturn] Rendering config (secret stays server-side)..."
mkdir -p "$(dirname "$CONF_RENDERED")"
TURN_SECRET="$TURN_SECRET" \
EXTERNAL_IP="$EXTERNAL_IP" \
  envsubst '${TURN_SECRET} ${EXTERNAL_IP}' \
  < "$CONF_TEMPLATE" \
  > "$CONF_RENDERED"

# ── Optional TLS block — appended ONLY when the cert is actually readable ────
# Declaring cert/pkey unconditionally is what the relay VM did: coturn could not
# read the privkey, silently never opened 5349, and the config claimed TLS was
# on. Append only on real files so "no TLS" is visible instead of pretended.
if [[ -n "${TURN_TLS_DOMAIN:-}" ]]; then
  CERT="/etc/letsencrypt/live/${TURN_TLS_DOMAIN}/fullchain.pem"
  KEY="/etc/letsencrypt/live/${TURN_TLS_DOMAIN}/privkey.pem"
  if [[ -r "$CERT" && -r "$KEY" ]]; then
    cat >> "$CONF_RENDERED" <<EOF

# ── TLS (appended by deploy-coturn.sh: cert verified readable) ──────────────
tls-listening-port=5349
cert=$CERT
pkey=$KEY
EOF
    echo "[coturn] TLS enabled for $TURN_TLS_DOMAIN (listener 5349)."
    echo "[coturn]   -> set TURNS_PORT=5349 in the RELAY's env to advertise turns:"
  else
    echo "[coturn] WARNING: TURN_TLS_DOMAIN=$TURN_TLS_DOMAIN but cert/key not readable." >&2
    echo "[coturn]          Continuing WITHOUT TLS (plain TURN on 3478 only)." >&2
  fi
fi

chmod 640 "$CONF_RENDERED"
echo "[coturn] Config written to $CONF_RENDERED"

# ── Start / restart the container ───────────────────────────────────────────
echo "[coturn] Starting coturn..."
docker compose -f "$COMPOSE_FILE" up -d
# Config is mounted read-only, so a re-render needs a restart to take effect.
docker compose -f "$COMPOSE_FILE" restart coturn

# ── Verify ──────────────────────────────────────────────────────────────────
echo "[coturn] Verifying..."
sleep 3
if ! docker inspect -f '{{.State.Running}}' aegislink-coturn 2>/dev/null | grep -q true; then
  echo "[coturn] ERROR: container is not running." >&2
  docker compose -f "$COMPOSE_FILE" logs --tail=50 coturn >&2
  exit 1
fi
if ss -lnu 2>/dev/null | grep -q ":3478"; then
  echo "[coturn] OK: listening on UDP 3478."
else
  echo "[coturn] WARNING: no UDP 3478 listener found — check firewall and logs." >&2
fi

echo "[coturn] Deploy complete. Public TURN: turn:${EXTERNAL_IP}:3478"
echo "[coturn]   -> the RELAY must have TURN_HOST pointing here, and the SAME TURN_SECRET."
