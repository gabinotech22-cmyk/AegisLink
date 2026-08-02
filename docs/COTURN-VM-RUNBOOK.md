# coturn en VM dedicada — runbook (Etapa 1 del roadmap de infra)

> Estado: **🟡 CUTOVER HECHO — FALTA VALIDAR CON LLAMADA REAL.**
> (2026-08-02) La calls VM corre coturn con el config **efectivamente cargado**,
> autenticación **comprobada en ambos sentidos** (credencial válida pasa;
> credencial falsa da `Cannot complete Allocation`), y firewall `ufw` activo
> (`deny incoming`, solo 22/tcp, 3478 tcp+udp y 49152-65535/udp; logging
> **apagado** — registraba IPs de origen). El relay ya anuncia
> `TURN_HOST=138.199.203.109` y responde `/health: OK`.
>
> Las **dos** coturn siguen vivas a propósito durante la transición. Pasa a ✅
> cuando (a) una llamada real entre dos dispositivos conecte contra la VM
> separada y (b) el coturn viejo esté decomisionado (paso 8).
>
> **Cerrado el 2026-08-02**: el coturn de la VM del relay corría **abierto**
> (config ilegible → defaults → sin auth). Resuelto con `chown 65534` + restart;
> verificado con `LEE-SU-CONFIG: SI`. Ver "trampa nº 0" — la causa raíz está
> arreglada en `deploy-coturn.sh`, que ahora aborta el deploy si se repite.
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

## ⚠️ La trampa nº 0 — el config que coturn no puede leer

**Encontrado el 2026-08-02 desplegando esta VM, y estaba VIVO en producción.**

El contenedor `coturn/coturn` ejecuta el demonio como **`nobody` (uid 65534)**,
no como root. `infra/deploy.sh` escribía el config renderizado como
`root:root` modo `640`. Resultado: **el demonio no puede leer su propio
config** — y coturn **no falla ruidosamente**: cae a sus **valores por defecto**
y sigue sirviendo tráfico como si nada.

Con defaults, TODO lo que este archivo promete deja de existir:

| Directiva | Qué se perdió |
|---|---|
| `use-auth-secret` | **TURN abierto**: se aceptan allocations con credenciales inventadas. Deja sin sentido la auth Ed25519 de `/turn/credentials` (ítem A-7 de la auditoría 2026-06). |
| `denied-peer-ip` | La lista anti-SSRF nunca se aplicó (metadata endpoint incluido). |
| `external-ip` | Candidatos ICE incorrectos. |
| `total-quota` | Sin límite de sesiones. |
| `tls-listening-port` | Explica por qué el listener 5349 nunca existió pese a estar declarado. |

Prueba read-only que lo demuestra:

```bash
stat -c "%U:%G %a" /etc/coturn/turnserver.conf   # root:root 640
docker exec aegislink-coturn id -un              # nobody   -> no puede leerlo
```

`deploy-coturn.sh` ahora (a) hace `chown 65534` al renderizar y (b) **falla el
deploy** si el usuario del demonio no puede leer el archivo. Un deploy que
"funciona" mientras coturn corre abierto es peor que un deploy que revienta.

### Corolario: los logs de coturn van a ninguna parte

El config fija `no-stdout-log` + `syslog` (por privacidad). Dentro de un
contenedor **no hay syslog**, así que `docker logs aegislink-coturn` sale
**vacío** y esta clase de fallo es invisible. Para diagnosticar sin tocar el
servicio en marcha, arranca una copia en otro puerto con los logs visibles:

```bash
grep -vE "^(no-stdout-log|syslog|listening-port)" /etc/coturn/turnserver.conf > /tmp/diag.conf
echo "listening-port=13478" >> /tmp/diag.conf
chown 65534:65534 /tmp/diag.conf
timeout 12 docker run --rm --network host -v /tmp/diag.conf:/tmp/diag.conf:ro \
  coturn/coturn:latest -c /tmp/diag.conf
```

Ahí se ve qué carga de verdad: `Default realm:`, las líneas `Black listing:` y
—crucialmente— cualquier `Bad configuration format:` (directiva **descartada en
silencio**, que es exactamente como se coló `no-loopback-peers`).

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

## Acceso a la VM — cómo se resolvió (✅ 2026-08-02)

Documentado porque el camino "obvio" **no funciona** y costó varios intentos.

1. **Añadir la clave SSH a la cuenta Hetzner NO la instala en servidores que ya
   existen.** El propio diálogo lo dice en letra pequeña ("does not affect any
   existing resources"). Solo aplica a servidores creados *después*.
2. **La vía que sí funciona sin tocar una terminal: modo Rescue.** Servidor →
   pestaña *Rescue* → *Enable rescue & power cycle*, seleccionando la clave SSH.
   Arranca un sistema de rescate **con la clave ya autorizada**; desde ahí se
   monta el disco real (`mount /dev/sda1 /mnt/real`) y se instala la clave en
   `/root/.ssh/authorized_keys`. El rescate es de **un solo arranque**: se
   consume al reiniciar, así que hay que reactivarlo si hace falta otra vez.
3. **Ubuntu llega con la contraseña root CADUCADA.** Bloquea la sesión *aunque
   la clave sea válida* (`Password change required but no TTY available`). Se
   quita desde el rescate: `chroot /mnt/real chage -d <hoy> root`.
4. ✅ **Solo clave SSH** (`10-aegislink-hardening.conf`): `PasswordAuthentication
   no` + `PermitRootLogin prohibit-password`. Verificado en ambos sentidos: la
   clave entra, y la contraseña da `Permission denied (publickey)`.
   > El prefijo **`10-`** es deliberado: OpenSSH se queda con el **primer** valor
   > de cada opción, y `50-cloud-init.conf` trae `PasswordAuthentication yes`.
   > Un archivo `99-` se leería después y **perdería en silencio**.
5. ✅ **Firewall** `ufw`: `deny incoming` por defecto; abiertos 22/tcp,
   3478 tcp+udp y 49152-65535/udp. **Logging apagado** — venía en `on (low)`,
   que persiste IPs de origen de los paquetes bloqueados (cero-metadatos).
   No hace falta 5349 mientras no haya TLS (ver abajo).

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

**La prueba que de verdad importa: que una credencial FALSA sea rechazada.**
Un allocation exitoso con credencial válida no demuestra nada por sí solo — el
coturn abierto de producción también lo daba. Hay que ver las dos caras.

Lánzalo **desde otra máquina** (p. ej. la VM del relay, que tiene el secreto):

```bash
SECRET=$(grep "^TURN_SECRET=" /etc/aegislink.env | cut -d= -f2-)
U=$(( $(date +%s) + 3600 )):smoketest
P=$(printf "%s" "$U" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)

# Debe PASAR el allocation:
docker run --rm coturn/coturn:latest turnutils_uclient -y -u "$U" -w "$P" -p 3478 138.199.203.109

# Debe FALLAR con "Cannot complete Allocation":
docker run --rm coturn/coturn:latest turnutils_uclient -y -u "$U" -w "inventada" -p 3478 138.199.203.109
```

> **Cuidado con la sintaxis**: la IP va **al final** y con `-p 3478`. Con otras
> combinaciones de flags `turnutils_uclient` ignora la dirección y se conecta a
> `0.0.0.0:3478` (el coturn LOCAL), dando resultados que parecen del servidor
> remoto pero no lo son. Comprueba siempre la línea `Connected to:` de la salida.

Un `channel bind: error 403` **después** de un allocation correcto es normal en
modo `-y`: la dirección de relay cae en un rango de `denied-peer-ip` (p. ej. el
bridge de docker `172.17.x`). No afecta a llamadas reales, cuyos peers son IPs
públicas.

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
