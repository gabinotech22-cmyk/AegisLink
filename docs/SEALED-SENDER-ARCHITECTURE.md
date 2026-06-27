# AegisLink — Sealed-Sender en el transporte (épica A-6+)

> Estado: **IMPLEMENTADO** — ya NO es una propuesta. Ocultar `from` (Fases 1–3)
> está **habilitado por defecto**; ocultar `to` (Fase 4, mailbox IDs + Tor
> embebido #171/#172) está implementado tras flag. Ver el detalle de fases en §5.
> Origen: auditoría profunda 2026-06, hallazgo A-6 (el relay ve `from→to` en
> signaling de llamadas). Al investigarlo se confirmó que el leak está **a la
> par de los envelopes de chat** (handler.ts:572), así que el problema no es de
> llamadas — es del **transporte completo**.

## 0. Restricción de marca (NO NEGOCIABLE)

**`aegisId` y el onboarding se mantienen.** Son la marca de AegisLink: registro
anónimo en 3 pasos, identidad criptográfica generada en dispositivo, un `aegisId`
legible (`XXX-XXXX-XXXX`) que el usuario comparte y verifica. Cualquier diseño
que reemplace el `aegisId` por invite-links por-contacto (modelo SimpleX) queda
**descartado**. El objetivo es ocultar el grafo social del relay **sin** tocar
la identidad ni el flujo de alta.

## 1. El problema real

El relay autentica **cada socket** como un `aegisId` (challenge-response Ed25519)
y rutea por él. Tanto los envelopes de chat como el signaling de llamadas viajan
por ese socket autenticado. Consecuencia:

- El proceso vivo del relay conoce la arista `emisor→receptor` de **cada**
  mensaje y llamada, porque sabe qué socket (=`aegisId`) la emitió.
- Hoy NO se persiste esa arista en disco (FND-05) ni se loguea → "sealed-sender
  **at rest**". Pero un relay comprometido en caliente, un `tcpdump`, o un parche
  malicioso, reconstruyen el grafo social en tiempo real.

El contenido (SDP, ICE, cuerpo) ya está sellado E2EE — eso está bien. Falta
ocultar **quién habla con quién** del propio relay.

## 2. Modelos de referencia (regla de oro #12)

| Modelo | Cómo oculta al emisor | ¿Encaja con aegisId + relay único? |
|---|---|---|
| **Session** | Onion routing sobre red de Service Nodes; ningún nodo ve ambos extremos | ❌ Necesita una red descentralizada de nodos. No para un relay único. |
| **SimpleX** | Sin identidad de transporte: colas por-contacto, IDs separados emisor/receptor | ❌ Descarta el identificador global → **choca con la marca aegisId** |
| **Signal sealed-sender** | Submission **sin autenticar** + delivery token (anti-abuso) + sender certificate sellado dentro del sobre | ✅ **Conserva la identidad (aegisId) y el onboarding** |

**Decisión: adoptar el modelo Signal sealed-sender**, adaptado a que AegisLink
ya tiene claves de identidad Ed25519 por contacto (no hace falta una CA externa).
Refs: [Signal sealed sender](https://signal.org/blog/sealed-sender/) ·
[SimpleX SMP](https://github.com/simplex-chat/simplexmq/blob/master/protocol/simplex-messaging.md)
(estudiado y descartado por marca).

## 3. Modelo objetivo (Signal-style, conservando aegisId)

Idea central: **el `aegisId` del emisor nunca se presenta al relay**. El relay
solo necesita el `to` para rutear; el `from` viaja **cifrado dentro del sobre**
y se autentica contra el destinatario, no contra el relay.

### 3.1 Identidad del emisor sellada (sender assertion)
AegisLink ya intercambia claves de firma Ed25519 entre contactos (X3DH /
verificación de seguridad). El emisor mete dentro del sobre sellado:
```
inner = { from: aegisId, payload, ts }
sig   = Ed25519_sign(inner, mi_signing_secret)
```
El destinatario abre el sobre, lee `from`, y **verifica `sig` con la signing
pubkey que ya tiene de ese contacto**. Si no es contacto conocido → se descarta.
No se necesita certificado emitido por el relay: la confianza ya existe entre
contactos. (Signal usa un cert del servidor porque allí los desconocidos pueden
escribirte; en AegisLink el sealed-sender se restringe a contactos.)

### 3.2 Sellado opaco al relay (clave efímera)
Para que el relay no pueda atar el sobre a la clave estática del emisor, el
sobre se sella con una **clave efímera por-mensaje**:
```
epk        = nacl.box.keyPair()              // efímera, descartable
ciphertext = nacl.box(inner+sig, nonce, recipientPub, epk.secret)
wire       = { to, ciphertext, nonce, epk: epk.public }   // SIN from
```
El destinatario abre con `nacl.box.open(ciphertext, nonce, epk, mi_secret)`.
El relay solo ve `{ to, ciphertext, nonce, epk }` — `epk` es basura aleatoria
no vinculable a nadie.

### 3.3 Submission sin autenticar + delivery token (anti-abuso)
Hoy el socket está atado a `me` y por eso el relay sabe quién envía. El cambio
de fondo: permitir **enviar sin que el socket revele identidad**, controlando
abuso con un **delivery token** del destinatario (análogo Signal):

- Cada usuario registra en el relay un `deliveryToken` (96+ bits aleatorios) y
  lo entrega a sus contactos durante el handshake X3DH (dentro del canal E2EE).
- Para enviar sealed a `B`, el emisor presenta el `deliveryToken(B)` — prueba
  que es un contacto autorizado **sin** revelar quién es.
- El relay valida token→`to` y rutea. No aprende `from`.
- Tokens rotables; revocar un contacto = rotar token y re-repartir a los demás.

> Nota multi-device/conexión: el emisor puede mantener su socket autenticado
> para **recibir** (el relay necesita saber a quién entregar), pero **enviar**
> por un canal sealed que no ata el envío a esa identidad. Separar los dos roles
> (recibir=autenticado por aegisId · enviar=sealed con token) es el corazón del
> diseño. La correlación temporal socket-activo↔envío se mitiga con cover/jitter
> en fases posteriores; el grafo explícito desaparece ya en la Fase 1.

### 3.4 Ocultar también al destinatario (`to`) — mailbox IDs ciegos
El §3.1–3.3 oculta el `from`. Pero el relay aún ve `to` (necesita una dirección
para entregar) y `notifyRecipient(to)` lo expone al push. Para ocultar también
el destinatario **sin reemplazar el aegisId** (a diferencia de SimpleX), se
añade una capa de direccionamiento opaca **encima** de la identidad:

- El `aegisId` sigue siendo la identidad/marca (verificación, onboarding, lo que
  el usuario comparte). **No se toca.**
- Por debajo, el cliente registra en el relay uno o varios **mailbox IDs**
  aleatorios (128-bit) con una clave propia por mailbox. El relay rutea por
  mailbox y **nunca recibe el aegisId** — en ningún evento, ni en el auth.
- El mapeo `aegisId ↔ mailbox(es)` se comparte con cada contacto **cifrado E2EE**
  en el handshake X3DH (mismo canal que el delivery token). El emisor direcciona
  al `mailbox`, no al `aegisId`.
- Los mailbox IDs **rotan por época** (p.ej. diario); los nuevos se reparten por
  el canal E2EE existente. El relay no puede construir un grafo estable.

Resultado: el relay solo ve `{ mailboxTo, ciphertext, nonce, epk }` — **ni
`from` ni `to` reales**. Grafo social = cero.

**Lo que esto cambia (plumbing, NO marca):**
1. **Auth del socket receptor**: hoy es "soy aegisId X" (challenge Ed25519). Pasa
   a "poseo el mailbox X" (prueba de la clave del mailbox). El `aegisId` deja de
   enviarse al relay en cualquier punto. La identidad de cara al usuario no
   cambia; cambia cómo el socket prueba a quién entregar.
2. **Push**: el relay mapea `mailbox → push token` sin aegisId. Pero FCM/APNs
   siguen viendo el dispositivo físico → para ocultarlo del proveedor hace falta
   push self-hosted (UnifiedPush/ntfy) opcional o un notifier separado (SimpleX).

**Límite irreducible:** el relay sabe "el mailbox X está conectado en esta
conexión ahora mismo". Con rotación + un socket por mailbox no puede relinkear
entre épocas, pero la correlación temporal y el proveedor de push son los
últimos reductos (mismo límite que SimpleX/Signal).

## 4. Qué cambia (alcance — mucho menor que el rewrite SimpleX)

Lo que **NO** cambia: `aegisId`, onboarding, generación de identidad,
verificación de seguridad, X3DH/PQXDH, SenderKey de grupos, UI. ✅

Lo que cambia:
1. **Endpoint/evento de envío sealed** en el relay: acepta `{to, ciphertext,
   nonce, epk, deliveryToken}` sin auth de emisor; valida token; rutea por `to`.
2. **`forward()` y el handler de `envelope`** dejan de estampar `from: me`
   (handler.ts:572, 1520). El `from` pasa a vivir dentro del sobre.
3. **Cliente**: sellar con clave efímera + firma interna; abrir leyendo `from`
   del interior; registrar/rotar `deliveryToken`; repartir token a contactos en
   el handshake.
4. **Cola offline**: ya hoy no guarda `from` (FND-05); encaja sin cambio mayor.
5. **Push wake-up**: `notifyRecipient(to)` sigue funcionando — se direcciona al
   destinatario, que no es secreto. Sin cambio de arquitectura de notifier.
6. **Rate-limit**: pasa de por-emisor a **por delivery-token + PoW** en envío.
7. **(Para ocultar `to`, §3.4)** Registro de **mailbox IDs** + clave por mailbox;
   **auth del socket por mailbox** en vez de aegisId; reparto del mapeo
   `aegisId↔mailbox` por X3DH; rotación por época. Esto es el cambio de plumbing
   más profundo — la identidad de usuario no cambia, pero el relay deja de ver
   el aegisId en cualquier punto. **Opcional/posterior**: ocultar `from` (§3.1–3.3)
   ya es una mejora enorme por sí solo; ocultar `to` es la segunda mitad.

## 5. Fases (cada una = rama, mergeable, detrás de flag `sealed: v1|v2`)

- **Fase 0 — spike. ✅ HECHO (2026-06-19, PR #50).** Sobre sealed (epk + firma
  interna) + delivery-token en `server/src/crypto/`, aislado del path vivo, con
  11 tests (correctitud, autenticación, anti-forja, anti-replay, benchmark).
  **Resultados / go-no-go = GO con amortización:**
  - Seal asimétrico fresco **por mensaje** = ~4.3× un `nacl.box` plano (clave
    efímera + firma Ed25519 + verify). En Hermes (~60× más lento que Node) eso
    es demasiado caro para el trickle de ICE (muchos mensajes pequeños/llamada).
  - **Mitigación validada:** un handshake sealed-sender **por llamada** lleva una
    clave de sesión aleatoria; cada candidato ICE se sella con `nacl.secretbox`
    simétrico bajo esa clave → ~0.021 ms/candidato (vs 144 ms naïve). Negligible.
  - **Regla para Fases siguientes:** envelopes de chat (poco frecuentes) → seal
    por mensaje directo. Señalización de llamada (alta frecuencia) → seal por
    sesión + secretbox por candidato.
- **Fase 1 — envelopes 1:1 sealed. ✅ HABILITADO POR DEFECTO.** `envelope:v2`
  (sin `from`, gated por delivery-token del destinatario) + selector v1/v2 +
  reparto del delivery-token en el `profile_update` E2EE, en server+mobile+desktop.
  Estuvo construido pero tras `SEALED_TRANSPORT_VERSION=v1`; el default se volteó a
  **v2** (con fallback v1 por-contacto intacto). Test de regresión fija el default.
- **Fase 2 — llamadas sealed. ✅ HABILITADO POR DEFECTO.** `call:*:v2` con `epk`
  por llamada + secretbox por candidato ICE bajo la clave de sesión (regla de
  amortización de Fase 0); gateado en el mismo flag, mobile+desktop.
- **Fase 3 — grupos. ✅ HABILITADO POR DEFECTO.** El fan-out de grupo rutea por el
  selector compartido `buildOutgoingEnvelope`, así que un envío de grupo oculta el
  `from` igual que un 1:1.
- **Fase 4 — ocultar `to` (mailbox IDs, §3.4). 🟢 IMPLEMENTADO tras flag OFF — Slices 1, 2, 3a, 3b, 4, 5, 6 hechas y testeadas; transporte Tor embebido shipped (#171/#172). Pendiente para cerrarla del todo: 2b=push por mailbox (vive en Fase 5), validación en vivo 2-dispositivos y flip del flag a ON.** (El antiguo bloque "PENDIENTE (el grueso, XL)" de más abajo describía trabajo que estas slices YA cubren — prueba: `server/src/__tests__/mailboxAuth.relay.test.ts`.)
  **Slice 1 ✅ (server):** auth de socket por mailbox — handshake `{mailboxId,
  mailboxSignPubKey}` sin aegisId → challenge random → possession proof Ed25519 →
  el relay verifica Y recomputa `id=SHA256(pubkey)[0:16]` (binding anti-hijack) →
  bind a `mailboxSockets`; + entrega online de `envelope:mb` (sin identidad de
  emisor). `server/src/crypto/mailbox.ts` + tests de relay.
  **Slice 2 ✅ (server):** cola offline + drain por mailbox reusando `messageRepo`
  (recipient=mailboxId, sin tabla nueva, sin sender almacenado; hard-delete al
  drenar).
  **Slice 3a ✅ (cliente, mobile):** store del root del cliente
  (`mobile/src/crypto/mailboxStore.ts`, +6 tests): root propio en SecureStore +
  roots de contactos por-contacto + derivación del mailbox de la época. Espeja
  `deliveryToken.ts`. Foundation, off the live path.
  **Slice 3b ✅ (cliente, mobile):** reparto del root por `profile_update` E2EE —
  `mailboxRoot` viaja junto al `deliveryToken` (pre-distribución bajo v2, idéntico
  patrón) y el receptor lo persiste vía `setContactMailboxRoot`. Aditivo: nada del
  transporte cambia aún. La validación en vivo del wiring (3b→) es el test APK
  2-dispositivos, no automatizable aquí.
  **Slice 4 ✅ (cliente, mobile, flag OFF):** direccionar por mailbox — Opción A
  + Tor obligatorio (ver `FASE4-CONTROL-PLANE-DESIGN.md`). **4a:** socket de
  entrega dedicado (`mobile/src/socket/mailboxSocket.ts`, +6 tests) — conexión
  Socket.IO aparte, auth por prueba de posesión del mailbox, solo `envelope:mb`
  (enviar+recibir); fail-closed sin Tor (`MAILBOX_ENABLED = MAILBOX_MODE &&
  ONION_URL`). **4b:** cableado en `client.ts` — al conectar se abre el socket
  mailbox (recepción reusa `handleIncomingV2`); el envío 1:1 rutea el wire v2 por
  `sendViaMailbox` cuando hay root del contacto + socket autenticado, con fallback
  robusto al transporte aegisId. El control-plane (prekeys/push/token/perfil)
  sigue intacto en el socket aegisId. Validación en vivo = test APK 2-dispositivos.
  Limitación conocida: el `envelope:mb` aún no lleva TTL efímero → esos mensajes
  caen al transporte aegisId (Slice 5 extiende el schema).
  **Slice 6 ✅ (paridad desktop, flag OFF):** port 1:1 a `desktop/src/renderer/`
  — `crypto/mailbox.ts` (copia **verbatim** del primitivo; la derivación id/firma
  DEBE ser byte-idéntica entre plataformas), `crypto/mailboxStore.ts` (swap
  `expo-secure-store`→`window.aegis.secureStorage`, espeja `deliveryToken.ts`),
  `config.ts` (mismo flag fail-closed `MAILBOX_ENABLED = MAILBOX_MODE &&
  ONION_URL`), `socket/mailboxSocket.ts`, y cableado en `socket/client.ts`
  (connect/disconnect, reparto del root por los dos `profile_update`, persistir
  root entrante, ruteo de envío con fallback robusto). Mismo wire protocol y
  mismos guards que mobile. **Garantía de paridad:** un **known-answer vector
  cross-plataforma** (root fijo `0x01..0x20`, época 20600 → `+S61uhsiRrHvLHcFZSv/1A==`)
  asertado en AMBAS suites (`mailbox.test.ts` mobile + desktop): si la derivación
  de una plataforma deriva (hash/slice/base64/HKDF-info/encoding de época), uno de
  los dos tests rompe — atrapa un split silencioso de entrega mobile↔desktop. tsc
  limpio en ambos; desktop 105/105, mobile mailbox 13/13. Cobertura de los wrappers
  que tocan `window.aegis` (store/socket) queda diferida al harness jsdom+preload
  inexistente — misma postura que `deliveryToken.ts` (sin test desktop tampoco).
  **Slice 5 ✅ (TTL efímero + rotación de época en vivo, flag OFF):** **5a:** el
  `envelope:mb` lleva un `ephemeralTtl` opcional que acota SOLO la vida de la cola
  offline (`expires_at = createdAt+ttl`, igual que el path aegisId); el receptor
  quema desde el payload descifrado, así que la entrega online no lleva el campo
  (cero metadatos nuevos en el wire). Los efímeros ya no caen a aegisId. **5b:**
  rotación de época reconciliada con la cola de 30 días vía **multi-bind con
  multi-firma en un solo handshake** (Opción 1, decidida con 👤): el cliente, al
  conectar, bindea su época actual + las épocas de catch-up desde su última
  conexión (cap 31 = `MAX_MAILBOX_BINDS`−1) + la previa (gracia de skew de reloj),
  firmando el MISMO challenge con la clave de cada época (bindear un id cuyo root
  no posees es imposible). Rotación viva = **reconectar tras cada boundary** (timer
  `scheduleEpochRotation`), que re-deriva la época y estrena circuito Tor (el relay
  no liga épocas consecutivas a un circuito). `lastConnectEpoch` persistido en el
  store. Tests: server `mailboxAuth.relay` 8/8 (incl. catch-up de época pasada,
  rechazo de hijack/falta-de-prueba en extra-binds), mobile `mailboxSocket` 7/7
  (incl. binds de catch-up + multi-firma); server 184/184, desktop 105/105.
  Límite honesto del catch-up: drenar una cola de época pasada exige revelar al
  relay (vía Tor, sin identidad) que ese id es tuyo → liga las épocas que drenas en
  ese tramo; es inevitable dado el modelo de cola y solo afecta a la ventana de
  recuperación offline, no al estado estable diario.
  Slices restantes: 2b=push por mailbox (Fase 5) — diseño en
  `docs/FASE4-SLICE2B-PUSH-DESIGN.md` (decisión: UnifiedPush/ntfy self-hosted con
  topic por época sobre Tor; FCM/APNs sólo como fallback opt-in tras flag).
  Histórico del spike inicial debajo.
  Primitivo aislado en `mobile/src/crypto/mailbox.ts` (+10 tests, off the live
  path, estilo Fase 0): derivación **determinista por época** del mailbox desde un
  root compartido una vez por X3DH (`mailbox(epoch)=HKDF(root,epoch)` → rotación
  silenciosa sin re-reparto) + prueba de posesión Ed25519 para el auth del socket.
  **✅ HECHO (lo que este bloque listaba como "el grueso, XL"):** auth de socket
  por mailbox en el relay (ya no se envía el aegisId), routing por mailbox, reparto
  del root por X3DH, manejo de rotación/solapamiento de época en vivo (multi-bind
  multi-firma) y paridad desktop+server — todo implementado en las Slices 1–6 y
  testeado (`server/src/__tests__/mailboxAuth.relay.test.ts` 8/8, mobile
  `mailboxSocket` 7/7, known-answer vector cross-plataforma en `mailbox.test.ts`).
  Único resto: el mapping `mailbox→push` (Slice 2b), que vive en Fase 5. Era el
  cambio de plumbing más profundo y fue después de estabilizar ocultar `from` (✅).
- **Fase 5 — anti-correlación + push.** Cover traffic / jitter; notifier
  separado o push self-hosted (UnifiedPush/ntfy) para cortar el último reducto.
- **Fase 6 — retirar v1.** Cuando todos los clientes estén en v2, eliminar el
  estampado de `from`/`to` y el envío autenticado-por-emisor del código.

## 6. Límite honesto

Este modelo elimina el **grafo social explícito** del relay (no hay `from` en
ningún punto que el relay procese o almacene). Lo que NO elimina por sí solo es
la **correlación temporal**: si el socket de A está activo y justo después
aparece un envío a B, un observador del proceso podría inferir A→B. Signal vive
con ese mismo límite; cerrarlo del todo requiere cover traffic (Fase 4) u onion
routing (Session, fuera de alcance). Es una mejora enorme sobre el estado actual
(arista explícita en cada mensaje) sin sacrificar la marca.

## 7. Referencias
- Signal sealed sender: <https://signal.org/blog/sealed-sender/>
- Mejoras al sealed sender (delivery tokens, NDSS'21): <https://www.cs.umd.edu/~kaptchuk/publications/ndss21.pdf>
- SimpleX SMP (estudiado, descartado por marca): <https://github.com/simplex-chat/simplexmq/blob/master/protocol/simplex-messaging.md>
- Session onion routing (fuera de alcance): <https://getsession.org/blog/onion-requests-session-new-message-routing-solution>
