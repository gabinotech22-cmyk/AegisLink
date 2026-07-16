#!/usr/bin/env bash
# infra/deploy-web.sh — Deploy the public landing site to the AegisLink VM.
#
# Run from the local machine:
#   SSH_KEY=~/Desktop/keysVM/aegislink.pem bash infra/deploy-web.sh
#
# Two modes, picked automatically:
#   - If the TLS certificate for aegis-link.it exists on the VM, installs the
#     full config (infra/nginx/aegislink-web.conf: HTTPS + redirects).
#   - Otherwise installs an HTTP-only bootstrap (serves the landing on :80 and
#     answers ACME challenges) so certbot can issue the certificate once DNS
#     points at the server. Re-run after issuing the certificate.
#
# Certificate issuance (one-time, on the VM, after DNS is live):
#   sudo certbot certonly --webroot -w /var/www/certbot \
#     -d aegis-link.it -d www.aegis-link.it \
#     -d aegislink.art -d www.aegislink.art \
#     -d aegislink.shop -d www.aegislink.shop

set -euo pipefail

HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to the VM public IP or hostname}"
USER="${DEPLOY_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:?Set SSH_KEY to the path of the VM private key}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$USER@$HOST")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

echo "[deploy-web] Uploading landing page and nginx config..."
"${SCP[@]}" "$ROOT/web/index.html" "$USER@$HOST:/tmp/aegislink-web-index.html"
"${SCP[@]}" "$ROOT/web/privacy.html" "$USER@$HOST:/tmp/aegislink-web-privacy.html"
"${SCP[@]}" "$SCRIPT_DIR/nginx/aegislink-web.conf" "$USER@$HOST:/tmp/aegislink-web.conf"

"${SSH[@]}" 'bash -s' <<'ENDSSH'
set -euo pipefail

sudo mkdir -p /var/www/aegislink-web /var/www/certbot
sudo mv /tmp/aegislink-web-index.html /var/www/aegislink-web/index.html
sudo mv /tmp/aegislink-web-privacy.html /var/www/aegislink-web/privacy.html
sudo chown -R www-data:www-data /var/www/aegislink-web /var/www/certbot

if sudo test -f /etc/letsencrypt/live/aegis-link.it/fullchain.pem; then
  echo "[deploy-web] Certificate found — installing full HTTPS config."
  sudo mv /tmp/aegislink-web.conf /etc/nginx/sites-available/aegislink-web
else
  echo "[deploy-web] No certificate yet — installing HTTP-only bootstrap."
  rm /tmp/aegislink-web.conf
  sudo tee /etc/nginx/sites-available/aegislink-web > /dev/null <<'CONF'
# AegisLink landing — HTTP bootstrap (pre-certificate).
# Replaced with infra/nginx/aegislink-web.conf once the cert is issued.
server {
    listen 80;
    server_name aegis-link.it www.aegis-link.it
                aegislink.art www.aegislink.art
                aegislink.shop www.aegislink.shop;

    access_log off;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    root /var/www/aegislink-web;
    index index.html;
    location / { try_files $uri $uri/ =404; }
}
CONF
fi

sudo ln -sf /etc/nginx/sites-available/aegislink-web /etc/nginx/sites-enabled/aegislink-web
sudo nginx -t
sudo systemctl reload nginx
echo "[deploy-web] nginx reloaded."
ENDSSH

echo "[deploy-web] Done."
