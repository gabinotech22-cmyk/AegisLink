# Fase 4 — Sealed-sender para señalización de llamadas (1:1 v1 + grupo)

> **Estado:** **Fase A ✅ HECHA** (clientes sellados-only, fail-closed, paridad
> mobile↔desktop + tests de regresión — ver §8). Fases B (group calls v2) y C
> (drop v1 en el relay) **pendientes**. Deriva del hallazgo #2 de la auditoría
> interna 2026-06 y de la regla de oro de seguridad **#4** ("Sealed-sender en
> TODO, incluidas las llamadas"). Ver `docs/SECURITY-ROADMAP-2026-06.md`,
> `docs/SEALED-SENDER-ARCHITECTURE.md` y `CLAUDE.md`.

## 1. Contexto y estado actual

La señalización WebRTC (SDP/ICE) se enruta por el relay Socket.IO. El **contenido**
de la señalización (SDP/ICE) ya viaja **cifrado** contra la pubkey del destinatario;
el relay nunca parsea ni almacena SDP/ICE (`server/src/relay/handler.ts:1707-1711`).

El problema es **quién** llama a **quién**: el relay todavía estampa la identidad del
emisor en el wire para parte de los flujos, dándole el **grafo de llamadas** (metadatos)
aunque no vea el contenido. Esto viola "cero metadatos" + regla #4.

### Qué ya está sellado (sin fuga)

- **Llamadas 1:1 v2**: `call:invite:v2` / `call:answer:v2` / `call:ice:v2` usan
  `forwardSealed()` (`handler.ts:1961-1975`), que enruta por `to` y **NUNCA** estampa
  `from`. La identidad del emisor va sellada dentro del ciphertext (esquema
  `SealedSignalV2` con `epk`, `handler.ts:1779-1782`) y solo la recupera el callee.

### Qué todavía filtra `from: me` al relay

| Flujo | Ubicación | Mecanismo |
|-------|-----------|-----------|
| Llamadas 1:1 **v1** (`call:invite`/`answer`/`ice`) | `handler.ts:1954`, via `forward()` | estampa `{ ...rest, from: me }` |
| **Group calls** (`group_call:offer`/`answer`/`ice`) | `handler.ts:2169, 2178` (fan-out `fwd`/`fanout`) | estampa `from: me` |
| `queueCallInvite` (invite offline 1:1 v1) | `handler.ts:2001` | persiste `from: me` en memoria |

El propio código lo documenta como trabajo **"Fase 4+"** (`handler.ts:1710-1711`):
> *"Signaling currently includes `from` so the recipient knows who's calling
> (sealed call signaling is Fase 4+)."*

## 2. Modelo de amenaza

- **Adversario:** el relay (honest-but-curious) o quien comprometa su proceso/logs.
- **Lo que NO debe aprender:** el grafo de llamadas — qué `aegisId` llama/conferencia
  con qué `aegisId(s)`, ni siquiera para 1:1 v1 ni para grupos.
- **Lo que el relay SÍ ve inevitablemente (fuera de alcance aquí):** el `to` de routing
  (necesario para entregar). Mitigar el `to` requiere el transporte mailbox (Fase 4
  Tier 2), ya en curso, y es ortogonal a este diseño.

## 3. Objetivo y no-objetivos

**Objetivo:** eliminar todo campo `from` visible al relay en señalización de llamadas
1:1 y de grupo, llevando ambos al patrón sealed-sender que ya usa 1:1 v2. La identidad
del emisor se sella **dentro** del payload cifrado; el receptor la recupera y la
**verifica criptográficamente** (igual que mensajes sealed-sender v2 y que la
distribución de SenderKey de grupo Phase 3b en `mobile/src/crypto/channelKey.ts`).

**No-objetivos:**
- Ocultar el `to` de routing al relay (eso es el transporte mailbox, otra pieza).
- Cambiar el cifrado del contenido SDP/ICE (ya está cifrado contra la pubkey del callee).
- Rediseñar el establecimiento de claves de la llamada (DTLS-SRTP sigue igual).

## 4. Diseño

### Parte A — Cutover de 1:1 v1 → v2 (esfuerzo bajo, v2 ya existe)

1. **Clientes** (mobile `webrtc/inCall.ts` + `webrtc/peer.ts`, desktop
   `renderer/socket/calls.ts`): emitir **exclusivamente** los eventos v2
   (`call:invite:v2`/`answer:v2`/`ice:v2`) y dejar de emitir los v1.
2. **Servidor:** marcar `call:invite`/`answer`/`ice` (v1) como deprecados. Durante una
   ventana de gracia (ver §6) se siguen aceptando para no romper clientes viejos, pero
   **sin estampar `from`** — si un cliente viejo necesita `from`, no se le entrega (el
   relay nunca lo reintroduce). Tras la ventana, eliminar los handlers v1 y `forward()`.
3. `queueCallInvite` offline debe almacenar el blob sellado v2 (sin `from`), igual que
   ya lo hace para v2.

### Parte B — Group calls selladas v2 (esfuerzo medio, feature nueva)

No existe variante sellada para grupos. Se crea, espejando 1:1 v2:

1. **Nuevos eventos** `group_call:offer:v2` / `group_call:answer:v2` / `group_call:ice:v2`.
2. **Nuevo esquema** `GroupCallSignalV2` = `{ to, callId, ...SealedSignalV2 }` (incluye
   `epk` efímero por-mensaje, como `SealedSignalV2`). **Sin** `from`.
3. **Fan-out sellado:** el emisor sella **una copia por destinatario** (cada uno contra
   la pubkey del miembro destino, con su propio `epk`), e incluye su identidad
   **dentro** del payload sellado. El relay enruta cada copia por su `to` con un
   `forwardSealed()`-equivalente de grupo — **nunca** estampa `from`.
4. **Recuperación + verificación en el receptor:** abre el box, recupera `senderAegisId`
   de adentro, y lo cross-checkea contra el roster de la llamada (igual que
   `channelKey.ts` Phase 3b y que el handler `group:rekey_dist` en
   `mobile/src/socket/client.ts:948-976`).
5. **Anti-abuso:** reutilizar el rate-limit por-`me` de ofertas de llamada/grupo ya
   existente (`checkCallOfferRateLimit`, `handler.ts:1817-1884`), como hizo `group:rekey`.

### Identidad del emisor sellada — formato del inner payload

```
inner = nacl.box(
  JSON.stringify({ v: 2, from: senderAegisId, sdp|ice: <payload>, callId, ts }),
  recipientPubKey, senderEphemeralSecret, nonce
)
wire = { to, callId, ciphertext: inner, nonce, epk: senderEphemeralPubKey }
```

- `from` va **dentro** del box (autenticado por el open exitoso contra la pubkey del
  emisor recuperada del roster), nunca en el wire.
- `epk` efímero por-mensaje ⇒ el relay no puede correlacionar por clave estática.
- `ts` + ventana de skew para anti-replay (reusar `SEALED_TS_SKEW_MS` de sealedSender).

## 5. Cambios de protocolo (resumen)

| Capa | Cambio |
|------|--------|
| `server/src/relay/handler.ts` | Nuevos schemas `GroupCallSignalV2`; nuevos handlers `group_call:*:v2` usando un `forwardSealed` de grupo; deprecar `forward()`/`from` en v1 y group v1; quitar `from` de `queueCallInvite`. |
| `mobile/src/webrtc/*`, `mobile/src/calls/*` | Sellar SDP/ICE 1:1 y de grupo con `epk` por-mensaje; emitir solo v2; abrir+verificar `from` desde el box. |
| `desktop/src/renderer/socket/calls.ts` | Paridad exacta con mobile (regla #5): mismos esquemas, mismo sellado, mismos guards. |
| `mobile`/`desktop` crypto | Reutilizar `sealedSender.ts` / `channelKey.ts` para el sellado de grupo; no inventar primitivas nuevas. |

## 6. Estrategia de migración / compatibilidad

- **Negociación de versión:** el invite ya lleva versión (`takenInvite.version`,
  `handler.ts:847`). Extender a group calls: si todos los participantes anuncian v2,
  usar v2; si hay un cliente viejo, **fail-closed** (no degradar a v1 con `from`) y
  mostrar al usuario "actualizá para llamadas de grupo cifradas sin metadatos".
- **Ventana de gracia:** N semanas aceptando v1 entrante **sin** estampar `from`;
  telemetría local (tras flag) para medir clientes v1 residuales; luego remover v1.
- **Fail-closed (regla #6):** nunca caer a un path con `from` visible "porque es más
  fácil". Si no se puede sellar, la llamada no se establece y se informa al usuario.

## 7. Plan de tests (regla #11: un test por fix)

- **Server (jest, harness estilo `ola8.relay.test.ts`):**
  - `group_call:offer:v2` reenviado a cada destinatario **no** contiene `from` ni
    ninguna identidad de emisor en el wire.
  - v1 (`call:invite`, `group_call:offer`) durante la gracia **no** estampa `from`.
  - Un emisor que intenta spoofear identidad no logra que el receptor acepte un `from`
    de adentro del box que no corresponda a la clave que abrió (paridad con el test de
    `work:sender_key_dist`).
- **Clientes (mobile jest + desktop vitest, paridad):**
  - Round-trip sellar→abrir de SDP/ICE de grupo recupera `senderAegisId` correcto.
  - Open contra clave equivocada ⇒ `null` (no acepta), fail-closed.
  - Anti-replay por `ts`/skew.
- **E2E manual (no automatizable sin WebRTC real):** checklist de llamada 1:1 y de
  grupo (3+ participantes) extremo a extremo en `docs/TESTING.md`.

## 8. Fases de implementación sugeridas

1. **Fase A** ✅ **HECHA** (rama `feat/sealed-call-1to1-cutover`): bajo la política
   por defecto `SEALED_TRANSPORT_VERSION='v2'`, los clientes emiten **solo** v2 y
   **fallan cerrado** si no pueden sellar-sender (en vez de degradar a v1 con `from`
   visible / SDP en claro en desktop); además **rechazan** invites v1 entrantes (así
   nunca contestan v1 → nunca filtran su propio `from`). Paridad mobile↔desktop
   (regla #5). El escape-hatch explícito `=v1` se preserva.
   - Evidencia: `mobile/src/socket/calls.ts`, `desktop/src/renderer/socket/calls.ts`;
     tests `mobile/src/socket/__tests__/calls.sealedSenderPolicy.test.ts` (3) y
     `desktop/src/renderer/socket/__tests__/calls.sealedSenderPolicy.test.ts` (3, primera
     suite de señalización de llamadas del desktop — regla #11).
   - **Nota:** el relay (`server/src/relay/handler.ts`) **todavía** estampa `from` en
     los eventos v1 legacy; quitarlo es *breaking* para receptores v1 y se hace en
     Fase C. Fase A no toca el server (es una mejora puramente client-side, no-breaking
     para usuarios v2).
2. **Fase B** (rama `feat/sealed-group-call-v2`): esquema + handlers v2 de grupo;
   sellado de grupo en mobile+desktop; tests server+cliente; negociación de versión.
3. **Fase C** (rama `chore/drop-v1-call-signaling`): tras la ventana de gracia, remover
   handlers v1 y `forward()`; actualizar docs.

Cada fase va **junta** en mobile+server+desktop (regla #5), commiteada, pusheada y a `main`.

## 9. Preguntas abiertas

1. **Tamaño del fan-out de grupo:** sellar 1 copia por destinatario multiplica el
   tráfico de señalización por N. ¿Cap de participantes para llamadas de grupo? (definir
   junto con el rate-limit). El contenido media sigue siendo mesh P2P, esto es solo señal.
2. **Push wake-up de grupo:** `sendGroupCallWakeUp` (`push/expo.js`) — confirmar que el
   payload de wake-up tampoco filtra el `from`/roster (debería ser solo "despertá").
3. **Ventana de gracia exacta:** depende de la tasa de adopción de versiones de la app
   publicada; decidir con datos de `ANDROID-LAUNCH-READINESS.md`.
4. **Roster en el receptor:** para cross-checkear el `from` recuperado, el receptor
   necesita el roster de la llamada. ¿Viene del invite sellado inicial? Confirmar que el
   roster no se filtre por otro canal en claro.

## 10. Referencias

- Regla de oro #4 y #5 — `CLAUDE.md`.
- Patrón sealed-sender v2 1:1 — `handler.ts:1779-1782, 1961-1975`.
- Patrón Phase 3b (identidad sellada + verificación en receptor) —
  `mobile/src/crypto/channelKey.ts`, `mobile/src/socket/client.ts:948-976`.
- Auditoría 2026-06, hallazgo #2 — `docs/SECURITY-ROADMAP-2026-06.md`.
- Diseño general sealed-sender — `docs/SEALED-SENDER-ARCHITECTURE.md`.
