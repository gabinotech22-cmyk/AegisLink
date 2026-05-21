#!/bin/bash
# AegisLink — Añadir SSL con Let's Encrypt (ejecutar en el VPS cuando tengas dominio)
# Uso: bash add-ssl.sh tu-dominio.com

set -e
DOMAIN="${1:?Uso: bash add-ssl.sh tu-dominio.com}"

# Obtener certificado
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}"

# Actualizar nginx para WSS
cat > /etc/nginx/sites-available/aegislink << NGINX
server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       \$host;
        proxy_set_header   X-Real-IP  \$remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}
NGINX

nginx -t && systemctl reload nginx

# Cerrar puerto 3001 directo (ya no necesario)
ufw delete allow 3001/tcp 2>/dev/null || true

echo ""
echo "✓ SSL activo en https://${DOMAIN}"
echo ""
echo "Actualiza la URL en la app:"
echo "  VITE_RELAY_URL=https://${DOMAIN}"
echo "  EXPO_PUBLIC_RELAY_URL=https://${DOMAIN}"
