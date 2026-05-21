#!/usr/bin/env bash
# AegisLink Relay — Deploy desde tu máquina local a la VM de Oracle Cloud
#
# Uso:
#   bash deploy.sh <IP_PUBLICA>
#   bash deploy.sh <IP_PUBLICA> --restart-coturn
#
# Requisitos locales:
#   - ssh configurado con acceso a root@<IP> o al usuario VM_USER
#   - PM2 instalado en la VM (npm install -g pm2)
#
# Variables de entorno opcionales:
#   VM_USER     — usuario SSH (default: root)
#   VM_PORT     — puerto SSH (default: 22)
#   APP_DIR     — directorio en la VM (default: /home/aegis/app)

set -euo pipefail

SERVER_IP="${1:?Uso: bash deploy.sh TU_IP [--restart-coturn]}"
RESTART_COTURN=false
[[ "${2:-}" == "--restart-coturn" ]] && RESTART_COTURN=true

VM_USER="${VM_USER:-root}"
VM_PORT="${VM_PORT:-22}"
APP_DIR="${APP_DIR:-/home/aegis/app}"
REMOTE="${VM_USER}@${SERVER_IP}"
SSH_OPTS="-p ${VM_PORT} -o StrictHostKeyChecking=accept-new"

ARCHIVE="/tmp/aegislink-server-$(date +%s).tar.gz"

echo "╔══════════════════════════════════════════════╗"
echo "║  AegisLink — Deploy to Oracle Cloud VM       ║"
echo "╚══════════════════════════════════════════════╝"
echo "  Host : ${REMOTE}"
echo "  Port : ${VM_PORT}"
echo "  Dir  : ${APP_DIR}"
echo ""

# ── Empaquetar el servidor ────────────────────────────────────────────────────
echo "==> Packaging server..."
cd "$(dirname "$0")/.."
tar \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./deploy' \
  -czf "${ARCHIVE}" .

echo "    Archive: ${ARCHIVE} ($(du -sh "${ARCHIVE}" | cut -f1))"

# ── Subir al VPS ──────────────────────────────────────────────────────────────
echo "==> Uploading to VM..."
# shellcheck disable=SC2086
scp ${SSH_OPTS} "${ARCHIVE}" "${REMOTE}:/tmp/aegislink-server.tar.gz"

# ── Desplegar en la VM ────────────────────────────────────────────────────────
echo "==> Deploying on VM..."
# shellcheck disable=SC2086
ssh ${SSH_OPTS} "${REMOTE}" bash << ENDSSH
set -euo pipefail

APP_DIR="${APP_DIR}"

echo "  --> Extracting..."
mkdir -p "\${APP_DIR}"
tar -xzf /tmp/aegislink-server.tar.gz -C "\${APP_DIR}"
cd "\${APP_DIR}"

echo "  --> Installing production dependencies..."
npm install --omit=dev --silent

# Crear .env si no existe (nunca sobreescribir uno existente)
if [ ! -f .env ]; then
  cat > .env << 'ENV'
PORT=3001
NODE_ENV=production
CORS_ORIGIN=*
TRUST_PROXY=0
# EXPO_ACCESS_TOKEN=
ENV
  echo "  ⚠  .env creado por defecto — edítalo en \${APP_DIR}/.env"
fi

echo "  --> Restarting relay via PM2..."
if pm2 describe aegislink-relay > /dev/null 2>&1; then
  pm2 reload aegislink-relay --update-env
else
  pm2 start npm \
    --name aegislink-relay \
    -- start
fi
pm2 save --force

sleep 2

echo ""
echo "  --> PM2 status:"
pm2 status aegislink-relay

echo ""
echo "  --> Health check:"
curl -sf http://localhost:3001/health && echo " OK" || echo " FAILED — check: pm2 logs aegislink-relay"

ENDSSH

# ── Reiniciar coturn si se pide ───────────────────────────────────────────────
if [ "${RESTART_COTURN}" = "true" ]; then
  echo ""
  echo "==> Restarting coturn..."
  # shellcheck disable=SC2086
  ssh ${SSH_OPTS} "${REMOTE}" "sudo systemctl restart coturn && sudo systemctl status coturn --no-pager"
fi

# ── Limpieza local ────────────────────────────────────────────────────────────
rm -f "${ARCHIVE}"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Deploy completado                           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Relay  : http://${SERVER_IP}:3001/health"
echo ""
echo "  Actualiza en eas.json (preview/production):"
echo "    EXPO_PUBLIC_RELAY_URL=https://<tu-dominio-o-ip>"
echo "    EXPO_PUBLIC_TURN_URL=turn:<tu-dominio-o-ip>:3478"
echo ""
echo "  PM2 logs en VM:  pm2 logs aegislink-relay"
echo "  PM2 status:      pm2 status"
