# AegisLink — Sealed-Sender en el transporte (épica A-6+)

> Estado: **PROPUESTA DE DISEÑO** — requiere aprobación antes de implementar.
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

- **Fase 0 — spike.** Implementar el sobre sealed (epk + firma interna) y el
  evento de envío con delivery-token en el relay, detrás de flag, sin tocar el
  path vivo. Validar round-trip 1:1 y medir latencia (incl. llamada).
- **Fase 1 — envelopes 1:1 sealed.** Activar v2 para chat 1:1; `from` fuera del
  wire. Reparto de delivery-token en el handshake X3DH.
- **Fase 2 — llamadas sealed.** Migrar `call:*`; retirar `from: me` de
  `forward()`. Vigilar latencia de ring/ICE.
- **Fase 3 — grupos.** Fan-out de SenderKey con sobres sealed por miembro.
- **Fase 4 — ocultar `to` (mailbox IDs, §3.4).** Registro de mailboxes, auth de
  socket por mailbox, reparto del mapeo por X3DH, rotación por época. Es la
  segunda mitad y el cambio de plumbing más profundo; va después de que ocultar
  `from` esté estable.
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
