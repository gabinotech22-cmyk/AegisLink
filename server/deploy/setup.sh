#!/bin/bash
# AegisLink Relay — Setup completo en VPS Ubuntu 24.04
# Uso: bash setup.sh
# Ejecutar como root en el servidor

set -e

echo "=== AegisLink Relay Setup ==="

# ── 1. Sistema base ────────────────────────────────────────────────────────────
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq curl git ufw nginx certbot python3-certbot-nginx

# ── 2. Node.js 22 ─────────────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version

# ── 3. PM2 ────────────────────────────────────────────────────────────────────
npm install -g pm2
pm2 startup systemd -u root --hp /root | bash || true

# ── 4. Usuario de aplicación ───────────────────────────────────────────────────
id -u aegis &>/dev/null || useradd -m -s /bin/bash aegis
mkdir -p /home/aegis/app
chown aegis:aegis /home/aegis/app

# ── 5. Firewall ────────────────────────────────────────────────────────────────
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP  (certbot)
ufw allow 443/tcp   # HTTPS (relay WSS)
ufw allow 3001/tcp  # relay directo (temporal, cerrar tras configurar nginx)
ufw --force enable
echo "Firewall OK"

# ── 6. Nginx reverse proxy ─────────────────────────────────────────────────────
cat > /etc/nginx/sites-available/aegislink << 'NGINX'
server {
    listen 80;
    server_name _;          # cambia a tu dominio cuando lo tengas

    # WebSocket relay
    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/aegislink /etc/nginx/sites-enabled/aegislink
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "Nginx OK"

# ── 7. Directorio de datos ─────────────────────────────────────────────────────
mkdir -p /home/aegis/app/data
chown -R aegis:aegis /home/aegis/app

echo ""
echo "✓ Sistema listo. Ahora sube el código del servidor con:"
echo "  bash deploy.sh TU_IP_DEL_SERVIDOR"
