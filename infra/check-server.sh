#!/usr/bin/env bash
# infra/check-server.sh — Quick production health check for AegisLink
#
# Run from local machine:
#   bash infra/check-server.sh
#
# Or on the VM:
#   bash /opt/aegislink/infra/check-server.sh

set -euo pipefail

DOMAIN="aegislink.duckdns.org"

echo "=== Health check ==="
if curl -sf "https://${DOMAIN}/health" --max-time 10; then
  echo " -- HTTPS OK"
else
  echo " -- HTTPS FAILED (nginx down or certificate missing)"
fi

# HTTP should redirect to HTTPS (301) — curl -L would follow it
HTTP_CODE=$(curl -o /dev/null -sw '%{http_code}' "http://${DOMAIN}/health" --max-time 10 || true)
if [[ "$HTTP_CODE" == "301" || "$HTTP_CODE" == "302" ]]; then
  echo " -- HTTP redirect to HTTPS: OK (${HTTP_CODE})"
else
  echo " -- HTTP status: ${HTTP_CODE} (expected 301 redirect)"
fi

echo ""
echo "=== Socket.IO polling check ==="
SIORESPONSE=$(curl -sf "https://${DOMAIN}/socket.io/?EIO=4&transport=polling" --max-time 10 | head -c 100 || echo "FAILED")
echo "${SIORESPONSE}"
if [[ "$SIORESPONSE" == *"sid"* ]]; then
  echo " -- Socket.IO: OK"
else
  echo " -- Socket.IO: UNEXPECTED RESPONSE (check relay is running via pm2)"
fi

echo ""
echo "=== TLS certificate check ==="
EXPIRY=$(echo | openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || echo "UNKNOWN")
echo " -- Certificate expires: ${EXPIRY}"

echo ""
echo "=== Relay process (run on VM only) ==="
if command -v pm2 &>/dev/null; then
  pm2 status aegislink-relay
else
  echo " -- pm2 not available on this machine (run on VM to see relay status)"
fi
