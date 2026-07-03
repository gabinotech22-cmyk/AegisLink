# Relay Onion Service — runbook (Fase 4 · mailbox mode)

> Estado: **✅ DESPLEGADO EN PROD (2026-07-03).** Deploy ejecutado por el owner
> vía el wrapper de escritorio: prod en `47c060d`, contenedor `aegislink-tor`
> corriendo, volumen `aegislink_tor_keys` creado. Dirección onion publicada:
>
> `http://fhxnal5jmuuqsbtzz7avos4drhqmuy4c7ffd35gi3hw2uwbe5iqshfyd.onion`
>
> (Fuente canónica de la dirección: `/var/lib/tor/aegislink_relay/hostname`
> dentro del volumen `tor_keys` — ante cualquier duda, leerla de ahí.)
> Este doc es la fuente canónica del estado del onion service del relay
> (los demás docs enlazan, no duplican). Pendiente del checklist: backup de
> clave + verificación por Tor (§checklist 2-3), y el flip de cliente (§4-6).
>
> Código: `infra/tor/` (Dockerfile + torrc), servicio `tor` en
> `docker-compose.yml`, wiring en `infra/deploy.sh`.
> Cliente (ya mergeado): Tor embebido en `mobile/src/net/tor.ts` +
> `mobile/src/socket/mailboxSocket.ts` — ver `docs/FASE4-TOR-EMBEDDED-IMPL.md`.

## Qué es

Un contenedor sidecar (`aegislink-tor`) que publica el relay como **onion
service v3**. Los clientes en mailbox mode llegan al relay por Tor y el relay
nunca ve su IP — cierra el "límite honesto" de correlación IP↔aegisId descrito
en `docs/SEALED-SENDER-ARCHITECTURE.md` §6.

```
móvil (Tor embebido, AegisTor)
  └─ SOCKS local → red Tor (3 saltos cliente)
       └─ rendezvous → tor sidecar (single-onion, 0 saltos extra)
            └─ relay:3001  (red docker aegis_internal, sin TLS: Tor ya cifra)
```

- **Puerto virtual 80 → relay:3001**: la URL de cliente es `http://<addr>.onion`
  (sin puerto). El guard https de `mobile/src/config.ts` exime `.onion`.
- **Single Onion Service** (`HiddenServiceSingleHopMode 1`): la ubicación del
  servidor ya es pública (clearnet en duckdns), así que se eliminan los 3 saltos
  del lado servidor → ~mitad de latencia. El anonimato del CLIENTE (3 saltos) no
  se toca.
- **Aditivo**: el path clearnet nginx/TLS sigue intacto. Si tor cae, solo cae el
  path onion; el cliente es fail-closed y degrada a transporte aegisId.

## Deploy (Hetzner, /opt/aegislink)

El deploy normal ya lo hace todo — `infra/deploy.sh` construye/levanta `tor`
después de que el relay esté sano y **imprime la dirección .onion**:

```bash
ssh -i <clave aegislink_hetzner> root@<hetzner> \
  'cd /opt/aegislink && bash infra/deploy.sh'
# ...
# [deploy] Relay onion service: http://<56 chars>.onion
```

Para leerla en cualquier momento:

```bash
docker compose exec -T tor cat /var/lib/tor/aegislink_relay/hostname
```

Requisito de red: salida (outbound) a la red Tor — puertos 443/9001 abiertos
hacia fuera, que en Hetzner por defecto lo están. **No se publica ningún puerto
nuevo de entrada.**

## Backup de la clave onion (CRÍTICO)

La identidad `.onion` es la clave ed25519 en el volumen `tor_keys`
(`/var/lib/tor/aegislink_relay/`). **Perderla = rota la dirección .onion** y
todos los builds de cliente con `EXPO_PUBLIC_ONION_URL` quedan huérfanos.

```bash
docker run --rm -v aegislink_tor_keys:/keys -v /root/backups:/out alpine \
  tar czf /out/tor_keys-$(date +%F).tar.gz -C /keys .
```

Guardar junto al backup de la DB del relay, con el mismo cuidado que una clave
privada.

## Checklist para encender mailbox mode (en orden)

1. ✅ Deploy del onion service en prod — HECHO 2026-07-03 (prod `47c060d`,
   dirección arriba; deploy vía wrapper del owner, sección Tor añadida al
   wrapper el mismo día).
2. ☐ Backup de `tor_keys` (arriba).
3. ☐ Probar reachability desde un cliente Tor cualquiera:
   `curl --socks5-hostname 127.0.0.1:9050 http://<addr>.onion/health` → `"ok"`.
4. ☐ En EAS (o `.env.production`): `EXPO_PUBLIC_ONION_URL=http://<addr>.onion`
   y `EXPO_PUBLIC_MAILBOX_MODE=on`. Sin la URL, `MAILBOX_ENABLED` queda `false`
   (fail-closed por diseño, `mobile/src/config.ts`).
5. ☐ Build **nativo** del APK (el módulo `AegisTor` no existe en Expo Go).
6. ☐ Validación 2 dispositivos reales, ambos en mailbox mode, roots
   intercambiados (mensajes en ambos sentidos + receipts sellados de #229).

## Consideraciones conocidas

- **Rate limits HTTP por IP**: todo el tráfico onion llega al relay desde la IP
  del contenedor tor. Los eventos de socket ya se limitan por `aegisId`/socket
  (`server/src/relay/rateLimits.ts`) — sin impacto. Pero cualquier limiter
  HTTP keyed por IP (express-rate-limit tras `trust proxy`) metería a TODOS los
  usuarios Tor en un solo bucket. Revisar los buckets de rutas HTTP
  (blob/prekeys/turn) antes de mandar tráfico HTTP masivo por onion; hoy el
  path mailbox es solo socket.
- **Restart de tor en cada deploy**: tor resuelve `relay` al arrancar; si el
  contenedor relay se recrea con otra IP, tor quedaría marcando la vieja. Por
  eso `deploy.sh` reinicia tor DESPUÉS del health check del relay. Corte del
  path onion durante el deploy: segundos (la clave persiste, la dirección no
  cambia).
- **Logs**: torrc fija `Log notice stdout` — tor no loguea datos por conexión a
  ese nivel, y por diseño no puede ver IPs de clientes onion. Rotación 10 MB × 3
  como el resto de servicios.
