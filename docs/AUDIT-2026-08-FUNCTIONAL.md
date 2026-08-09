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

Salieron **9 hallazgos**: **7 cerrados** en esta tanda (SEC-1, I18N-1, REL-1,
TEST-1, TEST-2, TEST-3, DOC-1) y **2 abiertos** (PAR-1, ARCH-1).

El más revelador no era un bug de la app. La única prueba end-to-end de la app
real llevaba tiempo en rojo sin bloquear nada (TEST-2) y, al diagnosticarla,
apareció que además estaba **registrando identidades reales contra el relay de
producción** (TEST-3) — lo que resultó ser también la causa del rojo. Arreglado
eso, el E2E pasa en 34 s por primera vez. Esa ausencia de señal end-to-end es
probablemente la razón de que el resto de huecos durara tanto.

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

## 4. Hallazgos

Siete cerrados en esta tanda (SEC-1, I18N-1, REL-1, TEST-1, TEST-2, TEST-3,
DOC-1) y dos abiertos (PAR-1, ARCH-1). Cada uno lleva su estado en el título.

### SEC-1 · `POST /work/workspace` no verificaba quién decía ser el admin — **alto**, **cerrado**

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

**Cerrado en PR #436:** la creación exige `sig`+`ts` como el resto, firmando
sobre el propio aegisId (el workspace aún no tiene id). Cinco tests de regresión:
camino honesto, atacante firmando con su clave para un aegisId ajeno, la petición
sin firma de antes, timestamp caducado, y una firma de lectura reusada como
creación.

### I18N-1 · Strings de cara al usuario hardcodeados, **en idiomas mezclados** — medio, **cerrado**

El hallazgo creció tres veces al medirlo mejor, y esa progresión es la parte
interesante:

1. Barrido por llamadas a `themedAlert`: **15 literales**.
2. Comprobación pantalla por pantalla: **5 pantallas sin `useTranslation` en
   absoluto**, ~41 literales más.
3. Una captura del E2E mostró el banner **"Registro fallido" en un emulador
   en_US** — y ese string vive en un *store*, no en una pantalla. Barriendo todo
   `src/` aparecieron **9 alertas más** en stores, `socket/` y componentes.

| Sitio | Idioma | Estado |
|---|---|---|
| `socket/calls.ts` — errores de llamada + notificación en curso | inglés + español | ✅ PR #436 |
| 5 pantallas: ProfileSwitcher, CreateProfile, Scheduled, DistributionLists, BroadcastCompose | mixto | ✅ PR #436 |
| `socket/groupCalls.ts` — 6 alertas (sin conexión, sin micro, llamada llena…) | español | ✅ PR #436 |
| `components/SchedulePicker.tsx` — 2 alertas | español | ✅ PR #436 |
| `store/identity.ts` — título de registro fallido | español | ✅ PR #436 |
| `socket/client.ts` — "Contact offline" | inglés | ✅ PR #436 |
| `screens/Chat.tsx` — error al programar | español | ✅ PR #436 |
| `utils/overlayPermission.ts` | español | ✅ PR #436 |

Cortaba en las dos direcciones: un usuario en español recibía **todos** los
errores de llamada y de grupo en inglés o en un español que nadie tradujo, y uno
en inglés veía el cambio de perfil, los programados y el permiso de superposición
en español. Misma clase de bug que la reportada contra la build 15.

**Por qué duró tanto:** los tests de paridad de locales (`i18nKeyParity`,
`localeParity`) comprueban que en/es/it tengan las **mismas claves** — son ciegos
a un módulo que escribe el string en vez de pedir una clave. Tres archivos de
locale en verde junto a cinco pantallas sin traducir es exactamente el tipo de
falsa tranquilidad que esta auditoría venía a quitar.

Ahora hay dos guards en `screensUseI18n.test.ts`: toda pantalla importa el hook
(cero excepciones hoy), y **ningún `themedAlert` en todo `src/` recibe un literal
como primer argumento**. Verificado que no pasa en vacío: contra la revisión
anterior marca exactamente las 9 líneas que el arreglo tocó.

### REL-1 · Los mensajes de grupo no podían tener estado de envío — medio, **cerrado**

Un envío de grupo se abre en un job **por miembro**, cada uno con su `msgId`
aleatorio (`mobile/src/socket/client.ts:4786`), y la burbuja del emisor se añade
con un tercer id sin relación (`:4896`). No hay forma de ir del job a la burbuja.
Por eso A-2 se limitó deliberadamente a 1:1: marcar esos jobs pondría un mensaje
de grupo entero en `failed` porque la entrega a uno de veinte miembros expiró.

**Cerrado en PR #435:** los jobs llevan `bubble_id` (esquema v14), generado una
sola vez antes del fan-out y compartido por todos los miembros. El estado se
agrega: `sent` solo cuando NO queda ningún job de esa burbuja, `failed` en cuanto
caduca el de cualquier miembro. Eso obligó a que `failed` sea **pegajoso** — los
hermanos siguen resolviendo tras el primer fallo, y un `sent` tardío no puede
decirte que sí llegó después de haberte dicho que no. Solo un reintento explícito
lo levanta, y en grupos ese reintento re-hace el fan-out contra el roster ACTUAL.

### PAR-1 · Alcance del desktop — bajo/medio, **abierto** (decisión de producto)

**Corrijo mi propio hallazgo: la mitad grave era falsa.** Lo medí por líneas
(`x3dh.ts` 755 vs 438, −42 %) y escribí que "no es formato, es lógica ausente".
Al comprobarlo contra el código no se sostiene:

| Comprobación | mobile | desktop |
|---|---|---|
| Funciones exportadas en `messaging.ts` / `sealedSender.ts` | 7 / 4 | **7 / 4 — idénticas** |
| ML-KEM (post-cuántico), PQXDH, `shouldUsePqReceiver` | sí | **sí** |
| `encryptMessageV2` / `openEnvelopeV2` (sealed-sender v2) | sí | **sí** |
| `ratchetDecrypt` transaccional (descifra sobre clon) | sí | **sí** (`ratchet.ts:502`) |

La diferencia de líneas es densidad de comentarios y código defensivo, no
capacidad. `cloneState` "faltaba" solo porque en desktop no está exportado — se
usa igual. La única función realmente ausente es `ensureDevicePreKeys`
(aprovisionamiento de prekeys por slot de DB), y es plausible que sea correcto:
el desktop es un dispositivo vinculado, no una identidad primaria.

**Lo que sí queda, y es una decisión de producto, no un bug:** faltan 12
pantallas — los 5 de canales públicos, los 3 de llamadas de grupo, y
`CreateProfile` + `ProfileSwitcher`, es decir **la sección 11 (múltiples
perfiles) no existe en desktop**.

Eso no es deuda técnica que se arregle sola: es *qué quieres que sea el
desktop*. Las dos salidas honestas son (a) paridad completa, con el coste de
portar canales + llamadas de grupo + perfiles, o (b) declararlo cliente reducido
y decirlo donde el usuario lo vea, en vez de dejar que lo descubra buscando una
pestaña que no está. Lo que no se sostiene es el estado actual: paridad
implícita que no existe.

### ARCH-1 · `socket/client.ts` — medio, **abierto** (plan medido, sin ejecutar)

5188 líneas y 59 funciones. Pero al medirlo por función el diagnóstico cambia:
**el problema no es tanto el archivo como una función.**

| Costura | Líneas | Funciones |
|---|---|---|
| **`decryptAndAppendLocked` (una sola función)** | **1332** | 1 |
| `connect` (una sola función) | 569 | 1 |
| Sesiones / ratchet / glare-recovery | 617 | 11 |
| Grupos | 579 | 9 |
| Outbox y envío | 536 | 6 |
| Self-copy multi-dispositivo | 274 | 2 |
| Prekeys / X3DH | 266 | 2 |
| Perfil y contactos | 197 | 5 |
| Mailbox / Tor | 86 | 3 |
| Canales | 60 | 3 |

`decryptAndAppendLocked` es **el 26 % del archivo en una función**: es ahí donde
conviven descifrado, dedup, adopción de sesión, glare, grupos, perfiles y
control-plane, y por eso cada arreglo de entrega toca el mismo sitio y genera el
siguiente. Trocear el archivo sin trocear esa función mueve el problema de sitio.

**Orden propuesto** (ninguno ejecutado; cada paso es mecánico y verificable con
las suites que ya existen):

1. Extraer de `decryptAndAppendLocked` los manejadores por tipo de payload
   (`group_msg`, `profile_update`, control-plane, self-copy) a un módulo
   `socket/incoming/` con una función por tipo y un dispatcher. Es partir por
   `if (type === …)`, no reescribir lógica.
2. Sacar sesiones/glare/recovery a `socket/sessions.ts` — ya tiene frontera
   limpia (`withSessionLock`, `getOrCreateSession`, `tryRecoverDesync`).
3. Sacar el fan-out de grupos a `socket/groupSend.ts`.
4. Dejar en `client.ts` solo transporte y ciclo de vida del socket.

**Precondición, y es la razón de no hacerlo ahora:** el harness E2E cubre hoy
tres escenarios de entrega. Antes de mover 1332 líneas conviene que cubra también
grupos y el camino de mailbox, o el refactor se hace a ciegas sobre justo el
código donde han vivido los últimos seis bugs.

### TEST-1 · Los `catch` de UI, triados — medio, **cerrado**

**Primero, una cifra mía que estaba mal.** Dije 196; salían de un
`grep -c "catch"` que contaba también comentarios y cadenas `.catch(`. Contando
bloques `catch` de verdad en `screens/` son **144**, y el reparto desmonta la
premisa de que fueran un mar de errores tragados:

| Qué hace el `catch` | Nº |
|---|---|
| **Avisa al usuario** (`themedAlert` / `setError`) | **69** |
| Hace algo con el error (fallback, estado) | 37 |
| Solo comentario `/* ignore */` — best-effort declarado | 27 |
| Loguea | 7 |
| **Vacío del todo** | **3** |
| Re-lanza | 1 |

Casi la mitad ya avisa. De los 3 vacíos, dos son best-effort correctos: parsear
unos "recientes" corruptos en `Search.tsx:78` (sin recientes y ya), y liberar la
protección de captura al desmontar en `ViewOnce.tsx:85` (fallar ahí deja la
protección PUESTA, o sea falla hacia el lado seguro).

**El tercero era un fail-open de seguridad**, y justifica el triaje entero:

`LockConfig.tsx:188-203` — el `catch {}` envolvía la comprobación de que el PIN
real **no fuera igual al PIN señuelo**. Si algo dentro lanzaba (blob
`aegis.panic.v1` corrupto, `require` fallido, error de Argon2 en
`verifyPinWithSalt`), se tragaba y la ejecución caía directa a `setPIN(pin)`.
Consecuencia silenciosa y grave: **el PIN que entregas bajo coacción abriría la
cuenta real en vez del señuelo**, y nadie te avisa de que el guard no llegó a
correr. Viola la regla de oro #6.

Arreglado para **fallar cerrado**: si no se puede *demostrar* que los dos PIN
difieren, no se guarda ninguno y se muestra el error. Dos tests de regresión
(verify que lanza, y blob corrupto) que comprueban que `setPIN` no se llama.

La mayor concentración de tragado de errores está en la capa de UI. Hay que
clasificar cada uno en: legítimo best-effort, **debe avisar al usuario**, o
**debe fallar cerrado**.

### TEST-2 · La única prueba end-to-end de la app real llevaba tiempo en rojo — medio, **cerrado**

El job `mobile-e2e` (Maestro sobre emulador Android) está marcado
`continue-on-error: true` en `.github/workflows/ci.yml`, así que su resultado
**nunca ha bloqueado un merge**. Comprobado en la ejecución 31301655118 (PR #431,
que solo añade un markdown — no toca código de app):

- `01-launch-smoke` ✅ — la app compila, arranca y pinta la bienvenida.
- `02-onboarding` ❌ — **falla tras 11 min 5 s**: se genera la identidad y nunca
  se llega a la UI principal.

Que falle en un PR de solo-documentación descarta que lo rompa el cambio: está
roto de base.

**RESUELTO — y mi diagnóstico intermedio era falso.** Vale la pena dejar las dos
versiones porque el error es instructivo:

1. Primera sospecha: el minado PoW en hardware débil.
2. La descarté sobre los tiempos: el fallo llegaba a los **664 s** cuando los
   timeouts del flow suman **150 s**, y Maestro reportaba `Unknown error` en vez
   de aserción fallida. Concluí "cuelgue del driver, no la app". Escribí eso aquí
   como si fuera la conclusión.
3. **La causa real era la 1, y el cuelgue del driver era su consecuencia.** Al
   arreglar TEST-3 (dejar de apuntar a producción) el E2E pasó a verde. La
   jerarquía UI capturada lo dice literalmente:
   `[fetchPowChallenge] TypeError: Network request failed`. La app se bloqueaba
   pidiendo el challenge al relay de producción y minando PoW a dificultad 18 en
   JS puro sobre un emulador lento; eso desbordaba la ventana y arrastraba al
   driver.

Resultado tras el arreglo (ejecución 31328814361):

| Flow | Antes | Ahora |
|---|---|---|
| `01-launch-smoke` | ✅ 16,8 s | ✅ 19,3 s |
| `02-onboarding` | ❌ 664 s, `Unknown error` | ✅ **14,9 s** |
| Suite | 1 de 2 fallando | **2/2, 0 fallos, 34 s** |

Lección que sí se sostiene: **el único test que ejercita la app compilada de
principio a fin llevaba tiempo rojo y nadie estaba obligado a mirarlo** — por eso
sobrevivió tanto. Siguiente paso natural, ahora que pasa: quitarle el
`continue-on-error` para que vuelva a ser señal de verdad.

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
2. **TEST-2** — ✅ cerrado: era el PoW contra producción, y se fue con TEST-3.
   Pendiente el remate: quitarle el `continue-on-error` ahora que pasa en 34 s,
   para que vuelva a ser una señal que bloquea.
3. **I18N-1** — ✅ cerrado en PR #436: llamadas, las 5 pantallas sin i18n, y 9
   alertas más en stores/socket/componentes que el primer barrido no vio.
4. **REL-1** — ✅ cerrado en PR #435.
5. **TEST-1** — ✅ cerrado: 144 `catch` (no 196), 69 ya avisaban, y el único
   problema real era un fail-open del guard de PIN señuelo. **ARCH-1** sigue
   abierto y es el que más reduciría la tasa de bugs futuros.
6. **PAR-1** — el desktop necesita decisión de producto antes que código
   (¿paridad completa, o desktop declarado como cliente reducido?).
7. **DOC-1** — ✅ cerrado en esta pasada.
