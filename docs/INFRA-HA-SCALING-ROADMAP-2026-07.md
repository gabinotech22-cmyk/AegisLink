# Infra — hoja de ruta hacia alta disponibilidad (1 VM → N VMs)

> Estado: **Etapa 1 🟡 EN CURSO** (código partido y mergeado; VM de llamadas
> comprada pero aún sin servir tráfico — ver `docs/COTURN-VM-RUNBOOK.md`).
> Etapas 0 y 2-5: planificadas, nada ejecutado. Este doc es la fuente
> canónica de la *topología de VMs* (cuántas, para qué, en qué orden). No
> duplica `docs/RELAY-HORIZONTAL-SCALING.md` (que sigue siendo la fuente
> canónica de la *mecánica de código* — PM2 cluster, adapters de Socket.IO)
> ni el ítem A-1 de `docs/SECURITY-ROADMAP-2026-06.md` (por qué Redis se
> diferió). Este doc enlaza a ambos en vez de repetir su contenido.

## Por qué existe este doc

Hoy AegisLink corre en **1 VM Hetzner (2 vCPU, ~6,70€/mes)**: relay Socket.IO
en modo fork mono-proceso, SQLite+WAL, rate-limit en memoria, y coturn (TURN)
en la misma caja compitiendo por CPU/ancho de banda con el relay. Nada de esto
se ha probado bajo carga real — no hay cifras medidas de cuántos usuarios o
llamadas simultáneas soporta hoy.

El objetivo del producto para esta fase es **redundancia/uptime**: que si una
VM muere, el servicio siga funcionando. Presupuesto disponible: ~30-60€/mes.

**Esto decide la pregunta de fondo** ("¿VMs iguales o ir agrandando una
sola?"): escalado vertical (agrandar una única VM) *nunca* da alta
disponibilidad — sigue siendo un único punto de fallo sin importar su tamaño.
Solo el camino horizontal (N VMs) cumple el objetivo real. Pero **hoy es
arquitectónicamente imposible saltar directo a "3 VMs iguales"**: SQLite es
un archivo de un solo escritor (no se puede compartir entre VMs), el
rate-limit vive en memoria de un solo proceso, y el load balancer no tiene
sticky sessions. Hace falta construir una base primero — este doc es esa
secuencia.

## Inventario de lo que ya existe en código (verificado leyendo los archivos, no asumido)

| Pieza | Archivo | Qué hace | Estado real |
|---|---|---|---|
| Multi-worker mismo-VM con sticky sessions | `server/src/clusterMaster.ts` + `server/src/relay/socketIoClusterAdapter.ts` (`@socket.io/sticky` + `@socket.io/cluster-adapter`) | N workers en 1 VM, broadcast cross-worker por IPC, sin Redis | Código listo, `server/ecosystem.config.cjs` también listo (`pm2 start ecosystem.config.cjs`), **no wireado en `infra/deploy.sh`** (sigue con `pm2 start npm -- start`, un solo proceso) |
| Rate-limit distribuido + adapter Socket.IO multi-VM | `server/src/relay/rateLimits.ts`, `redisClient.ts`, `server/src/relay/socketIoRedisAdapter.ts` | Se activa solo con `REDIS_URL` seteada; cubre tanto el caso multi-VM como el mismo-VM | Código listo, test unitario con cliente ioredis-fake (`socketIoRedisAdapter.test.ts`), **nunca probado contra Redis real ni contra 2 VMs reales** |
| DB Postgres | `server/src/db/driver.ts` + `server/src/db/pg.ts` | Dispatch limpio por `DATABASE_URL` (`postgres://`/`postgresql://`), incluye `FOR UPDATE SKIP LOCKED` para el pop de OPKs | Código maduro, **sin ningún test que ejercite el path Postgres en CI** |
| nginx upstream | `infra/nginx/aegislink.conf` | Hoy: `upstream aegis_relay { server 127.0.0.1:3001; }` — un solo backend | Bloque sticky multi-backend (`hash $arg_sid consistent;`) ya documentado en `docs/RELAY-HORIZONTAL-SCALING.md`, **no implementado** en el archivo real |
| TURN | `infra/coturn/turnserver.conf` + `routes/turn.ts` | `total-quota=200`, `bps-capacity=0` (sin cap), un solo host | Sin redundancia — un coturn caído = cero llamadas relayed |

## Recomendación

Horizontal es la meta correcta dado el objetivo de HA, ejecutado en 5 etapas
— cada una barata, reversible, y valida en producción real la pieza siguiente
antes de depender de ella. **coturn no se escala igual que el relay** (es
stateful por sesión UDP, no reparte con round-robin HTTP) — tiene su propio
mecanismo de redundancia, ver Etapa 5.

### Etapa 0 — Activar multi-worker en la VM actual (gratis)

No da HA (sigue siendo 1 VM), pero valida el código de sticky-sessions antes
de apostar la arquitectura de HA sobre él, y da resiliencia a que un worker
individual crashee.

- `infra/deploy.sh`: `pm2 start npm --name aegislink-relay -- start` →
  `pm2 start ecosystem.config.cjs` (borrar el proceso PM2 viejo primero).
- Verificar en la VM real: 2 workers arriba (`pm2 list`), reconexión de un
  cliente tras matar un worker, logs confirmando
  `[aegislink-cluster-master] routing ...` y que NO aparece fallback a Redis
  (no debe haber `REDIS_URL` seteada todavía).
- Riesgo: bajo, reversible con `pm2 delete` + volver al comando anterior.

### Etapa 1 — Separar coturn a su propia VM pequeña (~+4-5€/mes) — 🟡 EN CURSO

Mejora con más impacto por euro: aísla el tráfico impredecible de llamadas
(UDP, ancho de banda variable) de la disponibilidad del chat. Prerrequisito
para la redundancia de llamadas de la Etapa 5.

**Runbook operativo completo: `docs/COTURN-VM-RUNBOOK.md`** (fuente canónica
del cutover, verificación y rollback — no se duplica aquí).

- ✅ **Código partido** (rama `feat/coturn-separate-vm`): `coturn` fuera de
  `docker-compose.yml`, compose propio en `infra/coturn/docker-compose.coturn.yml`,
  deploy propio `infra/coturn/deploy-coturn.sh`, `infra/deploy.sh` ya no gestiona
  coturn, `infra/vm-watchdog.sh` parametrizado por VM.
- ✅ **VM aprovisionada** (2026-08-02): `138.199.203.109` (nbg1, CX23, Ubuntu
  26.04), docker + compose instalados, `TURN_SECRET` sincronizado con el relay
  (huellas sha256 idénticas), coturn corriendo y **autenticación verificada en
  ambos sentidos** (credencial falsa → `Cannot complete Allocation`).
- ☐ Flip de `TURN_HOST` en el `.env` del relay.
- ☐ Verificar: llamada de prueba forzando TURN (bloqueando P2P) conecta contra
  la VM separada.
- ☐ Decomisionar el coturn de la VM del relay (≥1 h después del flip).

> **Hallazgo de seguridad al desplegar esta etapa (VIVO en producción).**
> El contenedor coturn corre como `nobody`, pero el deploy escribía el config
> como `root:root 640` → **el demonio nunca pudo leerlo** y llevaba meses
> corriendo con **valores por defecto**: sin `use-auth-secret` (TURN abierto,
> acepta credenciales inventadas — deja sin efecto el ítem A-7 de la auditoría
> 2026-06), sin `denied-peer-ip` (anti-SSRF), sin `external-ip`, sin quotas.
> También explica por qué el listener TLS 5349 nunca existió. Detalle,
> reproducción y arreglo: `docs/COTURN-VM-RUNBOOK.md` § "trampa nº 0".
>
> Segundo hallazgo: `no-loopback-peers` es **rechazado** por coturn 4.16
> ("Bad configuration format") — una directiva descartada en silencio se ve
> igual que una que funciona. Sustituida por `denied-peer-ip=127.0.0.0-...`.
>
> Tercero: **no existe cron de rotación** de `TURN_SECRET`. Bien, porque al
> partir en dos VMs ese secreto pasa a ser compartido y rotarlo en un solo lado
> rompe todas las llamadas.

### Etapa 2 — Load testing (antes de gastar más)

No existe tooling de carga en el repo hoy (`server/package.json` no tiene
k6/artillery). Sin esto, cualquier tamaño elegido después es una adivinanza.

- Script de carga (k6 o artillery): N conexiones Socket.IO concurrentes con
  mensajería periódica, y por separado M sesiones TURN contra la VM de la
  Etapa 1.
- Correr contra la VM real (fuera de horario pico), medir CPU/RAM/escrituras
  SQLite por segundo antes de degradar, y el punto de saturación de ancho de
  banda de coturn.
- Output: un número real de "usuarios simultáneos soportados hoy", para
  reemplazar cualquier estimación no medida.

### Etapa 3 — Construir la base para multi-VM

Sin esto, horizontal no funciona ni con Redis activado — SQLite no se puede
compartir entre procesos en VMs distintas.

1. **Postgres**: VM pequeña dedicada, self-hosted (no managed de terceros —
   consistente con "sin Firebase, sin Supabase" y con minimización de
   metadatos). Migrar `DATABASE_URL` en staging primero. **Antes de confiar
   en el path Postgres en prod, cerrar la brecha de test** — `server/src/db/pg.ts`
   no tiene cobertura dedicada hoy.
2. **Redis**: en la VM de Postgres o una propia, con `maxmemory` +
   `maxmemory-policy noeviction` (perder una clave de rate-limit no es
   grave; un OOM del proceso relay sí — ver A-1 en
   `docs/SECURITY-ROADMAP-2026-06.md`). Confirmar en logs que se activan
   **ambas** cosas a la vez (rate-limit distribuido + adapter Socket.IO).
3. **nginx sticky multi-backend**: implementar el bloque ya documentado en
   `docs/RELAY-HORIZONTAL-SCALING.md` (`hash $arg_sid consistent;` con N
   `server` entries) en `infra/nginx/aegislink.conf`.
4. **HA del propio load balancer** — decisión pendiente de confirmar con el
   usuario antes de aprovisionar:
   - (a) Hetzner Load Balancer gestionado (~5-6€/mes, simple, pero es infra
     de un tercero delante de todo el tráfico — evaluar qué loguea contra
     el principio de cero-metadatos).
   - (b) 2 VMs nginx propias + IP flotante (más alineado con self-hosted,
     más trabajo operativo).
   - Recomendación por defecto: (a), para no convertir la propia base de HA
     en otro punto único de fallo dado el presupuesto medio disponible.

### Etapa 4 — Verificar con 2 VMs antes de comprometerse a 3

Confirmar con 2 VMs relay reales detrás del LB que un mensaje/llamada
emitido por la VM A llega a un socket conectado en la VM B — el punto 5
pendiente que ya señala `docs/RELAY-HORIZONTAL-SCALING.md`, nunca verificado
contra infra real.

### Etapa 5 — Estado final: N VMs relay iguales + coturn redundante

- Subir la 3ª VM relay (o la Nª, según lo que diga la Etapa 2).
- Redundancia de coturn: **no** "VMs iguales detrás del mismo LB" (es
  stateful por sesión UDP). Patrón correcto: 2+ instancias coturn
  independientes, y `/turn` entrega **varios** candidatos ICE (múltiples
  `urls` en el RTCConfiguration) con health-check previo, para que el
  cliente pruebe otro coturn si el primero no responde. Encaja con el
  diseño actual de `routes/turn.ts` — solo hace falta que sirva N hosts en
  vez de 1 y excluya los que fallen el health-check.

## Estimación de costo (aprox., verificar en consola Hetzner — precios pueden variar)

| Pieza | Tamaño aprox. | €/mes aprox. |
|---|---|---|
| 3× VM relay | CX22-CX32 cada una | ~15-24€ |
| 1× VM Postgres+Redis | CX22 | ~5-8€ |
| 2× VM coturn (redundante) | CX22 cada una | ~10€ |
| Load balancer (Hetzner LB gestionado) | — | ~5-6€ |
| **Total** | | **~35-48€/mes** |

Encaja dentro del presupuesto medio (~30-60€/mes).

## Reparto de trabajo (al pasar a implementación)

- **infra-lead**: VMs nuevas, `infra/deploy.sh`, `infra/nginx/*.conf`,
  `docker-compose.yml`, aprovisionar coturn/Postgres/Redis.
- **backend-lead**: tests del path Postgres, verificación del adapter Redis
  contra Redis real, `routes/turn.ts` multi-host + health-check.

## Criterio de "hecho" por etapa

Cambio commiteado + probado contra la VM real (no solo tests unitarios) +
este doc actualizado en la misma rama/PR marcando la etapa como ✅ con su
evidencia (commit/PR/test) — regla de oro doc↔código del proyecto.
