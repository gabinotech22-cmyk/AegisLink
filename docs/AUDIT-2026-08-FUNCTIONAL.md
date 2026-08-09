# Auditoría funcional 2026-08 — AegisLink vs. Signal / Session / SimpleX

> **Método:** el código y los tests son la única fuente de verdad (regla de oro
> doc↔código #6). Cada veredicto lleva su `archivo:línea` o su suite. Nada aquí
> se afirma desde un `.md` anterior ni desde memoria.
>
> **Fecha:** 2026-08-09 · **Rama:** `fix/outbox-delivery-reliability` · **PR:** #435

## 0. Resumen

La base es **mejor de lo que la propia documentación del repo decía**. El relay
tiene entrega at-least-once real con acks por dispositivo, hay un suelo de
fiabilidad sobre Tor calcado del de Session/SimpleX, y el CI cubre tres
plataformas con fuzzing, CodeQL, semgrep y builds reproducibles.

Los fallos que el dueño veía no venían de la arquitectura, sino de **dos huecos
concretos en el cliente**, ambos ya corregidos en esta tanda: el outbox no tenía
quién lo condujera y la UI no podía representar un fallo de envío.

Salieron **9 hallazgos** (2 de seguridad, ambos ya cerrados). El más revelador
no es un bug de la app: la única prueba end-to-end de la app real lleva tiempo en
rojo sin bloquear nada (TEST-2), y al diagnosticarla apareció que además estaba
**registrando identidades reales contra el relay de producción** (TEST-3). Esa
falta de señal end-to-end es probablemente la razón de que el resto durara.

## 1. Superficie medida

| | Archivos | Líneas | Tests |
|---|---|---|---|
| `mobile/src` | 390 | 64 443 | 174 |
| `server/src` | 98 | 12 736 | **371** (53 suites) |
| `desktop/src` | 117 | — | 23 |

## 2. Lo que está BIEN (verificado, no asumido)

| Área | Evidencia |
|---|---|
| **Entrega at-least-once** | Acks por dispositivo, `drained_by`, drain-cap, borrado solo cuando todos los dispositivos persistieron — `server/src/relay/handler.ts:543-598`, `server/src/db/client.ts:214-302` |
| **Suelo de fiabilidad sobre Tor** | Drenaje stateless con auth por posesión de clave y ack diferido — `server/src/routes/mailbox.ts`. Mismo patrón que el swarm fetch de Session y el SMP fetch de SimpleX, y el archivo lo documenta como tal |
| **`ackDelivery` cableado de verdad** | El relay solo difiere el borrado para clientes que lo anuncian; **mobile y desktop lo anuncian ambos** — `mobile/src/socket/client.ts:1008`, `desktop/src/renderer/socket/client.ts:657` |
| **Work autenticado** | **31 de 32 rutas** exigen prueba Ed25519 (`verifyAdminSig`, o firma en línea en `/join:332-347`). La excepción está en §4 |
| **Llamadas probadas** | 12 suites: signaling, política sealed-sender, superficie única de timbre, acción pendiente, callkeep, wake service, ICE, a11y, minimize, grupo |
| **Cripto** | Módulos puros (cero imports de React Native), ratchet con zeroización, X3DH con consumo atómico de OPK |
| **Higiene de código** | 3 `console.*`, 4 `Alert.alert` directos, 28 `any`, **1 sola pantalla huérfana** (`LockSetup`) de 51 |
| **CI** | Typecheck estricto ×3, tests ×3, fuzz de parsers, CodeQL, semgrep, auditoría de permisos nativos, builds reproducibles |

> **Verificado contra el código, no contra la doc:** el at-most-once
> ("el relay borra al emitir") que describía la auditoría 2026-07-24 **ya está
> arreglado** (PR #370 + flag de compatibilidad #373). El resumen de una línea que
> aún lo daba por vigente se ha corregido en esta pasada.

## 3. Arreglado en esta tanda (PR #435)

### A-1 · El outbox era una cola durable sin conductor

`attempts` se incrementaba en cada fallo y **no lo leía nadie**: sin backoff, sin
tope, sin estado terminal. `flushOutbox` solo se disparaba en `auth:ok`, en el
fallback de recovery y al adoptar sesión — los tres, eventos del ciclo de vida
del socket. Un job que fallaba con la conexión sana esperaba a una reconexión
que un socket sano nunca produce: **el mensaje no salía nunca**.

Ahora: backoff exponencial con jitter (`mobile/src/db/outboxBackoff.ts`),
aparcado de forma durable en la columna `next_attempt_at` para que sobreviva a un
reinicio, ventana de reintento de 24 h y un planificador que duerme hasta que hay
trabajo. El regreso a foreground empuja también la salida, no solo el buzón de
entrada. Es el modelo de Signal ([Signal-Android#7914](https://github.com/signalapp/Signal-Android/pull/7914),
[jitter](https://github.com/signalapp/Signal-Android/commit/8f7fe5c3eeb693e132b3c7d8bc692546bd70d27d)).

### A-2 · La interfaz mentía

El modelo era `sent | delivered | read` con la columna por defecto en `'sent'`, y
la burbuja derivaba "en cola" de `me && !online` — **un proxy global de
conectividad**. Resultado doble: al caer el socket *todos* los mensajes salientes
se marcaban en cola, incluidos los entregados días atrás; y un job realmente
atascado con el socket vivo mostraba un tick indistinguible de uno entregado.

Ahora: `pending` y `failed` entran en el modelo, los mensajes nacen pendientes y
solo ascienden cuando el relay acka, la burbuja lee estado por mensaje, y un job
caducado marca `failed` con reintento manual que **reutiliza el id** para que el
dedup del receptor trate el original tardío y el reintento como un solo mensaje.
Todo local: nada de esto viaja al relay, cero metadatos nuevos.

### T-1 · El seam cliente↔relay ya tiene test

`server/src/__tests__/e2e/clientRelayDelivery.e2e.test.ts` levanta el relay real
(handler, cola, SQLite, registro con PoW, handshake) y le habla con la cripto
real del móvil. Tres escenarios: envío offline → reconexión → descifrado;
at-least-once (un drenaje sin ack sobrevive, uno con ack no); y el ratchet
avanzando en tres mensajes seguidos.

## 4. Hallazgos ABIERTOS

### SEC-1 · `POST /work/workspace` no verifica quién dice ser el admin — **alto**

`server/src/routes/work.ts:678-693` toma `adminAegisId` **del cuerpo de la
petición** y crea el workspace sin pedir firma. Es la única de las 32 rutas de
Work sin prueba de posesión de clave: `POST /work/org` (`:131`) sí la exige, y
`GET /work/workspace/:id` (`:696`) también. El comentario inmediatamente encima
(`:670`) dice literalmente *"knowing an aegisId ≠ owning it. Mirrors the mutation
endpoints' sig+ts"* — describiendo el esquema de **lectura**, mientras la
**mutación** de justo debajo se lo salta.

Viola las reglas de oro de seguridad #3 y #7. Impacto: cualquiera puede crear
workspaces atribuyendo la administración a un aegisId ajeno (spam de tabla y una
víctima que ve un workspace que nunca creó). El test `workspace.auth.test.ts`
solo cubre la lectura.

**Arreglo:** exigir `sig`+`ts` como el resto, con test de regresión que pruebe
que una firma ajena es rechazada.

### I18N-1 · Strings de cara al usuario hardcodeados, **en idiomas mezclados** — medio, **parcialmente cerrado**

Primero lo medí por llamadas a `themedAlert` y salieron 15. Al comprobar pantalla
por pantalla el hueco es mayor: **5 pantallas no tienen i18n cableado en
absoluto** (cero `useTranslation`), con ~41 literales entre ellas.

| Sitio | Literales | Idioma | Estado |
|---|---|---|---|
| `mobile/src/socket/calls.ts` (8: fallo de llamada + notificación en curso) | 8 | inglés + español | ✅ **arreglado, PR #436** |
| `mobile/src/screens/ProfileSwitcher.tsx` | ~13 | **español** | abierto |
| `mobile/src/screens/DistributionLists.tsx` | ~11 | inglés | abierto |
| `mobile/src/screens/Scheduled.tsx` | ~8 | español | abierto |
| `mobile/src/screens/BroadcastCompose.tsx` | ~6 | mixto | abierto |
| `mobile/src/screens/CreateProfile.tsx` | ~3 | español | abierto |
| `mobile/src/utils/overlayPermission.ts` | 2 | **español** | abierto |

Cortaba en las dos direcciones: un usuario en español recibía **todos** los
errores de llamada en inglés, y uno en inglés ve el cambio de perfil, los
programados y el permiso de superposición en español. Es la misma clase de bug
reportada contra la build 15, viva todavía en las pantallas más nuevas.

Las cinco pantallas sin i18n son trabajo mecánico pero pantalla a pantalla, y los
tests de paridad de locales (`i18nKeyParity`, `localeParity`, 9/9) **no lo
detectan**: solo comprueban que en/es/it tengan las mismas claves, no que las
pantallas usen claves en vez de literales.

### REL-1 · Los mensajes de grupo no pueden tener estado de envío — medio

Un envío de grupo se abre en un job **por miembro**, cada uno con su `msgId`
aleatorio (`mobile/src/socket/client.ts:4786`), y la burbuja del emisor se añade
con un tercer id sin relación (`:4896`). No hay forma de ir del job a la burbuja.
Por eso A-2 se limitó deliberadamente a 1:1: marcar esos jobs pondría un mensaje
de grupo entero en `failed` porque la entrega a uno de veinte miembros expiró.

**Arreglo:** que el fan-out lleve un id de mensaje compartido; entonces el estado
de grupo se resuelve por "todos los jobs de este msgId resueltos".

### PAR-1 · El desktop es ciudadano de segunda — medio (viola la regla de oro #5)

La cripto está **duplicada, no compartida**, y ya divergió:

| Módulo | mobile | desktop | Δ |
|---|---|---|---|
| `signal/x3dh.ts` | 755 | 438 | **−42 %** |
| `messaging.ts` | 304 | 248 | −18 % |
| `sealedSender.ts` | 169 | 136 | −20 % |

317 líneas menos en X3DH no es formato: es lógica ausente. Además faltan **12
pantallas**: los 5 de canales públicos, los 3 de llamadas de grupo, y
`CreateProfile` + `ProfileSwitcher` — **la sección 11 (múltiples perfiles) no
existe en desktop**.

### ARCH-1 · `socket/client.ts` tiene 4953 líneas — medio

Concentra transporte, sesiones, glare/recovery, grupos, self-copy, perfiles y
mailbox. Es la razón mecánica de que cada arreglo genere el siguiente. Costuras
naturales: transporte / sesiones / grupos / mailbox.

### TEST-1 · 196 `catch` en `screens/` sin triar — medio

La mayor concentración de tragado de errores está en la capa de UI. Hay que
clasificar cada uno en: legítimo best-effort, **debe avisar al usuario**, o
**debe fallar cerrado**.

### TEST-2 · La única prueba end-to-end de la app real lleva tiempo en rojo y no bloquea nada — medio

El job `mobile-e2e` (Maestro sobre emulador Android) está marcado
`continue-on-error: true` en `.github/workflows/ci.yml`, así que su resultado
**nunca ha bloqueado un merge**. Comprobado en la ejecución 31301655118 (PR #431,
que solo añade un markdown — no toca código de app):

- `01-launch-smoke` ✅ — la app compila, arranca y pinta la bienvenida.
- `02-onboarding` ❌ — **falla tras 11 min 5 s**: se genera la identidad y nunca
  se llega a la UI principal.

Que falle en un PR de solo-documentación descarta que lo rompa el cambio: está
roto de base.

**Diagnóstico, ya medido sobre el artefacto de la ejecución** (descartando mi
primera sospecha, que era el PoW):

- El fallo llega a los **664 s**, cuando los timeouts del propio flow suman
  **150 s**, y Maestro lo reporta como `Unknown error`, no como aserción fallida.
  Una aserción reventada habría fallado a los ~150 s.
- El logcat no muestra crash, ANR ni excepción de la app.
- ⇒ Es el **driver de Maestro/uiautomator colgándose sobre la jerarquía de vistas
  de React Native**, no la app fallando al hacer onboarding. Es la misma desincronía
  de uiautomator con RN que ya se había topado este repo antes.

Lo relevante para esta auditoría: **el único test que ejercita la app compilada
de principio a fin lleva tiempo rojo y nadie está obligado a mirarlo.** Mientras
siga `continue-on-error`, el proyecto no tiene señal end-to-end.

### TEST-3 · El E2E de CI registraba identidades reales en el relay de producción — **alto**, **cerrado**

Encontrado al diagnosticar TEST-2. El bundle de CI se compila con `--dev false`,
así que `__DEV__` es falso y `config.ts:34-37` resolvía `SERVER_URL` a
`SERVER_URL_PROD` = `https://aegislink.duckdns.org`. Es decir: **cada ejecución
del E2E minaba un PoW y registraba una identidad real contra el relay vivo**,
desde una IP compartida de runner de GitHub que además compite por el mismo
límite de 5 registros / 15 min que tienen los usuarios reales.

Confirmado en el logcat de la ejecución 31301655118: el emulador resolviendo y
verificando app-links de `aegislink.duckdns.org`.

El flow `02-onboarding` llevaba desde siempre justificándose con *"no server in
CI"*. Era una suposición, y era falsa. **Cerrado en PR #437**: se fija
`EXPO_PUBLIC_SERVER_URL` al loopback del emulador, con lo que la suposición pasa
a ser cierta y CI deja de escribir en producción.

### DOC-1 · `SESSION_HANDOFF.md` describía infraestructura muerta — bajo, **cerrado**

Fechado 2026-06-05, situaba el relay en AWS `51.20.60.155` con SSH `ubuntu@` y
`aegislink.pem`, cuando la infra viva es Hetzner (`root@aegislink.duckdns.org`),
y listaba como "sin commitear" cambios mergeados hace meses.

**Matiz importante que corrige una primera impresión mía:** el archivo está
**gitignored a propósito** (`.gitignore:50`, *"contains infra/access details, keep
out of history"*), así que **nunca estuvo en el repo**. No podía engañar a un
revisor externo ni al CI: el drift era local, en la máquina del dueño. Eso baja
la severidad de lo que inicialmente parecía una violación de la regla doc↔código
en el repositorio.

Cerrado: el archivo local lleva ahora una cabecera que enumera qué es falso y
redirige aquí, y la entrada correspondiente del `ROADMAP.md` (esa sí trackeada)
queda marcada.

## 5. Comparativa con los referentes

| Capacidad | AegisLink | Signal | Session | SimpleX |
|---|---|---|---|---|
| Reintento de envío durable | ✅ 24 h + backoff con jitter (nuevo) | ✅ 24 h + jitter | ✅ | ✅ |
| Estado de fallo por mensaje + reintento manual | ✅ 1:1 (nuevo) · ❌ grupos (REL-1) | ✅ | ✅ | ✅ |
| Entrega at-least-once con ack del cliente | ✅ | ✅ | ✅ | ✅ acks del agente SMP |
| Recepción sin socket persistente | ✅ drenaje stateless sobre Tor | ➖ websocket + REST | ✅ poll al swarm | ✅ fetch SMP |
| Integridad de cadena (hash del anterior) | ❌ | ➖ | ➖ | ✅ |
| Sealed sender también en llamadas | ✅ | ➖ | ➖ | ➖ |

**Lo que conviene copiar a continuación:** los **ids secuenciales con hash del
mensaje anterior** de SimpleX ([agent-protocol](https://github.com/simplex-chat/simplexmq/blob/stable/protocol/agent-protocol.md)).
Hoy nada detecta un hueco en la cadena: si un mensaje se pierde para siempre, el
receptor no lo sabe. Es la única capacidad de los tres referentes que no tenemos
y que ataca directamente la clase de fallo de esta auditoría.

## 6. Áreas aún sin auditar en profundidad

Reconocidas pero no diseccionadas en esta pasada, por orden de riesgo:
canales públicos, backup cifrado (10), mensajes programados (12), pagos (14),
web3/DIDs, y el cumplimiento de tiendas. Onboarding (1-2), efímeros (4),
adjuntos (5), grupos (6), llamadas (7-8), pánico (9) y perfiles (11) quedaron
cubiertos de forma indirecta por §2 y §4.

## 7. Orden recomendado

1. **SEC-1** — es seguridad y el arreglo es pequeño. **→ hecho, PR #436.**
2. **TEST-2** — diagnosticar por qué falla `02-onboarding`. Si es el PoW, arregla
   de paso el registro en hardware viejo; sea lo que sea, hasta que no esté verde
   el proyecto no tiene señal end-to-end. Ponerlo a bloquear después.
3. **I18N-1** — visible para todo usuario no anglófono, arreglo mecánico.
   **→ parcial, PR #436** (llamadas); quedan 5 pantallas sin i18n.
4. **REL-1** — cierra el estado de envío que A-2 dejó a medias.
5. **TEST-1** y **ARCH-1** — reducen la tasa de bugs futuros.
6. **PAR-1** — el desktop necesita decisión de producto antes que código
   (¿paridad completa, o desktop declarado como cliente reducido?).
7. **DOC-1** — ✅ cerrado en esta pasada.
