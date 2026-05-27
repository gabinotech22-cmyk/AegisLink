# AegisLink — Desarrollo Local

## Requisitos
- Node.js 22+
- Android Studio / Xcode (para mobile)
- Electron (para desktop, ya incluido en dependencias)

## Setup inicial
```bash
cp .env.example .env
# Edita .env con tus valores

# Instalar dependencias
cd server && npm install
cd ../mobile && npm install
cd ../desktop && npm install
```

## Levantar el stack

### 1. Server (siempre primero)
```bash
cd server && npm run dev
# Escucha en http://localhost:3001
# Verifica: GET http://localhost:3001/health → { "ok": true }
```

### 2. Desktop
```bash
cd desktop && npm run dev
# VITE_RELAY_URL debe apuntar a http://localhost:3001
```

### 3. Mobile (Android emulator)
```bash
cd mobile && npx expo start
# EXPO_PUBLIC_SERVER_URL=http://10.0.2.2:3001 (Android emulator)
# EXPO_PUBLIC_SERVER_URL=http://localhost:3001 (iOS simulator)
```

## URLs por entorno

| App | Dev (Android emu) | Dev (iOS sim / Desktop) | Producción |
|-----|-------------------|------------------------|------------|
| Mobile | http://10.0.2.2:3001 | http://localhost:3001 | https://aegislink.duckdns.org |
| Desktop | http://localhost:3001 | http://localhost:3001 | https://aegislink.duckdns.org |

## Variables de entorno por cliente

| Variable | Cliente | Descripción |
|----------|---------|-------------|
| `EXPO_PUBLIC_SERVER_URL` | Mobile | URL del relay para Expo/React Native |
| `EXPO_PUBLIC_RELAY_URL` | Mobile | Alias opcional; hereda SERVER_URL si no se define |
| `EXPO_PUBLIC_ORACLE_IP` | Mobile | IP pública Oracle VM (producción alternativa) |
| `EXPO_PUBLIC_RELAY_PORT` | Mobile | Puerto del relay en Oracle VM (default: 3001) |
| `EXPO_PUBLIC_TURN_URL` | Mobile | Servidor TURN/STUN para llamadas WebRTC |
| `EXPO_PUBLIC_ONION_URL` | Mobile | Dirección .onion opcional (modo Tor) |
| `VITE_RELAY_URL` | Desktop | URL del relay para Vite/Electron renderer |
| `VITE_TURN_URL` | Desktop | Servidor TURN/STUN para llamadas WebRTC |
| `PORT` | Server | Puerto en que escucha el relay (default: 3001) |
| `CORS_ORIGIN` | Server | Orígenes CORS permitidos (default: *; en prod: tu dominio) |
| `TURN_SECRET` | Server | Secreto HMAC-SHA1 para credenciales TURN efímeras |
| `TRUST_PROXY` | Server | Número de hops de proxy de confianza (default: 1) |
| `DATABASE_URL` | Server | Ruta SQLite o cadena de conexión PostgreSQL |

## Verificar conexión
Abre http://localhost:3001/health — debe responder `{ "ok": true }`.

## Notas de privacidad
- El servidor descarta IPs de clientes en middleware; no loguear en producción con `CORS_ORIGIN=*`.
- `TURN_SECRET` debe generarse con `openssl rand -hex 32` y rotarse cada 24h.
- Nunca comitear `.env` con valores reales; solo `.env.example` va al repositorio.

## Deploy a producción (Oracle Cloud)

### Arquitectura
```
Mobile / Desktop
     │ HTTPS 443
     ▼
  nginx (TLS termination)
     │ HTTP 127.0.0.1:3001
     ▼
  Node.js relay (PM2)
```
El relay corre en HTTP puro — nginx es quien termina TLS. Si nginx no corre, la app recibe "network request failed".

### Pasos de deploy

1. **SSH al servidor Oracle**
   ```bash
   ssh root@<IP_ORACLE>
   ```

2. **Verificar nginx**
   ```bash
   sudo systemctl status nginx
   sudo nginx -t          # verificar config
   ```
   Si no corre: `sudo systemctl start nginx`

3. **Verificar certificado Let's Encrypt**
   ```bash
   sudo certbot certificates
   ```
   Si falta o expiró: `sudo bash /opt/aegislink/infra/ssl/setup-ssl.sh`

4. **Deploy del relay**
   ```bash
   # Desde tu máquina local:
   bash server/deploy/deploy.sh <IP_ORACLE>
   ```

5. **Verificar desde tu máquina local**
   ```bash
   bash infra/check-server.sh
   # O manualmente:
   curl https://aegislink.duckdns.org/health
   ```
   Debe responder `{ "ok": true }`.

### Variables de entorno en la VM

El archivo `/opt/aegislink/app/.env` en la VM debe contener:
```env
PORT=3001
NODE_ENV=production
# Restringir CORS en producción (no usar * en prod)
CORS_ORIGIN=https://aegislink.duckdns.org
TRUST_PROXY=1
TURN_SECRET=<genera con: openssl rand -hex 32>
```

### Troubleshooting "network request failed"

| Síntoma | Causa probable | Solución |
|---------|---------------|---------|
| `network request failed` en mobile | nginx no corre | `sudo systemctl start nginx` |
| `network request failed` en mobile | Certificado SSL vencido | `sudo certbot renew --force-renewal` |
| `502 Bad Gateway` | relay (Node.js) no corre | `pm2 restart aegislink-relay` |
| `CORS blocked` en Electron/web | `CORS_ORIGIN` no incluye el origen | Añadir origen a `CORS_ORIGIN` en `.env` |
| Socket.IO no conecta | nginx sin bloque `/socket.io/` | Verificar `infra/nginx/aegislink.conf` |
