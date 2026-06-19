# AegisLink — Sealed-Sender / Metadata-Minimal Transport (épica A-6+)

> Estado: **PROPUESTA DE DISEÑO** — requiere aprobación antes de implementar.
> Origen: auditoría profunda 2026-06, hallazgo A-6 (el relay ve `from→to` en
> signaling de llamadas). Al investigarlo se confirmó que el leak está **a la
> par de los envelopes de chat** (handler.ts:572 estampa `from: me` igual), así
> que el problema no es de llamadas — es del **modelo de transporte completo**.

## 1. El problema real

El relay autentica **cada socket** como un `aegisId` (challenge-response Ed25519)
y luego rutea por ese `aegisId`. Tanto los envelopes de chat como el signaling
de llamadas viajan por ese socket autenticado. Consecuencia:

- El proceso vivo del relay conoce la arista `emisor→receptor` de **cada**
  mensaje y llamada, porque sabe qué socket (=`aegisId`) la emitió.
- Hoy NO se persiste esa arista en disco (FND-05) ni se loguea → "sealed-sender
  **at rest**". Pero un relay comprometido en caliente, un `tcpdump` en el host,
  o un parche malicioso, reconstruyen el grafo social en tiempo real.

El contenido (SDP, ICE, cuerpo de mensaje) ya está sellado E2EE y **eso está
bien**. Lo que falta es ocultar **quién habla con quién** del propio relay.

## 2. Cómo lo resuelven los referentes

### Session — onion routing sobre red de nodos
Tres Service Nodes aleatorios; ningún nodo conoce origen y destino a la vez.
Requiere una **red descentralizada** de nodos con incentivo cripto-económico
(Oxen). **No adoptable** por un relay único self-hosted sin construir esa red.
Lo único portable barato: poner el relay tras Tor (oculta IP, no la arista).
Ref: <https://getsession.org/blog/onion-requests-session-new-message-routing-solution>

### SimpleX — cero identidad en el transporte (RECOMENDADO)
No existe "cuenta" a nivel de servidor. Cada par de contactos usa **colas
unidireccionales**; el servidor genera por cola **dos IDs aleatorios distintos**
(recipient ID y sender ID) y autentica **por cola** con claves efímeras, no por
usuario. El servidor no puede correlacionar colas de un mismo usuario ni
construir el grafo social, ni siquiera con la DB comprometida.
Ref: <https://github.com/simplex-chat/simplexmq/blob/master/protocol/simplex-messaging.md>

**SimpleX es el modelo correcto a copiar** porque encaja en un relay único: es un
rediseño de *direccionamiento*, no de *red*.

## 3. Modelo objetivo (SimpleX-style) aplicado a AegisLink

| Hoy (aegisId-addressed) | Objetivo (queue-addressed) |
|---|---|
| Socket autenticado como `aegisId` global | Sockets **sin identidad**; se autentica por-cola con la SK de esa cola |
| Envelope `{ to: aegisId, ... }`, relay estampa `from: me` | Envelope `{ queueId, ... }`; **no hay `from`** — el relay no lo conoce |
| `aegisId` es el identificador a compartir | Cada contacto se establece con un **invite link out-of-band** (queueId + claves), no un ID global reusable |
| Cola offline keyed por `recipient aegisId` | Cola offline = la propia cola (recipientId), sin dato de emisor |
| Prekeys X3DH por `aegisId+deviceId` | El bootstrap de cola transporta las claves iniciales (sigue siendo X3DH/PQXDH dentro) |
| Push FCM por `aegisId` | **Notifier separado** con token por-cola; el SMP server avisa al notifier sin saber el usuario |
| Grupos: fan-out por `aegisId` de cada miembro | Fan-out por **cola de cada miembro** (SenderKey sigue igual dentro) |
| Llamadas: signaling por `aegisId` | Signaling por la cola del callee (misma infra; latencia a vigilar) |

Propiedad ganada: **el relay no puede construir el grafo social ni en caliente
ni en disco**. Iguala a SimpleX; supera a Signal sealed-sender (que aún ata la
subida a un delivery token derivado del perfil del destinatario).

## 4. Lo que rompe / hay que rehacer (honestidad de alcance)

1. **Identidad y onboarding** — `aegisId` deja de ser la dirección de ruteo.
   Sigue existiendo como *fingerprint de identidad E2EE* (para verificación de
   seguridad), pero el contacto se inicia con invite link. Cambio de UX grande.
2. **Multi-device** — hoy un `aegisId` hace fan-out a todos los sockets. Con
   colas, cada device necesita su suscripción; el self-send y el drain multi-
   device (handler.ts) se rehacen. Relaciona con el gap de `devicesRepo.upsert`
   ya detectado en Ola 3.
3. **Push wake-up** — `notifyRecipient(aegisId)` / `sendCallWakeUp(aegisId)` se
   reemplazan por un **servicio notifier** con tokens por-cola. Es el punto más
   delicado: FCM/APNs necesitan *algún* token destino; SimpleX lo aísla en un
   ntf server separado para que el SMP server no vea (cola↔token-de-push).
4. **Rate-limiting** — hoy por `aegisId`/socket (`checkCallOfferRateLimit(me)`,
   `makeEnvelopeLimiter`). Pasa a ser **por-cola** + PoW en creación de cola.
5. **Llamadas en tiempo real** — el signaling por cola añade latencia frente al
   `socket.emit` directo actual. Hay que medir; SimpleX añadió llamadas sobre
   la misma infra, es viable, pero el ring/ICE trickle es sensible.
6. **Grupos** — el roster-por-referencia y SenderKey siguen, pero el transporte
   de cada copia sellada pasa por la cola del miembro.

## 5. Fases propuestas (cada una = rama `feat/*`, mergeable, sin romper lo vivo)

El objetivo es migrar **sin** un big-bang. Las colas conviven con el ruteo por
`aegisId` detrás de un flag de protocolo (`transport: 'v1-aegis' | 'v2-queue'`),
igual que se hizo con PQXDH v1/v2.

- **Fase 0 — spike/medición.** Prototipo de cola SMP-style (crear cola, SEND
  autorizado por SK, recibir) en el relay + cliente, detrás de flag, sin tocar
  el path vivo. Medir latencia de llamada sobre cola. Criterio de go/no-go.
- **Fase 1 — colas para envelopes 1:1.** Direccionamiento por queueId,
  invite-link bootstrap, drain offline por cola. `from` desaparece del wire.
- **Fase 2 — notifier server.** Servicio de push por-cola; retirar
  `notifyRecipient(aegisId)`.
- **Fase 3 — multi-device sobre colas.** Suscripción por device; rehacer
  self-send/drain.
- **Fase 4 — llamadas sobre colas.** Migrar `call:*` al transporte v2; retirar
  el `from: me` de `forward()` (handler.ts:1520).
- **Fase 5 — grupos sobre colas.** Fan-out de SenderKey por cola.
- **Fase 6 — retirar v1.** Una vez todos los clientes en v2, eliminar el ruteo
  por `aegisId` y el campo `from` del código.

## 6. Mitigación puente (mientras llega la Fase 4)

Sin esperar la épica completa, las llamadas pueden igualar a los envelopes y
cerrar el leak **a nivel payload** con bajo riesgo (esto era el "fix contenido"
descartado a favor de la épica, pero sigue siendo válido como puente):

- Cliente sella el signaling con una **clave efímera por mensaje** y mete
  `from` + firma Ed25519 **dentro** del box (autenticidad al receptor, opacidad
  al relay).
- Relay deja de estampar `from: me` en `forward()`; rutea solo por `to`.
- No oculta el emisor del proceso vivo (sigue llegando por el socket de `me`),
  pero quita la arista del payload entregado y de la cola en memoria.

> Decisión 2026-06-19: el usuario eligió la **épica completa estilo SimpleX**
> (Fase 0→6), no el puente. Este doc es el punto de partida; la Fase 0 (spike +
> medición de latencia de llamada sobre cola) es el siguiente entregable y su
> resultado decide si se continúa o se cae al puente de §6.

## 7. Referencias
- SimpleX SMP protocol: <https://github.com/simplex-chat/simplexmq/blob/master/protocol/simplex-messaging.md>
- SimpleX overview: <https://github.com/simplex-chat/simplexmq/blob/master/protocol/overview-tjr.md>
- Session onion requests: <https://getsession.org/blog/onion-requests-session-new-message-routing-solution>
- Signal sealed sender (comparación): <https://signal.org/blog/sealed-sender/>
