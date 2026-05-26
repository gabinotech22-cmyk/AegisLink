#!/bin/bash
# ============================================================
# AegisLink — Abre puertos en Oracle Cloud + iptables del SO
# Ejecutar desde Oracle Cloud Shell
# ============================================================
set -e

echo "🔍 Detectando compartimento..."
COMPARTMENT_ID=$(oci iam compartment list \
  --all \
  --compartment-id-in-subtree true \
  --query "data[?\"lifecycle-state\"=='ACTIVE'] | [0].id" \
  --raw-output 2>/dev/null)

if [ -z "$COMPARTMENT_ID" ]; then
  # fallback: usar el tenancy root
  COMPARTMENT_ID=$(oci iam compartment list \
    --query "data[0].\"compartment-id\"" \
    --raw-output 2>/dev/null)
fi
echo "  Compartimento: $COMPARTMENT_ID"

echo "🔍 Buscando VCN..."
VCN_ID=$(oci network vcn list \
  --compartment-id "$COMPARTMENT_ID" \
  --all \
  --query "data[0].id" \
  --raw-output 2>/dev/null)
echo "  VCN: $VCN_ID"

echo "🔍 Buscando Security List..."
SECLIST_ID=$(oci network security-list list \
  --compartment-id "$COMPARTMENT_ID" \
  --vcn-id "$VCN_ID" \
  --all \
  --query "data[0].id" \
  --raw-output 2>/dev/null)
echo "  Security List: $SECLIST_ID"

echo "🔓 Abriendo puertos en Oracle Security List..."
oci network security-list update \
  --security-list-id "$SECLIST_ID" \
  --ingress-security-rules '[
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":22,"max":22}},"isStateless":false,"description":"SSH"},
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":80,"max":80}},"isStateless":false,"description":"HTTP"},
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":443,"max":443}},"isStateless":false,"description":"HTTPS"},
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":3001,"max":3001}},"isStateless":false,"description":"AegisLink relay"},
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":3478,"max":3478}},"isStateless":false,"description":"TURN TCP"},
    {"protocol":"17","source":"0.0.0.0/0","udpOptions":{"destinationPortRange":{"min":3478,"max":3478}},"isStateless":false,"description":"TURN UDP"}
  ]' \
  --force
echo "  ✅ Security List actualizada"

echo ""
echo "🔑 Arreglando permisos de la clave SSH..."
KEY_FILE=$(ls ~/ssh-key-*.key 2>/dev/null | head -1)
if [ -z "$KEY_FILE" ]; then
  echo "  ⚠️  No encontré clave SSH en ~/ (ssh-key-*.key)"
  echo "  Sube tu clave privada a Cloud Shell y re-ejecuta."
  exit 1
fi
cp "$KEY_FILE" /tmp/aegis_key.pem
chmod 600 /tmp/aegis_key.pem
echo "  Clave: $KEY_FILE → /tmp/aegis_key.pem"

echo ""
echo "🔥 Abriendo puertos en iptables del servidor..."
ssh -i /tmp/aegis_key.pem \
  -o StrictHostKeyChecking=no \
  -o ConnectTimeout=15 \
  ubuntu@aegislink.duckdns.org "
    echo '  → Aplicando reglas iptables...'
    sudo iptables -I INPUT 1 -p tcp -m multiport --dports 22,80,443,3001,3478 -j ACCEPT
    sudo iptables -I INPUT 1 -p udp --dport 3478 -j ACCEPT
    sudo apt-get install -y -q iptables-persistent netfilter-persistent 2>/dev/null || true
    sudo netfilter-persistent save 2>/dev/null || sudo sh -c 'iptables-save > /etc/iptables/rules.v4'
    echo '  → iptables guardado'
    echo ''
    echo '  → Estado Docker:'
    docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo '  Docker no disponible'
    echo ''
    echo '  → Probando relay local:'
    curl -s http://localhost:3001/health 2>/dev/null && echo ' OK' || echo '  relay no responde en :3001'
"

echo ""
echo "🌐 Verificando desde afuera..."
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  http://aegislink.duckdns.org:3001/health 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "404" ]; then
  echo "  ✅ Puerto 3001 accesible (HTTP $HTTP_CODE)"
else
  echo "  ⚠️  Puerto 3001 aún no responde (código: $HTTP_CODE)"
  echo "  Verifica que Docker esté corriendo: docker ps | grep aegislink"
fi

echo ""
echo "✅ Listo. URLs de producción:"
echo "   Relay:  https://aegislink.duckdns.org"
echo "   Health: http://aegislink.duckdns.org:3001/health"
echo "   TURN:   turn:aegislink.duckdns.org:3478"
