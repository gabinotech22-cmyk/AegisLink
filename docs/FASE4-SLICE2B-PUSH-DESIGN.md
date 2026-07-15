# Fase 4 · Slice 2b — Push wake-up por mailbox (documento de decisión)

> Estado: **decisión resuelta; 2b.0, 2b.1 y 2b.2 (app viva) implementados**
> (server + infra desplegados en el VM 2026-07-12; suscripción móvil sobre onion
> con validación en dispositivo pendiente). 2b.3 (app matada / UnifiedPush) y
> 2b.4 (iOS APNs, tras flag) implementado — ver §9. Slice 2b es, en realidad, trabajo de
> **Fase 5** (ver `SEALED-SENDER-ARCHITECTURE.md:247`): cierra el último
> reducto que las Slices 1–6 dejaron abierto a propósito. Referencias:
> `SEALED-SENDER-ARCHITECTURE.md` §3.4 y §"Límite honesto",
> `FASE4-CONTROL-PLANE-DESIGN.md`.

## 1. El problema en una frase

En el path **aegisId**, cuando llega un sobre para un destinatario offline el
relay lo encola y dispara un wake-up ciego: `notifyRecipient(aegisId)` →
`pushRepo.forRecipient(aegisId)` → Expo/FCM (`server/src/push/expo.ts:19`). El
relay puede hacerlo porque mantiene un mapa **estable** `aegisId → expo_token`.

En el path **mailbox** ese mapa no existe **y no debe existir de forma estable**.
El sobre offline se encola en `handler.ts:694` con un comentario explícito:

```
// Push wake-up by mailbox is Slice 2b.
```

Hoy: **un mailbox offline nunca se despierta por push.** El mensaje espera en la
cola hasta que el cliente reconecta por otra razón (foreground, otro evento). Con
la app muerta bajo Doze, eso puede no pasar en horas. Inaceptable para 1:1 y, sobre
todo, para llamadas.

## 2. Por qué no es "añadir un mapa mailbox→token"

El objetivo entero de la Fase 4 es que **el relay no sepa quién es el dueño de un
mailbox**, y que el id **rote por época** (`mailbox(epoch)=SHA256(HKDF(root,epoch).pub)[0:16]`,
`mobile/src/crypto/mailbox.ts:131`). Un mapa `mailbox → expo_token` reintroduce dos
correlaciones que acabamos de eliminar:

1. **Relinking cross-época (relay).** El `expo_token` de FCM es **estable por
   instalación** — no rota. Si el relay guarda `mailboxId(E) → token` y
   `mailboxId(E+1) → token`, el token compartido **vuelve a unir** las épocas que
   la rotación separó. Game over para la rotación.
2. **Reducto del proveedor (FCM/APNs/Google).** El proveedor ve `token → device`
   (y a menudo `→ cuenta Google → identidad`) y el **timing** exacto de cada
   wake-up. Aunque el relay rotara el id, Google sigue viendo "este device fue
   despertado justo cuando llegó algo al mailbox X".

`SEALED-SENDER-ARCHITECTURE.md:122-128` ya lo marca: *"el proveedor de push son
los [reductos]"*. Slice 2b no es "conectar un cable": es **elegir cómo se
notifica sin reintroducir el grafo**.

## 3. Restricciones de diseño (no negociables)

- **R1 — Sin token estable ligado a un id rotatorio en el relay.** Lo que el relay
  guarde para notificar debe rotar con la época, igual que el mailbox.
- **R2 — Cero identidad/aegisId en el wake-up** (ya lo cumple el path aegisId:
  payload genérico `"Nuevo mensaje cifrado · E2EE"`, sin sender/contador/contenido).
- **R3 — Fail-closed con el resto de Fase 4.** El push mailbox sólo cuando
  `MAILBOX_ENABLED = MAILBOX_MODE && ONION_URL`. Sin Tor no hay path mailbox, luego
  tampoco push mailbox.
- **R4 — Paridad de modelo mobile↔desktop↔server** (aunque la *implementación* de
  transporte difiera por plataforma; ver §6).
- **R5 — Degradar con honestidad, nunca en silencio.** Si en una plataforma el único
  wake-up posible reintroduce un reducto (p.ej. APNs en iOS), va **tras un flag
  dedicado y documentado**, no por defecto.

## 4. Opciones evaluadas

| | Quién despierta | Id de push | ¿Rota? | Reducto del proveedor | Veredicto |
|---|---|---|---|---|---|
| **A. Token escrow rotatorio sobre FCM/Expo** | FCM/Expo | `pushId(E)→token` en el relay | El id rota, **el token no** | Google ve token+timing; relay relinkea por token | ❌ No cumple R1 ni R2-provider. Falsa sensación de privacidad. |
| **B. UnifiedPush / ntfy self-hosted, topic por época** | ntfy propio | topic = id derivado por época | Sí (con la época) | El ntfy somos nosotros; sólo ve topic+timing sobre Tor, sin identidad | ✅ Cumple R1–R3. Android-first. |
| **C. Socket persistente en foreground-service** | La propia app | — (no hay push) | n/a | Ninguno nuevo | ✅ Privacidad máxima, ❌ batería; ya lo usamos en llamadas activas, no como base 24/7 |

### Recomendación: **B como objetivo, con C como complemento y A descartada.**

- **Android (primario): UnifiedPush con distribuidor ntfy.** Es exactamente lo que
  el roadmap ya apuntaba (`SEALED-SENDER-ARCHITECTURE.md:258-259`). Corta Google del
  todo. El distribuidor ntfy mantiene **un único socket persistente para TODAS las
  apps UnifiedPush** del teléfono → resuelve el problema clásico de Doze sin que cada
  app pague batería (ese es el argumento de venta de UnifiedPush).
- **iOS (fast-follow): APNs es obligatorio** — Apple no permite sockets en
  background ni UnifiedPush. Se acepta el reducto APNs **tras flag** (R5),
  documentado, y se mitiga sólo con payload genérico (R2). iOS ya va por tandas
  (`[[project_launch_ios_decision]]`), así que no bloquea.
- **Desktop: no aplica push.** Electron mantiene su socket mientras la app vive; el
  wake-up por proveedor no tiene sentido. Desktop sigue drenando en reconexión
  (Slice 6 ya cablea connect/drain). Se documenta como "sin reducto de push".

## 5. Construcción criptográfica (Opción B)

### 5.1 Derivación del topic — separado del id de entrega

El relay sólo conoce el **mailbox de entrega** `M = mailboxId(root, E)` (no el root),
así que no puede derivar nada nuevo por sí mismo. Dos variantes:

- **v1 (recomendada, cero estado nuevo): `topic = M`.** El cliente se suscribe en
  ntfy al topic igual a su mailbox de entrega de la época. Cuando el relay encola un
  `envelope:mb` offline para `M`, publica un wake vacío a `topic M`. **Sin tabla de
  binding, sin ronda de registro extra, sin correlación nueva** más allá de la que el
  relay ya tiene (conoce `M`). Como ntfy y relay los self-hosteamos, el operador no
  gana información: ve el mismo `M` que ya rutea, y `M` rota por época.
- **v2 (defensa en profundidad, si algún día ntfy lo opera un tercero):**
  `topic = base64url(HKDF(root, "AegisLinkPush" ‖ epoch))[0:16]`, **distinto** del id
  de entrega (otro `info`). Entonces el cliente debe declarar al relay el binding
  `M(E) → topic(E)` en el connect, **probado por posesión de la clave de mailbox**
  (mismo challenge que ya firma). El binding rota por época → linkage sólo intra-época,
  idéntica propiedad al resto de Fase 4.

> Decisión: **v1 para el primer corte** (relay y ntfy co-hospedados bajo nuestro
> control; `M` ya es conocido por el relay → no añade reducto). Dejar v2 documentada
> como upgrade si el push se externaliza.

**Amendment — charset del topic (implementado en `push/ntfy.ts:mailboxTopic`):**
ntfy solo acepta `[-_A-Za-z0-9]` en nombres de topic; `M` viaja como base64
estándar (con `+`, `/`, `=`). `mailboxTopic()` lo convierte a base64url sin
padding (`+`→`-`, `/`→`_`, strip `=`) antes de usarlo como topic — sin cambiar
la propiedad de rotación por época, solo el encoding de superficie.

### 5.2 Suscripción sobre Tor

El cliente se suscribe a `topic = M` **vía el .onion** (mismo `ONION_URL` que ya
exige `MAILBOX_ENABLED`), así ntfy nunca ve la IP del cliente. El topic es un
**bearer capability de 128 bits** (salida HKDF) → no hace falta auth de suscripción;
adivinarlo es inviable. Rota a medianoche UTC con el mailbox (reusar
`scheduleEpochRotation`: al cruzar boundary, re-suscribir al nuevo `M` + desuscribir
del viejo tras la gracia de skew).

### 5.3 Publicación desde el relay

Único punto de cambio en el hot path: `handler.ts:694-704`. Tras `messageRepo.enqueue`
con `result.ok`, si no había socket online para `d.to`:

```ts
if (PUSH_MAILBOX_ENABLED) void notifyMailbox(d.to);  // publica wake vacío a ntfy topic=d.to
```

`notifyMailbox(mailboxIdB64)` (nuevo `server/src/push/ntfy.ts`) hace un POST al ntfy
local: cuerpo vacío, prioridad alta, **sin título/sender** (R2). Análogo a
`notifyRecipient` pero contra ntfy, no Expo. Para llamadas: el invite mailbox-routed
(cuando exista) publica con TTL corto, espejando `sendCallWakeUp`.

## 6. Cambios por capa

- **server/** — `push/ntfy.ts` (cliente publish), gate `PUSH_MAILBOX_ENABLED` en
  `config`, hook en `handler.ts:704`. Sin tabla nueva en v1.
- **mobile/** — integración UnifiedPush (lib `react-native-unifiedpush` o binding
  propio al distribuidor), suscripción al topic por época sobre Tor, re-suscripción en
  `scheduleEpochRotation`, y un fallback (§7). Verificar versiones contra
  `https://docs.expo.dev/versions/v54.0.0/` antes de tocar nada (config plugin /
  módulo nativo → requiere prebuild + APK release, no Expo Go).
- **desktop/** — sin cambios de push (mantiene socket). Documentar.
- **infra/** — desplegar ntfy self-hosted (contenedor ligero; **NO** en la VM del
  relay si compromete RAM — ver `[[incident_n8n_oom_vm]]`; evaluar host aparte o
  binario systemd), exponerlo como hidden service junto al relay.

## 7. Fallback y degradación honesta (R5)

Orden de preferencia por dispositivo, decidido en runtime:

1. **Android con distribuidor UnifiedPush** → ntfy topic=M sobre Tor. **Sin reducto
   de proveedor.**
2. **Android sin distribuidor** → reusar el `registerBackgroundReconnect` existente
   (`mobile/src/notifications/backgroundReconnect.ts`) como best-effort; si el usuario
   exige fiabilidad con app muerta, ofrecer **opt-in** al FCM ciego del path aegisId
   **tras flag** con aviso explícito del reducto (no por defecto).
3. **iOS** → APNs ciego tras flag (fast-follow).

Nunca se activa un fallback con reducto sin que el flag esté ON y documentado.

## 8. Modelo de amenaza — qué cierra y qué no

**Cierra:** el wake-up deja de necesitar `aegisId`; con UnifiedPush deja de pasar por
Google/Apple; el topic rota por época como todo lo demás.

**Reducto residual (honesto):**
- ntfy (nosotros) ve `topic + timing` sobre Tor, sin identidad; `topic` rota.
- La **correlación temporal** "alguien drenó justo tras un publish" persiste — es el
  mismo límite irreducible que `mailbox.ts:35-38` ya documenta y que Signal/SimpleX
  también asumen. Se ataca con cover-traffic/jitter en **Fase 5**, no aquí.
- iOS/APNs y el fallback FCM son reductos **opt-in y marcados**, no el camino por
  defecto.

## 9. Plan de implementación (sub-slices)

- **2b.0** — ✅ HECHO. ntfy self-hosted co-hospedado con el relay: servicio
  `ntfy` en `docker-compose.yml` (imagen `binwiederhier/ntfy:latest`, sin
  puertos publicados, `aegis_internal`), hidden service adicional
  `HiddenServicePort 8090 ntfy:80` en `infra/tor/torrc` (mismo onion que el
  relay), y orden de restart en `infra/deploy.sh` (ntfy antes que tor, ya que
  tor resuelve hostnames al arrancar). Pendiente de verificación en vivo con
  `curl` publish/subscribe sobre el .onion tras el próximo deploy (no
  desplegado en esta rama).
- **2b.1** — ✅ HECHO. `server/src/push/ntfy.ts` (`mailboxTopic()` +
  `notifyMailbox()`, flag-gated `PUSH_MAILBOX_ENABLED` + `NTFY_URL`), hook en
  `handler.ts` (rama offline de `envelope:mb`, tras `messageRepo.enqueue`
  con `result.ok`). Tests: `server/src/__tests__/ntfyMailboxPush.relay.test.ts`
  (offline+flag ON → exactamente un publish a `topic=mailboxTopic(M)`; online
  → cero; mock a nivel de módulo) y `server/src/__tests__/ntfy.unit.test.ts`
  (gate real sin mock: flag off / sin `NTFY_URL` / caso feliz, contra `fetch`
  stubbeado). `mailboxTopic()` cubierto en el mismo archivo relay
  (conversión base64→base64url sin padding).
- **2b.2 (app viva)** — 🟢 IMPLEMENTADO (pendiente validación en dispositivo).
  Suscripción por streaming HTTP (ntfy `/<topic>/json`) **sobre el onion** (mismo
  `.onion` que el mailbox, puerto virtual 8090) usando un método nativo nuevo
  `httpSubscribe`/`httpUnsubscribe` en el bridge Tor (`mobile/plugins/withTorEmbedded.js`,
  patrón dumb-pipe idéntico a `sioConnect`). Gestor JS
  `mobile/src/notifications/mailboxPushSubscription.ts`: topic = `mailboxTopic(mailboxId)`
  (base64url, byte-idéntico al server), re-suscripción en el boundary de época,
  retry a los 30 s ante circuito caído; al recibir un evento `message` drena el
  mailbox (`connectMailboxForIdentity`). Tests JS: `mailboxPushSubscription.test.ts`.
  Cubre **app viva/background**; app matada necesita 2b.3. Validación en vivo =
  **APK dev-client 2-dispositivos** (no automatizable en Jest).
  - **Acceso ntfy (decidido)**: exponer ntfy también por **HTTPS clearnet** con
    `access_log off` en nginx (para el distribuidor UnifiedPush de 2b.3, que no
    habla SOCKS) **y** mantener el onion documentado para quien use Orbot. La
    suscripción de 2b.2 (app viva) usa SIEMPRE el onion; el clearnet es solo para
    el distribuidor externo de 2b.3.
- **2b.3a (infra: ntfy clearnet)** — ✅ HECHO (rama `feat/ntfy-clearnet-exposure`).
  nginx sirve ntfy por HTTPS en `aegislink.duckdns.org:8443` (bloque nuevo en
  `infra/nginx/aegislink.conf`): `access_log off`, **sin** `X-Real-IP`/
  `X-Forwarded-For` hacia ntfy (`behind-proxy=false` → ntfy solo ve loopback),
  upgrade WebSocket + streaming. `docker-compose.yml`: ntfy publica
  `127.0.0.1:8090:80` (solo loopback, patrón idéntico al relay:3001),
  `NTFY_BASE_URL=https://aegislink.duckdns.org:8443` (los endpoints UnifiedPush
  que ntfy reparte embeben esta URL) y límites de visitante ampliados (todos los
  clientes clearnet comparten el visitante loopback al no reenviar IPs).
  **Paso manual al desplegar: abrir el puerto 8443/tcp en el firewall del VM.**
  El onion (8090) queda intacto para la suscripción in-app de 2b.2.
- **2b.3b-relay (binding `M(época) → endpoint`)** — ✅ HECHO (rama
  `feat/up-endpoint-binding`). Evento `mailbox:push:endpoint` SOLO sobre el
  socket de mailbox ya autenticado por challenge (regla de oro #3: el binding
  exige posesión de la clave de firma del mailbox; un atacante que conozca el
  id no puede secuestrar sus wakes — test dedicado). Tabla `push_endpoints`
  (SQLite+PG) + `pushEndpointRepo`; `notifyMailbox()` publica al endpoint si
  hay binding (y lo elimina ante 404/410), si no cae al topic co-hosteado de
  2b.1/2b.2. Guard SSRF `isSafeUpEndpoint` (solo https, sin IP literales /
  localhost / single-label / .local/.internal/.onion / credenciales, cap 512).
  Purga de bindings >48 h (2 épocas) en el scheduler (R1: nada estable
  sobrevive la rotación). Tests: `upEndpointBinding.relay.test.ts`.
- **2b.3c (mobile: conector UnifiedPush)** — PENDIENTE. Receiver Android vía
  config-plugin, registro con el distribuidor instalado (ntfy app / Sunup),
  emitir `mailbox:push:endpoint` al conectar/rotar época, y fallback FCM
  opt-in tras flag (§7). Trabajo nativo → requiere prebuild + APK.
- **2b.4 (iOS app matada, tras flag)** — 🟢 IMPLEMENTADO (rama
  `feat/mailbox-ios-apns-wake`; validación en iPhone pendiente). Binding
  `mailbox(época) → token Expo/APNs` con **doble opt-in**: flag cliente
  `EXPO_PUBLIC_MAILBOX_IOS_WAKE=on` (solo emite en iOS) **y** flag server
  `PUSH_MAILBOX_TOKEN_WAKE=on` (sin él, el binding se ignora y el wake cae al
  topic — fail-closed, test dedicado). Evento `mailbox:push:token` con las
  mismas reglas que el endpoint UnifiedPush (solo socket autenticado, regla de
  oro #3; purga 48 h). El wake es el genérico R2 ("Nuevo mensaje cifrado ·
  E2EE") vía API de Expo; DeviceNotRegistered elimina el binding. **Reducto
  documentado y aceptado (§7.3/R5)**: el token estable permite al relay
  re-linkear épocas — por eso NUNCA activo por defecto. Tests:
  `mailboxTokenWake.relay.test.ts` (server) y
  `mailboxIosWakeBinding.test.ts` (mobile, gating del doble opt-in).

## 10. Pregunta abierta antes de implementar 2b.0 — RESUELTA

¿ntfy **co-hospedado** con el relay (mismo operador, justifica `topic=M` de §5.1 v1)
o **host separado** desde el día 1 (entonces conviene `topic` derivado v2 para no
dar a un futuro operador distinto el join `M↔topic`)? La respuesta fija si 2b.1
necesita la ronda de binding o no.

**Decisión: co-hospedado.** ntfy corre como servicio adicional en el mismo
`docker-compose.yml` que el relay, mismo host, mismo operador — v1
(`topic=M`, sin tabla de binding) es correcto tal como está implementado en
2b.0/2b.1. Migrar a v2 (topic derivado, ronda de binding autenticada) sólo si
el push se externaliza a un operador de ntfy distinto en el futuro.
