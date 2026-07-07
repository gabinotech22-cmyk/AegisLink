# Relay — escalado horizontal (PM2 cluster + Socket.IO Redis adapter)

> Estado: **código listo, NO activado en producción real.** Esto complementa
> (no duplica) `docs/SECURITY-ROADMAP-2026-06.md` ítem **A-1**, que sigue
> ⏸️ DIFERIDO — la VM Hetzner real sigue mono-instancia hoy. Este doc es la
> fuente canónica de "qué falta a nivel infra" para el día que se active.

## Qué ya existe en código (rama `feat/socketio-redis-adapter-pm2-cluster`)

| Pieza | Archivo | Se activa cuando |
|-------|---------|-------------------|
| Rate limiting distribuido (Lua INCR+EXPIRE, fallback a Map en memoria) | `server/src/relay/rateLimits.ts` + `server/src/relay/redisClient.ts` | `REDIS_URL` seteada — **ya existía antes de esta rama** |
| DB Postgres (en vez de SQLite+WAL) | `server/src/db/driver.ts` | `DATABASE_URL` empieza con `postgres://` — **ya existía antes de esta rama** |
| Adapter Redis para Socket.IO (broadcast cross-proceso) | `server/src/relay/socketIoRedisAdapter.ts` | `REDIS_URL` seteada — **nuevo en esta rama** |
| Config PM2 cluster mode (opt-in) | `server/ecosystem.config.cjs` | Se invoca explícitamente con `pm2 start ecosystem.config.cjs` — **nuevo, NO wired en `deploy/deploy.sh`** |

Ninguna de estas piezas cambia el comportamiento de la VM real hoy: sin
`REDIS_URL`/`DATABASE_URL` en el `.env` de producción, todo sigue funcionando
exactamente igual que antes (SQLite + rate-limit en memoria + adapter en
memoria de Socket.IO por defecto, mono-instancia via `pm2 start npm -- start`
en modo fork, tal como hace `deploy/setup.sh`/`deploy/deploy.sh` hoy).

## Qué falta para activar esto en producción real (fuera de esta rama)

1. **Provisionar Redis.** La nota original en el roadmap (`A-1`) ya advertía
   del riesgo operativo de añadir Redis a la VM ([[incident_n8n_oom_vm]] —
   un incidente previo de OOM con n8n en la misma caja). Antes de activar:
   decidir si Redis corre en la misma VM (con un límite de memoria duro,
   `maxmemory` + `maxmemory-policy noeviction` ya que perder una clave de
   rate-limit no es grave pero un OOM-kill del proceso relay sí) o en una VM
   separada.
2. **Setear `REDIS_URL` en el `.env` de producción.** Con eso solo, YA se
   activan tres cosas a la vez (rate limiting distribuido, adapter de
   Socket.IO, y cualquier futuro consumidor de `redisClient.ts`) — revisar
   los logs de arranque (`[relay] Redis adapter attached...` /
   `[relay] Connected to Redis for rate limiting`) para confirmar que ambos
   se activaron y no solo uno.
3. **Sticky sessions en nginx SI se corre >1 instancia.** Ver la sección de
   abajo — es un requisito de infra que este cambio deliberadamente NO
   implementa (tocar la config de nginx de la VM real está fuera de alcance
   de esta rama).
4. **Migrar `deploy/deploy.sh` para invocar `pm2 start ecosystem.config.cjs`
   en vez de `pm2 start npm -- start`** — deliberadamente no hecho en esta
   rama (ese script hace SSH directo a la VM de producción real). Es un
   cambio de infra a decidir por separado, una vez Redis esté provisionado.
5. **Verificar en dos instancias reales** (o al menos 2 workers PM2 cluster
   locales) que un mensaje/llamada emitido por el worker A llega a un socket
   conectado al worker B. El test de regresión en
   `server/src/__tests__/socketIoRedisAdapter.test.ts` cubre la lógica de
   activación condicional con un cliente ioredis-fake inyectado — **no** es
   una prueba end-to-end contra Redis real ni contra dos procesos PM2 reales.

Ninguno de estos 5 puntos está marcado como hecho aquí porque ninguno está
verificado contra la VM real — solo el código (piezas 1-2 de la tabla) está
listo y tiene tests.

## Transports de Socket.IO — decisión: mantener polling + documentar sticky sessions

`server/src/index.ts` NO restringe `transports` a `['websocket']`. Se evaluaron
las dos opciones:

- **(a) `transports: ['websocket']`** — evita necesitar sticky sessions porque
  el long-polling (que sí requiere que las requests sucesivas de un mismo
  cliente lleguen al mismo proceso) deja de usarse.
- **(b) Dejar polling habilitado + sticky sessions en el load balancer.**

**Se eligió (b)** porque el cliente móvil (`mobile/src/socket/client.ts`) ya
configura explícitamente `transports: ['websocket', 'polling']` como
fallback deliberado de resiliencia — redes restrictivas, algunos entornos
Wi-Fi/carrier que bloquean el upgrade a websocket, y el path de Tor onion
service (`docs/RELAY-ONION-SERVICE.md`, mailbox mode) donde un upgrade a
websocket puede fallar con más frecuencia que en clearnet. Quitar polling
del lado servidor eliminaría esa red de seguridad para exactamente los
usuarios con redes más restrictivas — el público objetivo de una app de
privacidad — sin coordinar el cambio con mobile-lead. Un cambio de esa
naturaleza (afecta conectividad de TODOS los clientes, no solo el
escalado) no pertenece a esta rama de backend/infra.

**Requisito de infra pendiente si se activa PM2 cluster / múltiples VMs
detrás de un load balancer:** nginx necesita sticky sessions para que las
requests de long-polling de un mismo cliente aterricen siempre en el mismo
worker/instancia hasta que el socket haga upgrade a websocket (o durante
toda la conexión, si el cliente se queda en polling). Dos opciones estándar
de nginx:

```nginx
# Opción 1 — ip_hash (más simple, pero agrupa por IP; con Tor/onion
# service todo el tráfico llega desde la IP del contenedor tor — ver
# "Consideraciones conocidas" en docs/RELAY-ONION-SERVICE.md — así que
# ip_hash NO sirve para el tráfico que llega por el onion service).
upstream aegislink_relay {
    ip_hash;
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
}

# Opción 2 — cookie-based (recomendada): requiere nginx Plus o el módulo
# community `nginx-sticky-module`/`ngx_http_upstream_hash_module` con
# hash por header (p.ej. Engine.IO ya manda el mismo `sid` en la query
# string de cada poll — se puede hashear por esa query param en vez de
# por IP, lo cual SÍ funciona correctamente detrás del onion service).
upstream aegislink_relay {
    hash $arg_sid consistent;   # Engine.IO manda ?sid=... en cada poll
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
}
```

Esto es solo documentación — **ningún archivo de nginx real de la VM se
tocó en esta rama** (regla de oro: cirugía/config de infra en prod queda
fuera de alcance de este trabajo de código).

## PM2 cluster mode

Ver `server/ecosystem.config.cjs` (comentarios inline con el razonamiento
completo). Resumen:

- `exec_mode: 'cluster'`, `instances: 2` — la VM Hetzner real tiene 2 vCPUs
  hoy; 2 workers es la elección predecible (vs `'max'`, que cambiaría de
  comportamiento silenciosamente si la VM se redimensiona).
- Invoca `node --import tsx src/index.ts` directamente (mismo comando que
  `npm start`), NO `npm start` envuelto — PM2 necesita el intérprete `node`
  directo para poder usar `cluster.fork()` internamente.
- **NO está wireado en `deploy/deploy.sh`.** Sigue arrancando en modo fork
  single-instance vía `pm2 start npm -- start`, exactamente como hoy. Activar
  cluster mode en la VM real es una decisión de infra explícita y posterior
  (requiere Redis provisionado primero — sin adapter, cluster mode rompería
  el broadcast cross-worker).
