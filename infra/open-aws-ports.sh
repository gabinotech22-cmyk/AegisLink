#!/bin/bash
# ============================================================
# AegisLink — Abre puertos en el Security Group de AWS + iptables del SO
# Requiere: AWS CLI v2 configurado (aws configure) con permisos EC2.
#
# Uso:
#   bash infra/open-aws-ports.sh                 # autodetecta por IP pública
#   PUBLIC_IP=51.20.60.155 REGION=eu-north-1 bash infra/open-aws-ports.sh
#   SG_ID=sg-0123… bash infra/open-aws-ports.sh  # salta la autodetección
# ============================================================
set -euo pipefail

REGION="${REGION:-eu-north-1}"
PUBLIC_IP="${PUBLIC_IP:-$(getent hosts aegislink.duckdns.org | awk '{print $1}' | head -1)}"
PUBLIC_IP="${PUBLIC_IP:-51.20.60.155}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-$HOME/Downloads/ssh-key-2026-05-20.key}"

echo "🔍 Región: $REGION · IP pública: $PUBLIC_IP"

# ── Localizar el Security Group de la instancia por su IP pública ──────────────
if [ -z "${SG_ID:-}" ]; then
  echo "🔍 Buscando la instancia EC2 por IP pública..."
  SG_ID=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=ip-address,Values=$PUBLIC_IP" \
    --query "Reservations[0].Instances[0].SecurityGroups[0].GroupId" \
    --output text 2>/dev/null)
fi

if [ -z "${SG_ID:-}" ] || [ "$SG_ID" = "None" ]; then
  echo "  ⚠️  No pude autodetectar el Security Group. Pásalo con SG_ID=sg-…"
  exit 1
fi
echo "  Security Group: $SG_ID"

# ── Abrir puertos (idempotente — ignora reglas ya existentes) ──────────────────
echo "🔓 Autorizando ingress en el Security Group..."
authorize() { # proto port description
  aws ec2 authorize-security-group-ingress \
    --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=$1,FromPort=$2,ToPort=$2,IpRanges=[{CidrIp=0.0.0.0/0,Description='$3'}]" \
    >/dev/null 2>&1 && echo "  ✅ $3 ($1/$2)" \
    || echo "  • $3 ($1/$2) ya existente o no aplicable"
}
authorize tcp 22   "SSH"
authorize tcp 80   "HTTP"
authorize tcp 443  "HTTPS"
# NOTE: port 3001 (relay cleartext) is intentionally NOT exposed. The relay is
# bound to 127.0.0.1 (see docker-compose.yml) and reachable only via nginx on 443.
# Publishing 3001 to 0.0.0.0/0 would expose the relay in cleartext (no TLS, no
# cert-pinning) and leak metadata. See security audit 2026-07.
authorize tcp 3478 "TURN TCP"
authorize udp 3478 "TURN UDP"

# ── Abrir puertos en iptables del servidor (cloud-agnostic) ───────────────────
if [ -f "$SSH_KEY" ]; then
  echo ""
  echo "🔥 Abriendo puertos en iptables del servidor..."
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    "${SSH_USER}@${PUBLIC_IP}" "
      sudo iptables -I INPUT 1 -p tcp -m multiport --dports 22,80,443,3478 -j ACCEPT
      sudo iptables -I INPUT 1 -p udp --dport 3478 -j ACCEPT
      sudo apt-get install -y -q iptables-persistent netfilter-persistent 2>/dev/null || true
      sudo netfilter-persistent save 2>/dev/null || sudo sh -c 'iptables-save > /etc/iptables/rules.v4'
      echo '  → iptables guardado'
      curl -s http://localhost:3001/health 2>/dev/null && echo ' relay OK' || echo '  relay no responde en :3001'
    "
else
  echo "  ⚠️  Clave SSH no encontrada en $SSH_KEY — salto la parte de iptables."
fi

echo ""
echo "✅ Listo. URLs de producción:"
echo "   Relay:  https://aegislink.duckdns.org"
echo "   Health: https://aegislink.duckdns.org/health"
echo "   TURN:   turn:aegislink.duckdns.org:3478"
