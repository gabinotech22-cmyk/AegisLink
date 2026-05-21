#!/usr/bin/env bash
# infra/ssl/renew-ssl.sh — Automatic Let's Encrypt renewal for AegisLink
#
# Install as a root cron job on the VM (run once to add):
#   sudo crontab -e
#   Add the following line:
#   0 3 * * * /opt/aegislink/infra/ssl/renew-ssl.sh >> /var/log/aegislink-ssl-renew.log 2>&1
#
# Or let setup-ssl.sh install it automatically.
#
# certbot renew is idempotent: it skips certificates that are not yet due
# for renewal (< 30 days from expiry). Running this daily is safe.

set -euo pipefail

echo "[renew-ssl] $(date -u +"%Y-%m-%dT%H:%M:%SZ") — starting renewal check..."

certbot renew --quiet --no-random-sleep-on-renew

# Reload nginx only if it is running (graceful — zero downtime)
if systemctl is-active --quiet nginx; then
  nginx -s reload
  echo "[renew-ssl] nginx reloaded."
else
  echo "[renew-ssl] WARNING: nginx is not active — skipping reload."
fi

echo "[renew-ssl] Done."
