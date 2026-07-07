# Relay — escalado horizontal (sticky sessions + adapters + PM2)

> Estado: **código listo, NO activado en producción real.** Esto complementa
> (no duplica) `docs/SECURITY-ROADMAP-2026-06.md` ítem **A-1**, que sigue
> ⏸️ DIFERIDO — la VM Hetzner real sigue mono-instancia hoy. Este doc es la
> fuente canónica de "qué falta a nivel infra" para el día que se active.
>
> **Corrección arquitectónica (misma rama, post-revisión):** la primera
> versión de este trabajo asumía que `pm2 start ecosystem.config.cjs` con
> `exec_mode: 'cluster'` bastaba, y que sticky sessions era puramente un
> problema de config de nginx. Ambas cosas eran incorrectas para la topología
> real (2 workers, MISMA máquina, MISMO puerto) — ver la sección
> "Por qué PM2 `exec_mode: 'cluster'` solo no basta" más abajo. La arquitectura
> quedó corregida en el mismo cambio, antes de mergear nada.

## Qué ya existe en código (rama `feat/socketio-redis-adapter-pm2-cluster`)

| Pieza | Archivo | Se activa cuando |
|-------|---------|-------------------|
| Rate limiting distribuido (Lua INCR+EXPIRE, fallback a Map en memoria) | `server/src/relay/rateLimits.ts` + `server/src/relay/redisClient.ts` | `REDIS_URL` seteada — **ya existía antes de esta rama** |
| DB Postgres (en vez de SQLite+WAL) | `server/src/db/driver.ts` | `DATABASE_URL` empieza con `postgres://` — **ya existía antes de esta rama** |
| Adapter Redis para Socket.IO (broadcast cross-**máquina**) | `server/src/relay/socketIoRedisAdapter.ts` | `REDIS_URL` seteada — **nuevo en esta rama** |
| Adapter de cluster nativo para Socket.IO (broadcast cross-**worker**, misma máquina, vía IPC, sin Redis) | `server/src/relay/socketIoClusterAdapter.ts` | Corriendo como worker de `src/clusterMaster.ts` Y `REDIS_URL` NO seteada — **nuevo en esta rama** |
| Sticky routing (`@socket.io/sticky`) + traffic-router de cluster nativo | `server/src/clusterMaster.ts` | Se invoca directamente como entrypoint (`node --import tsx src/clusterMaster.ts`) en vez de `src/index.ts` — **nuevo en esta rama** |
| Config PM2 (opt-in, supervisa `clusterMaster.ts`, no `index.ts`) | `server/ecosystem.config.cjs` | Se invoca explícitamente con `pm2 start ecosystem.config.cjs` — **nuevo, NO wired en `deploy/deploy.sh`** |

Ninguna de estas piezas cambia el comportamiento de la VM real hoy: sin
`REDIS_URL`/`DATABASE_URL` en el `.env`, y arrancando `src/index.ts`
directamente (como hace `deploy/deploy.sh` hoy, vía `pm2 start npm -- start`),
todo sigue funcionando exactamente igual que antes — SQLite + rate-limit en
memoria + adapter en memoria de Socket.IO por defecto, mono-instancia.
`cluster.isWorker` es `false` en ese arranque, así que ninguna rama de código
nueva se activa.

## Por qué PM2 `exec_mode: 'cluster'` solo NO basta (la corrección)

La primera versión de `ecosystem.config.cjs` en esta rama usaba
`exec_mode: 'cluster'` apuntando directo a `src/index.ts`. Esto es
insuficiente por dos razones, ambas de fondo:

1. **Sticky routing.** `exec_mode: 'cluster'` de PM2 hace que 2 workers
   compartan el MISMO puerto (3001) — el reparto de conexiones entrantes
   ocurre DENTRO del proceso maestro de Node (`cluster` nativo), a nivel de
   sistema operativo/scheduling interno, ANTES de que nginx vea nada. Desde
   nginx solo existe UN destino (`127.0.0.1:3001`) — no hay "varios servers"
   entre los que nginx pueda repartir con `hash $arg_sid` ni con nada. El
   ejemplo de nginx con dos upstreams (`3001`/`3002`) que documentamos abajo
   solo tiene sentido para VMs SEPARADAS (multi-máquina real), no para el
   cluster-mode de una sola caja.
2. **PM2 no expone un "master" al código de la app.** El mecanismo oficial de
   Socket.IO para sticky sessions con el módulo `cluster` de Node
   (`@socket.io/sticky`, ver ["Using multiple nodes"](https://socket.io/docs/v4/using-multiple-nodes/)
   en la doc oficial) requiere que el propio código de la app llame a
   `setupMaster()` desde el proceso que es el verdadero `cluster.isPrimary`,
   y luego haga `cluster.fork()` él mismo para crear los workers. Pero en
   `exec_mode: 'cluster'` de PM2, es **PM2 quien hace el `cluster.fork()`**
   internamente — el script de la app (`src/index.ts`) SOLO se ejecuta dentro
   de los workers forkeados, nunca como el primary. `setupMaster()` llamado
   ahí lanzaría `Error: not master` (ver el código fuente de
   `@socket.io/sticky`, que hace exactamente ese chequeo). No hay ningún hook
   de PM2 para inyectar lógica "antes de forkear".

**La solución (Socket.IO docs oficiales, verificado contra el código fuente
de `@socket.io/sticky@1.0.4` y `@socket.io/cluster-adapter@0.3.0`, no
asumido de memoria):** la propia app gestiona su `cluster.fork()`, y PM2
supervisa solo ESE proceso externo (no cada worker):

```
PM2 (fork mode, 1 instancia)
  └─ src/clusterMaster.ts   (el verdadero cluster.isPrimary)
       ├─ setupMaster(httpServer)       @socket.io/sticky — sticky routing por `sid`
       ├─ setupPrimary()                @socket.io/cluster-adapter — broadcast cross-worker por IPC
       ├─ cluster.fork() × N  ──────────────┐
       │                                     ▼
       │                          src/index.ts (worker real, isClusterWorker=true)
       │                            - NO llama httpServer.listen() — el
       │                              master ya tiene el socket real y le
       │                              reenvía las conexiones crudas
       │                            - setupWorker(io) recibe esas conexiones
       │                            - io.adapter(...) = Redis (si REDIS_URL) o
       │                              cluster-adapter (si no) — NUNCA ambos
       └─ cluster.on('exit') → refork si un worker muere
```

Esto reemplaza por completo el diseño anterior (`exec_mode: 'cluster'`
apuntando a `index.ts`), que quedó descartado antes de mergear a `main`.

## Paquetes verificados (no asumidos de memoria)

Antes de instalar nada se verificó contra `npm view` y la documentación
oficial de Socket.IO / los READMEs de los paquetes en GitHub:

- **`@socket.io/sticky`** (última: `1.0.4` al verificar) — `setupMaster()` /
  `setupWorker()`. Enruta por el query param `sid` de Engine.IO. Confirmado
  en la sección oficial ["Using Node.js Cluster"](https://socket.io/docs/v4/using-multiple-nodes/#using-nodejs-cluster-module)
  como el paquete recomendado para exactamente este escenario (módulo
  `cluster` de Node en una sola máquina).
- **`@socket.io/cluster-adapter`** (última: `0.3.0` al verificar) —
  `createAdapter()` / `setupPrimary()`. Broadcast entre workers vía
  `process.send`/IPC nativo — sin dependencia externa. Es el adapter
  "hermano" recomendado junto a `@socket.io/sticky` en el mismo ejemplo
  oficial, específicamente para el caso de una sola máquina (a diferencia
  del adapter Redis, pensado para multi-máquina).
- Ambos con tipos TypeScript propios (`index.d.ts` / `dist/index.d.ts`), sin
  necesidad de `@types/*` adicionales.

## Redis adapter vs. cluster adapter — cuál se usa cuándo

`server/src/index.ts` decide en tiempo de arranque, nunca ambos a la vez:

```ts
if (process.env.REDIS_URL) {
  attachSocketIoRedisAdapter(io);       // gana si está configurado
} else if (isClusterWorker) {
  attachSocketIoClusterAdapter(io);     // fallback gratis, misma máquina
}
// ni uno ni otro: adapter en memoria por defecto de Socket.IO (hoy, sin cambios)
```

| Escenario | Adapter correcto | Por qué |
|-----------|-------------------|---------|
| 1 proceso, sin Redis (deployment real de hoy) | Ninguno (default en memoria) | No hay nada que reenviar entre procesos |
| N workers, **misma** VM (`src/clusterMaster.ts`), sin Redis | `@socket.io/cluster-adapter` | Broadcast por IPC nativo, cero dependencias externas, cero riesgo operativo — correcto y suficiente para esta topología |
| N workers/VMs, con `REDIS_URL` configurada | `socketIoRedisAdapter.ts` (Redis) | Necesario en cuanto hay más de UNA máquina — IPC no cruza red; también cubre el caso de una sola máquina si Redis ya está ahí por otra razón (rate-limit distribuido) |

**El adapter Redis (`socketIoRedisAdapter.ts`) sigue siendo necesario y no se
tocó** — sigue siendo la pieza correcta el día que se escale a VARIAS VMs
reales. El cluster-adapter no lo vuelve redundante; cubre un escalón previo
(N workers, 1 sola VM) que hoy sería gratis de activar sin tocar
infraestructura.

## Transports de Socket.IO — decisión: mantener polling

`server/src/index.ts` NO restringe `transports` a `['websocket']`. Se eligió
mantener `['websocket', 'polling']` (el default) porque el cliente móvil
(`mobile/src/socket/client.ts`) ya configura ese mismo fallback deliberado de
resiliencia — redes restrictivas, algunos entornos Wi-Fi/carrier que
bloquean el upgrade a websocket, y el path de Tor onion service
(`docs/RELAY-ONION-SERVICE.md`, mailbox mode) donde un upgrade a websocket
puede fallar con más frecuencia que en clearnet. Quitar polling del lado
servidor eliminaría esa red de seguridad para exactamente los usuarios con
redes más restrictivas — el público objetivo de una app de privacidad — sin
coordinar el cambio con mobile-lead.

Con `transports` incluyendo polling, la ruta correcta para que las requests
sucesivas de un mismo cliente lleguen siempre al mismo proceso deja de ser
"un cambio de transporte" y pasa a ser **sticky ROUTING** — resuelto de dos
formas distintas según la topología real:

- **N workers en LA MISMA máquina** (lo que de verdad se despliega hoy con
  `ecosystem.config.cjs`): resuelto **en código**, sin tocar nginx —
  `src/clusterMaster.ts` + `@socket.io/sticky` (ver arriba). Nginx (si existe
  delante) solo ve UN puerto (`3001`), como siempre; no necesita saber nada
  de sticky sessions para este caso.
- **VMs SEPARADAS de verdad** (multi-máquina, escalado futuro más allá de
  esta rama): sticky sessions en el load balancer. Aquí SÍ aplican los
  ejemplos de nginx de abajo — pero **solo para este escenario**, no para el
  cluster-mode de una sola VM que ya configuramos.

### nginx — SOLO aplica si se escala a VMs separadas (multi-máquina)

```nginx
# Opción 1 — ip_hash (más simple, pero agrupa por IP; con Tor/onion
# service todo el tráfico llega desde la IP del contenedor tor — ver
# "Consideraciones conocidas" en docs/RELAY-ONION-SERVICE.md — así que
# ip_hash NO sirve para el tráfico que llega por el onion service).
upstream aegislink_relay {
    ip_hash;
    server vm1.internal:3001;
    server vm2.internal:3001;
}

# Opción 2 — hash por sid de Engine.IO (recomendada, funciona también
# detrás del onion service ya que no depende de la IP de origen):
upstream aegislink_relay {
    hash $arg_sid consistent;   # Engine.IO manda ?sid=... en cada poll
    server vm1.internal:3001;
    server vm2.internal:3001;
}
```

Esto es solo documentación — **ningún archivo de nginx real de la VM se
tocó en esta rama** (regla de oro: cirugía/config de infra en prod queda
fuera de alcance de este trabajo de código). Y, de nuevo: esta sección NO
aplica a la topología de 2 workers en la única VM real de hoy — ahí el
sticky routing ya está resuelto por `src/clusterMaster.ts`.

## `src/clusterMaster.ts` — límites conocidos

- **No compatible con `TLS_CERT_PATH`/`TLS_KEY_PATH` (terminación TLS directa
  en el proceso).** `@socket.io/sticky` documenta explícitamente que su
  módulo maestro "no es compatible con un servidor HTTPS" (reenvía bytes TCP
  crudos, sin entender TLS). `src/index.ts` falla cerrado (`process.exit(1)`
  con un mensaje explícito) si detecta `isClusterWorker && tlsDirect` — no
  degrada en silencio a un worker roto. Si se activa `clusterMaster.ts` en
  producción, TLS debe terminarse DELANTE de él (nginx/Caddy), no dentro.
- Cada worker corre su propio `setInterval` de purga (mensajes/SenderKey
  expirados) de forma independiente — redundante pero inofensivo (los
  `DELETE` son idempotentes).
- El "primary" (`clusterMaster.ts`) es un router delgado: no monta Express,
  no toca la DB, no expone rutas HTTP propias — su única responsabilidad es
  sticky routing + el adapter de cluster. Toda la lógica de negocio sigue
  viviendo, sin cambios, en `src/index.ts`.

## Qué falta para activar esto en producción real (fuera de esta rama)

1. **Decidir si activar multi-worker YA (sin Redis) o esperar a Redis.**
   Con el cluster-adapter nativo, N workers en la VM actual (2 vCPUs) ya
   funcionarían correctamente HOY sin provisionar Redis — es la novedad de
   esta corrección. Sigue siendo una decisión de infra explícita (activar
   `ecosystem.config.cjs` en la VM real), no automática por mergear esta rama.
2. **Provisionar Redis** (opcional para el caso de 1 sola VM, pero
   obligatorio el día que se agregue una segunda VM). La nota original en el
   roadmap (`A-1`) ya advertía del riesgo operativo de añadir Redis a la VM
   ([[incident_n8n_oom_vm]] — un incidente previo de OOM con n8n en la misma
   caja). Antes de activar: decidir si Redis corre en la misma VM (con
   `maxmemory` + `maxmemory-policy noeviction`) o en una VM separada.
3. **Setear `REDIS_URL` en el `.env` de producción** cuando corresponda —
   activa a la vez rate limiting distribuido y el adapter Redis de
   Socket.IO (reemplazando al cluster-adapter automáticamente, ver tabla de
   arriba). Revisar logs de arranque para confirmar cuál de los dos adapters
   quedó activo.
4. **Sticky sessions en nginx SOLO si se agrega una segunda VM.** Ver sección
   de arriba — no aplica a la única VM real de hoy.
5. **Migrar `deploy/deploy.sh` para invocar `pm2 start ecosystem.config.cjs`**
   en vez de `pm2 start npm -- start` — deliberadamente no hecho en esta
   rama (ese script hace SSH directo a la VM de producción real). Cambio de
   infra a decidir por separado.
6. **Verificar en la VM real** (o al menos localmente con
   `AEGIS_CLUSTER_WORKERS=2 npm run start:cluster`) que un
   mensaje/llamada emitido por el worker A llega a un socket conectado al
   worker B, y que las requests de long-polling de un mismo cliente
   permanecen pegadas al mismo worker. Los tests de regresión
   (`socketIoRedisAdapter.test.ts`, `socketIoClusterAdapter.test.ts`) cubren
   la lógica de activación condicional de cada adapter con clientes/objetos
   `io` fake inyectados — **no** son pruebas end-to-end contra Redis real,
   contra `clusterMaster.ts` forkeando de verdad, ni contra dos procesos PM2
   reales.

Ninguno de estos puntos está marcado como hecho aquí porque ninguno está
verificado contra la VM real — solo el código está listo y tiene tests.
