# coturn en VM dedicada — runbook (Etapa 1 del roadmap de infra)

> Estado: **🟡 CÓDIGO LISTO, VM PENDIENTE DE APROVISIONAR.**
> El repo ya está partido (compose propio, deploy propio, watchdog por-VM), pero
> la VM de llamadas **todavía no sirve tráfico**: coturn sigue corriendo en la VM
> del relay. Este doc pasa a ✅ cuando el paso 7 (verificación con llamada real)
> esté hecho, con su evidencia al lado.
>
> Este doc es la fuente canónica de la *operación* de la VM de llamadas.
> `docs/INFRA-HA-SCALING-ROADMAP-2026-07.md` (Etapa 1) enlaza aquí y no duplica.

## Por qué

Call media es a ráfagas y pesado en ancho de banda (UDP 49152-65535, sin cap de
bps). Compartiendo caja con el relay, un pico de llamadas degrada el **path de
chat** — que es justo el que lleva el onion de Tor y la entrega mailbox. Separar
significa que un pico en llamadas nunca puede tumbar la mensajería.

**Lo que esto NO hace:** coturn sigue viendo las IPs reales de ambos peers en
llamadas relayed — es su función, esté en la caja que esté. Mover el contenedor
mejora aislamiento y recursos, **no** añade anonimato. El único lever que evita
esa exposición es enrutar la señalización/media por Tor, con su coste de
latencia; no está hecho ni planificado aquí.

## Topología

| VM | IP | Rol | Compose |
|---|---|---|---|
| relay | `157.180.116.176` (hel1) | relay + tor + ntfy + nginx | `docker-compose.yml` |
| calls | `138.199.203.109` (nbg1) | coturn | `infra/coturn/docker-compose.coturn.yml` |

`aegislink.duckdns.org` → **sigue apuntando a la VM del relay** y no se toca.
El onion y el volumen `tor_keys` viven en la VM del relay y **no se mueven** →
la dirección `.onion` no rota y ningún build de cliente queda huérfano.

Nota de latencia: Núremberg es más central en Europa que Helsinki, así que para
usuarios en España el relay de media queda **más cerca**, no más lejos.

## El secreto compartido (la trampa nº 1)

`TURN_SECRET` pasa a ser un secreto **compartido entre dos máquinas**:

- El relay lo usa para **firmar** credenciales efímeras (`server/src/routes/turn.ts`,
  `HMAC-SHA1(TURN_SECRET, "<expiry>:<aegisId>")`).
- coturn lo usa para **verificar** ese HMAC (`use-auth-secret`).

Si no coinciden byte a byte, **toda llamada relayed falla con 401**.

Propiedad útil para el cutover: la credencial **no depende del host** — solo del
secreto. Una credencial ya emitida contra el host viejo es válida contra el
nuevo. Por eso el cambio de host es transparente para el cliente.

Verificado 2026-08-01: **no hay cron de rotación** en la VM del relay; el secreto
es estático hoy. El one-liner de rotación que sugería `infra/deploy.sh` ya está
marcado como no-seguro: rotar en un solo lado rompe las llamadas.

## Requisitos previos (acción del dueño)

1. **Clave SSH en la VM nueva.** Hoy solo tiene login root por contraseña. Usar
   el `.bat` de escritorio (`aegis-coturn-ssh-key.bat`) que ejecuta `ssh-copy-id`;
   la contraseña la teclea el dueño, no queda en ningún log ni en el repo.
2. **Rotar la contraseña root** de la VM nueva y desactivar login por contraseña
   (la contraseña inicial viajó por email en claro).
3. **Firewall** (Hetzner Cloud Firewall si está activo, + iptables):
   `UDP 3478`, `TCP 3478`, `UDP 49152-65535`. SSH 22 restringido.
   *No* hace falta abrir 5349 mientras no haya TLS (ver abajo).

## TLS / TURNS — deliberadamente apagado

Producción **no usa TURNS hoy**: `TURNS_PORT` está vacío en el env del relay y
coturn no tiene ningún listener en 5349 (verificado con `ss` el 2026-08-01),
pese a que el config declaraba `cert`/`pkey`. Es decir: el config *afirmaba* TLS
y coturn fallaba en silencio al abrirlo.

Por eso el template ya no declara TLS incondicionalmente. `deploy-coturn.sh`
añade el bloque **solo si el cert es legible de verdad**. Para activarlo después:
certbot en la VM de llamadas para un hostname propio, `TURN_TLS_DOMAIN=<host>`,
y `TURNS_PORT=5349` en el env del relay. Sin migración adicional.

Mientras tanto `TURN_HOST` puede ser la **IP pelada** — TURN/STUN en claro no
valida hostname. Pasar a hostname más adelante es un cambio de env en el relay,
sin rebuild de la app.

## El cutover (sin caída de llamadas)

**Orden deliberado: las dos coturn corren en paralelo durante la transición.**
Nunca se apaga la vieja antes de validar la nueva.

1. VM nueva: docker + clonar repo en `/opt/aegislink`.
2. Escribir `/etc/aegislink-coturn.env` (chmod 600) con el **mismo** `TURN_SECRET`
   que `/etc/aegislink.env` del relay.
3. Desplegar: `set -a; . /etc/aegislink-coturn.env; set +a; bash /opt/aegislink/infra/coturn/deploy-coturn.sh`
4. Verificar coturn en la caja nueva **antes de tocar el relay** (ver abajo).
5. En el relay: `TURN_HOST=138.199.203.109` en `/etc/aegislink.env` → reiniciar relay.
6. **Esperar ≥ 1 hora** antes de apagar la coturn vieja. Motivo: el cliente
   cachea la config TURN **50 minutos** (`CACHE_TTL_MS`, `mobile/src/webrtc/ice.ts`)
   y las credenciales viven 1 h. Apagar antes corta llamadas de apps ya abiertas.
7. Llamada real de prueba entre 2 dispositivos → confirmar que el candidato relay
   es `138.199.203.109`.
8. Solo entonces, en la VM del relay: `docker rm -f aegislink-coturn` y
   `rm -f /etc/coturn/turnserver.conf`.
9. Watchdog: en el relay ya no vigila coturn (por defecto). En la VM de llamadas,
   instalar el watchdog con `/etc/aegislink-watchdog.conf`:
   ```
   AEGIS_WATCH_CONTAINERS="aegislink-coturn"
   AEGIS_WATCH_RELAY_HEALTH=0
   NTFY_LOCAL="https://aegislink.duckdns.org:8443"
   ```

## Verificación

En la VM de llamadas:

```bash
docker inspect -f '{{.State.Running}}' aegislink-coturn
ss -lnu | grep 3478
```

Desde fuera (asignación TURN real, requiere `coturn` client tools). El username
es `<expiry_unix>:<aegisId>` y la password `HMAC-SHA1(TURN_SECRET, username)`
en base64 — genérala con `infra/scripts/rotate-turn-creds.ts`:

```bash
turnutils_uclient -v -t -u '<username>' -w '<credential>' 138.199.203.109
```

En el relay, que la config servida ya apunte a la caja nueva:

```bash
curl -s 'https://aegislink.duckdns.org/turn/credentials?aegisId=...&sig=...&ts=...' | jq .urls
```

## Rollback

Un solo paso, porque la coturn vieja sigue viva hasta el paso 8:
`TURN_HOST=aegislink.duckdns.org` en `/etc/aegislink.env` del relay → reiniciar
relay. Efecto en ≤ 50 min (cache del cliente) o inmediato en apps recién abiertas.

## Deuda conocida que esto NO arregla

- **Un solo coturn = cero llamadas relayed si cae.** La redundancia es la Etapa 5
  del roadmap (`/turn` sirviendo N hosts con health-check). Separar la VM es el
  prerrequisito, no la solución.
- `infra/open-aws-ports.sh` sigue siendo específico de AWS/EC2 (región
  `eu-north-1`, IP `51.20.60.155`) y ya no describe esta infra en Hetzner. No se
  usa en el deploy; queda obsoleto y debería borrarse o reescribirse.
