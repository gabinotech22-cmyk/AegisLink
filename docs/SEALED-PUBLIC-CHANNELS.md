# AegisLink — Canales Públicos Sellados (Sealed Public Channels)

> Estado (2026-06-29): **EN CURSO.** Phase 0 (crypto), Phase 1 (server) y Phase 2
> (mobile) ✅ hechas; Phase 3 (paridad desktop), Phase 4 (delegations + approval +
> rekey), Phase 5 (comments/reactions/attachments) y Phase 6 (Tor) ⏳ pendientes.
> Estado verificable por fase en §18. Flag `PUBLIC_CHANNELS=off` (feature dormida).
> Origen: feature request — canales públicos descubribles manteniendo sealed-sender.
> Referencia primaria: **Zerion Channels Wire Protocol** (topología STAR sobre Tor,
> hash chain, manifest firmado, editor delegations, HMAC challenge, approval-gated).
> Referencia secundaria: Signal sealed-sender (delivery tokens, sealed submission).
> Regla de oro #12: revisar Session, SimpleX y Zerion antes de inventar.

---

## 0. El problema

AegisLink tiene chats 1:1 y grupos privados, ambos con sealed-sender (Fases 1–4).
Falta un modo **broadcast público**: canales donde cualquiera puede unirse sin
invitación personal, pero el relay sigue sin saber quién envía.

Restricciones no negociables:
- `aegisId` se mantiene (marca de AegisLink).
- El relay no aprende `from` en ningún mensaje de canal.
- Claves en dispositivo — el relay no custodia material de clave.
- La metadata del canal (nombre, descripción) es firmada y verificable por clientes.
- PQ-ready: el diseño debe ser compatible con ML-KEM-768 (ya en X3DH + R1 ratchet).

## 1. Modelos de referencia

| Modelo | Qué adoptamos | Qué descartamos y por qué |
|---|---|---|
| **Zerion** | Hash chain, manifest firmado, editor delegations, HMAC challenge, approval-gated, comments/reactions firmados, tombstone, invite link format, content key wrap, per-attachment keys | Topología STAR (publisher offline = canal muerto), PQ-only signatures ML-DSA-65 (usamos Ed25519 hoy, PQ en roadmap), pull-mesh (usamos push via relay) |
| **Signal** | Sealed submission + delivery token, SenderKey rotation pattern | Sin concepto de canales públicos |
| **Session (SOGS)** | — | Server ve plaintext sender — rompe sealed-sender |
| **SimpleX** | — | Sin identidad global — choca con aegisId |

**Decisión**: adoptar la estructura de Zerion (wire protocol, manifest, hash chain,
delegations, approval) adaptada a nuestro relay central con sealed submission.

---

## 2. Identidad del canal

Cada canal tiene un **Ed25519 keypair** generado por el creador (publisher/admin).

```
channelId = hash("aegislink/CHANNEL_ID", channelEd25519Pub, salt)[0:16]
```

Donde `salt` es 16 bytes aleatorios generados en la creación (previene colisiones
entre canales con la misma clave si se recrea). Mismo patrón de derivación que
mailbox IDs (`server/src/crypto/mailbox.ts`).

La clave privada del canal vive **solo** en el dispositivo del admin. Múltiples
admins requieren distribución sellada de la clave privada (sealed con la pubkey
de cada admin, como la CEK).

---

## 3. Manifest firmado (adaptado de Zerion)

El manifest es la fuente de verdad de la identidad y estado del canal. Se re-firma
en cada cambio y se distribuye con cada pull/push response.

### 3.1 Campos

```typescript
interface ChannelManifest {
  channelId:              Uint8Array;  // 16 bytes
  salt:                   Uint8Array;  // 16 bytes
  channelEd25519Pub:      Uint8Array;  // 32 bytes
  name:                   string;      // max 64 bytes UTF-8
  description:            string;      // max 512 bytes UTF-8
  avatarHash:             Uint8Array | null; // SHA-256 del avatar, o null
  channelType:            'open' | 'readonly' | 'moderated' | 'approval';
  createdAtHourMs:        number;      // truncado a hora (reduce precisión temporal)
  manifestSeq:            number;      // uint64, monotónico creciente
  contentKeyHash:         Uint8Array;  // SHA-256 de la CEK actual (validación)
  activeDelegations:      DelegationCert[];
  revokedDelegationSeqs:  number[];
  pinnedPostSeq:          number;      // -1 = ninguno
  discussionsEnabled:     boolean;     // comments/reactions habilitados
  sig:                    Uint8Array;  // Ed25519 signature
}
```

### 3.2 Signed-input (byte-exact, big-endian)

```
channelId (16) ‖ salt (16) ‖ channelEd25519Pub (32)
‖ nameHash (32) ‖ descHash (32)
‖ avatarPresent (1) ‖ [avatarHash (32)]
‖ channelType (1)    // 0=open, 1=readonly, 2=moderated, 3=approval
‖ createdAtHourMs (8)
‖ manifestSeq (8)
‖ contentKeyHashPresent (1) ‖ [contentKeyHash (32)]
‖ delegationsHash (32)   // SHA-256 de las delegaciones serializadas
‖ revokedHash (32)       // SHA-256 de los seqs revocados serializados
‖ pinnedPostSeq (8)
‖ discussionsEnabled (1)
```

Label de firma: `"aegislink/CHANNEL_MANIFEST"`.

### 3.3 Validación por subscribers

1. `channelEd25519Pub` coincide con la clave pinneada localmente.
2. `channelId == hash("aegislink/CHANNEL_ID", channelEd25519Pub, salt)[0:16]`.
3. Firma Ed25519 válida sobre signed-input.
4. `manifestSeq > local.manifestSeq` (manifests obsoletos se ignoran silenciosamente).

---

## 4. Channel Encryption Key (CEK) y acceso

### 4.1 Content Key

Clave simétrica 256-bit. Cifrado: `nacl.secretbox` (XSalsa20-Poly1305).
- Generada por el publisher en la creación del canal.
- Almacenada client-side, nunca en el relay.

### 4.2 Content Key Wrap (adaptado de Zerion)

Para distribuir la CEK a subscribers autorizados:

```
wrapKey = HKDF("aegislink/CHANNEL_CONTENT_KEY_WRAP", capability, channelId)
envelope = AES-256-GCM(CEK, wrapKey, iv=random12, aad=channelId)
```

El `envelope` viaja en el pull/push response. Solo quien posee la `capability`
puede derivar `wrapKey` y unwrap la CEK.

### 4.3 Capability (secreto de acceso al canal)

32 bytes de alta entropía. Es el secreto que permite:
- Derivar `wrapKey` para unwrap la CEK.
- Derivar `channelDeliveryToken` para submission al relay.
- Responder al HMAC challenge del relay (§4.4).

**Distribución según tipo de canal:**

| Tipo | Cómo obtiene la capability |
|---|---|
| **Open** | Incluida en el invite link (`k=` param) |
| **Readonly** | Incluida en el invite link |
| **Moderated** | Incluida en el invite link (post-submission requiere approval) |
| **Approval-gated** | NO en invite link; admin la envía tras aprobar join request |

### 4.4 HMAC Challenge (adaptado de Zerion)

En lugar de enviar la `capability` raw al relay (que la expondría), el subscriber
demuestra posesión via HMAC:

1. Subscriber genera nonce aleatorio (16 bytes).
2. Calcula `hmac = HMAC-SHA256("aegislink/CHANNEL_HMAC_CHALLENGE", capability, channelId ‖ nonce)`.
3. Envía `{ channelId, nonce, hmac }` al relay.
4. Relay valida el HMAC contra `capability` almacenada (para canales open) o contra
   el hash almacenado. Nonce replay ring (LRU, 5-min TTL, max 4096 por canal).

**Alternativa simplificada (si no queremos que el relay almacene capabilities):**
Usar delivery tokens derivados como hoy:
```
channelDeliveryToken = HKDF("aegislink/CHANNEL_DELIVERY_TOKEN", capability, channelId)
```
Relay almacena solo `SHA-256(channelDeliveryToken)`. Subscriber presenta token raw,
relay compara en constant-time. **Elegida para v1 por consistencia con el sistema
existente** (`server/src/crypto/deliveryToken.ts`).

### 4.5 Canales públicos vs privados

| | Canal público | Canal privado (approval) |
|---|---|---|
| Capability | En invite link (público) | Entregada por admin tras aprobación |
| CEK | Wrapped con wrapKey derivado de capability | Igual |
| Delivery token | Derivado de capability | Igual |
| Posts | Cifrados con CEK (no plaintext, a diferencia de Zerion) | Igual |

**Diferencia con Zerion**: Zerion sirve posts en plaintext para canales públicos.
Nosotros ciframos **siempre** — incluso canales públicos. La capability es pública
(en el invite link), pero el relay sigue sin ver el contenido. Esto es más fuerte
que Zerion y consistente con nuestro principio de relay-como-blob-forwarder.

---

## 5. Wire Protocol

### 5.1 Tipos de mensaje (Socket.IO events)

| Event | Dirección | Propósito |
|---|---|---|
| `pubchannel:join` | sub → relay | Solicitar unirse; presenta HMAC/token |
| `pubchannel:join:ack` | relay → sub | Confirmación + manifest + CEK envelope |
| `pubchannel:apply` | sub → relay | Solicitar join en canal approval-gated |
| `pubchannel:apply:ack` | relay → sub | ACK de recepción |
| `pubchannel:check_approval` | sub → relay | Pollear estado de aprobación |
| `pubchannel:approval_response` | relay → sub | Status + capability envelope si aprobado |
| `pubchannel:pull` | sub → relay | Pull incremental (`sinceSeqNum`) |
| `pubchannel:pull:response` | relay → sub | Posts + manifest + CEK envelope |
| `pubchannel:msg` | sub → relay | Enviar post (sealed, sin `from`) |
| `pubchannel:msg:fan` | relay → room | Fan-out del post a todos en la room |
| `pubchannel:delete` | admin → relay | Borrar post (firmado por channel key) |
| `pubchannel:ban` | admin → relay | Banear subscriber (firmado) + revocar token |
| `pubchannel:tombstone` | admin → relay | Canal eliminado (firmado) |
| `pubchannel:comment` | sub → relay | Comentario firmado por subscriber |
| `pubchannel:comment:fan` | relay → room | Fan-out del comentario |
| `pubchannel:reaction` | sub → relay | Reacción firmada por subscriber |
| `pubchannel:reaction:fan` | relay → room | Fan-out de la reacción |
| `pubchannel:announce` | sub → relay | Display name del subscriber |
| `pubchannel:delegation` | admin → relay | Actualizar delegaciones en manifest |
| `pubchannel:rekey` | admin → room | CEK rotada (sealed per-subscriber) |

### 5.2 REST endpoints

| Método | Path | Propósito |
|---|---|---|
| `GET` | `/public-channels` | Directorio de manifests firmados |
| `GET` | `/public-channels/:channelId/manifest` | Manifest específico |
| `POST` | `/public-channels` | Registrar canal (admin, con manifest firmado) |

---

## 6. Posts y Hash Chain (adaptado de Zerion)

### 6.1 Formato de post

```typescript
interface ChannelPost {
  seqNum:       number;      // uint64, 0-based, estrictamente creciente, sin gaps
  prevHash:     Uint8Array;  // 32 bytes, SHA-256 del post anterior (all-zero para seqNum 0)
  body:         string;      // contenido (dentro del secretbox, no visible al relay)
  ts:           number;      // epoch ms, truncado a hora
  ttlMs:        number;      // 0 = permanente; >0 = efímero (max 30 días)
  attachments:  AttachmentMeta[];
  from:         string;      // aegisId del sender (dentro del secretbox)
  sig:          Uint8Array;  // Ed25519 del sender sobre signed-input
  delegateCert: DelegationCert | null;  // solo para posts de editores delegados
}
```

### 6.2 Post signed-input (byte-exact)

```
channelId (16) ‖ seqNum (8) ‖ prevHash (32) ‖ timestampHourMs (8)
‖ bodyHash (32) ‖ attachmentsHash (32) ‖ ttlMs (8)
```

Label: `"aegislink/CHANNEL_POST"`. Firmado con Ed25519 del sender (o del delegado).

### 6.3 Hash chain

```
postHash(n) = SHA-256(
  "aegislink/CHANNEL_POST_CHAIN"
  ‖ channelId (16) ‖ seqNum (8) ‖ prevHash (32)
  ‖ timestampHourMs (8) ‖ bodyHash (32)
  ‖ attachmentsHash (32) ‖ ttlMs (8) ‖ sig (64)
)
```

- `seqNum 0`: `prevHash = 0x00…00` (32 bytes).
- La cadena incluye `sig` en el hash (como Zerion) — un relay malicioso no puede
  sustituir la firma sin romper la cadena.
- Primer fallo de verificación descarta el batch restante (max 100 posts por batch).
- Skip-known: `seqNum <= lastKnownSeq` se ignora silenciosamente.

### 6.4 Cifrado del post

```
sealed = nacl.secretbox(
  JSON({ post: innerPayload, sig }),
  nonce = random24(),
  key = CEK
)
```

Wire (lo que ve el relay): `{ channelId, ciphertext, nonce, channelDeliveryToken }`.
El relay **nunca** ve `from`, `body`, `seqNum`, `prevHash`, ni `sig`.

### 6.5 Deletes (tombstone de post)

Posts borrados se publican como post con body especial:
```
body = "AEGIS_TOMBSTONE:<channelIdHex>:<seqNum>:D"
```
Receptores parsean el marker y renderizan el post apuntado como "— eliminado —".
La cadena de hash no se rompe (el tombstone es un post más).

---

## 7. Editor Delegations (adoptado de Zerion)

### 7.1 Formato

```typescript
interface DelegationCert {
  delegateeEd25519Pub: Uint8Array;  // 32 bytes
  validFrom:           number;      // epoch ms (0 = sin límite inferior)
  validUntil:          number;      // epoch ms (0 = sin límite superior)
  delegationSeq:       number;      // uint64, monotónico, para revocación
  sig:                 Uint8Array;  // firmado por channelPrivKey
}
```

### 7.2 Delegation signed-input

```
channelId (16) ‖ delegateeEd25519Pub (32)
‖ validFrom (8) ‖ validUntil (8) ‖ delegationSeq (8)
```

Label: `"aegislink/CHANNEL_DELEGATION"`. Firmado por publisher.

### 7.3 Validación de post delegado

1. `delegateCert.sig` verifica contra `channelEd25519Pub` del manifest.
2. `delegationSeq` no está en `revokedDelegationSeqs`.
3. `post.ts` está dentro de `[validFrom, validUntil]`.
4. `post.sig` verifica contra `delegateCert.delegateeEd25519Pub`.

**Máximo 8 delegaciones activas por canal** (igual que Zerion).

---

## 8. Comments y Reactions (adoptado de Zerion)

### 8.1 Comments

Firmados por el **subscriber** (su clave personal Ed25519, no la del canal).

```typescript
interface ChannelComment {
  channelId:        Uint8Array;
  parentPostSeqNum: number;
  commentId:        number;    // uint64, random, para dedup
  body:             string;    // max 1024 chars
  displayName:      string;    // del announce
  ts:               number;
  sig:              Uint8Array; // Ed25519 del subscriber
}
```

Signed-input: `channelId ‖ parentPostSeqNum (8) ‖ commentId (8) ‖ bodyLen (4) ‖ UTF-8(body) ‖ nameLen (4) ‖ UTF-8(name) ‖ ts (8)`.
Label: `"aegislink/CHANNEL_COMMENT"`.

Límites: max 4096 comments por canal, max 256 por autor.
Dedup: por `commentId` — duplicados descartados silenciosamente.

### 8.2 Reactions

```typescript
interface ChannelReaction {
  channelId:   Uint8Array;
  postSeqNum:  number;
  emoji:       string;    // max 32 bytes UTF-8
  ts:          number;
  sig:         Uint8Array; // Ed25519 del subscriber
}
```

Signed-input: `channelId ‖ postSeqNum (8) ‖ emojiLen (4) ‖ UTF-8(emoji) ‖ ts (8)`.
Label: `"aegislink/CHANNEL_REACTION"`.

Límites: max 256 reactions por post.
Dedup: por `(postSeqNum, signerEd25519Pub)` — mismo emoji + ts = no-op.

### 8.3 Announce (display name)

Subscriber envía su display name para atribuir comments/reactions:
```
{ channelId, displayName, ts, sig }
```
Signed-input: `channelId ‖ nameLen (4) ‖ UTF-8(name) ‖ ts (8)`.
Label: `"aegislink/CHANNEL_ANNOUNCE"`.
Max 64 bytes display name, max 4096 announced subscribers por canal.
Auto-triggered por el subscriber tras pull exitoso.

### 8.4 Discussions toggle

`discussionsEnabled` en el manifest. Relay rechaza `pubchannel:comment` y
`pubchannel:reaction` cuando está deshabilitado para el canal (verificando contra
manifest almacenado).

---

## 9. Attachments cifrados

### 9.1 Per-attachment key (adoptado de Zerion)

Cada attachment tiene su propia clave 256-bit (independiente de la CEK).

```typescript
interface AttachmentMeta {
  hash:         Uint8Array;  // SHA-256 del blob cifrado
  size:         number;      // tamaño original en bytes
  mime:         string;      // MIME type
  key:          Uint8Array;  // 32 bytes, clave del attachment (dentro del secretbox del post)
  thumbnailKey: Uint8Array | null;
}
```

### 9.2 Cifrado del blob

```
nonce = random12()  // prefixed al ciphertext
aad = channelId ‖ mimeLen (4) ‖ UTF-8(mime) ‖ size (8)
encrypted = AES-256-GCM(blob, attachmentKey, nonce, aad)
wire = nonce ‖ encrypted
```

Content-addressed: `blobHash = SHA-256("aegislink/CHANNEL_ATTACHMENT_BLOB", wire)`.

### 9.3 Fetch

`pubchannel:get_attachment { channelId, blobHash }` → relay sirve el blob cifrado.
El relay almacena blobs opacos; no puede descifrarlos sin la `attachmentKey` (que
viaja dentro del secretbox del post, cifrado con la CEK).

---

## 10. Membership

### 10.1 Join — Canal open/readonly/moderated

1. Joiner obtiene invite link con capability (`k=` param).
2. Deriva `channelDeliveryToken = HKDF(capability, "aegislink/CHANNEL_DELIVERY_TOKEN", channelId)`.
3. Emite `pubchannel:join { channelId, deliveryToken }`.
4. Relay valida token (constant-time), añade socket a room `pubchannel:{channelId}`.
5. Relay responde con `pubchannel:join:ack { manifest, contentKeyEnvelope }`.
6. Joiner unwraps CEK: `wrapKey = HKDF(capability, "aegislink/CHANNEL_CONTENT_KEY_WRAP", channelId)`,
   `CEK = AES-256-GCM-open(contentKeyEnvelope, wrapKey)`.
7. Joiner valida `SHA-256(CEK) == manifest.contentKeyHash`.

### 10.2 Join — Canal approval-gated (adaptado de Zerion)

1. Joiner obtiene invite link **sin** capability (`p=1` flag).
2. Genera keypair X25519 efímero (`joinEpk`).
3. Emite `pubchannel:apply { channelId, joinEpk }`.
4. Relay almacena en `pending_joins` (TTL 24h, max 256 pending por canal).
5. Admin online recibe notificación.
6. **Admin aprueba**: sella capability con `joinEpk`:
   ```
   sharedSecret = nacl.box.before(joinEpk, adminX25519Secret)
   wrapKey = HKDF(sharedSecret, "aegislink/APPROVAL_WRAP", channelId)
   capabilityEnvelope = AES-256-GCM(capability, wrapKey)
   ```
7. Admin emite `pubchannel:approval_response { channelId, status: 'approved', capabilityEnvelope, adminEpk }`.
8. Joiner: `sharedSecret = nacl.box.before(adminEpk, joinEpkSecret)`, unwraps capability.
9. Joiner procede como §10.1 paso 2–7.

**Throttle**: subscriber puede pollear `pubchannel:check_approval` max 1 vez cada 30s.

### 10.3 Leave

Cliente descarta CEK + capability y sale de la room Socket.IO.
Sin rotación de CEK (el leaver ya la tenía; rotar sería O(N) para cada leave).

### 10.4 Ban + CEK rotation

1. Admin firma `{ banned: aegisId, ts, channelId }` con clave del canal.
2. Emite `pubchannel:ban { channelId, banRecord, banSig }`.
3. Relay revoca delivery token del baneado, lo expulsa de la room.
4. Admin genera nueva CEK + nueva capability.
5. Admin redistribuye nueva capability a todos los miembros restantes:
   - Sealed per-recipient usando `sealEnvelope` (`server/src/crypto/sealedSender.ts`).
   - Offline queue via `senderKeyDistRepo.enqueue`.
6. Admin actualiza manifest con nuevo `contentKeyHash` + incrementa `manifestSeq`.
7. Baneado: su viejo token inválido, su vieja CEK no descifra posts nuevos.

### 10.5 Directorio de miembros (client-side only)

El relay **no** almacena un roster. El roster vive client-side, cifrado con la CEK.
Para resolver un sender desconocido: se solicita su pubkey al admin o a peers
conocidos por el canal cifrado.

---

## 11. Discovery

### 11.1 Directorio público (relay-hosted)

`GET /public-channels` → array de manifests firmados.
El relay no puede forjar entradas (clients verifican `sig`). El relay sabe qué
canales existen y su popularidad aproximada — aceptable, son públicos por definición.

### 11.2 Invite links (out-of-band)

```
aegislink://channel/<base32url channelId>/<base32url channelEd25519Pub>
  [?k=<base32url capability>]     // open/readonly/moderated
  [&p=1]                          // approval-gated (sin capability)
```

Inspirado en Zerion. Sin parámetro de onion (usamos relay central).

---

## 12. Canal tombstone (adoptado de Zerion)

```typescript
interface ChannelTombstone {
  channelId: Uint8Array;  // 16 bytes
  ts:        number;      // epoch ms
  sig:       Uint8Array;  // Ed25519_sign(channelId ‖ ts, channelPrivKey)
}
```

Label: `"aegislink/CHANNEL_TOMBSTONE"`.

Subscriber que recibe un tombstone verifica firma contra `channelEd25519Pub` pinneada.
Si válido, elimina el canal localmente. El relay limpia room + storage.

---

## 13. Moderación completa

| Acción | Wire event | Firmado por | Relay involvement |
|---|---|---|---|
| Ban | `pubchannel:ban` | Channel key | Revoca token, expulsa de room |
| Delete post | `pubchannel:delete { seqNum, sig }` | Channel key | Tombstone en storage |
| Mute | Client-side (dentro del canal cifrado) | Channel key (mute record) | Ninguno |
| Delete channel | `pubchannel:tombstone` | Channel key | Distribuye, limpia |
| Revoke delegation | Manifest update con `revokedDelegationSeqs` | Channel key | Sirve manifest nuevo |

---

## 14. Integración con Tor

Reutiliza el transporte Tor existente (`docs/FASE4-TOR-TRANSPORT-DESIGN.md`):
- `pubchannel:join` por Tor → oculta IP del joiner al relay.
- Mensajes de canal por Tor → anonimato IP + sealed-sender.
- Discovery fetcheable por Tor.
- Sin integración especial — misma infra.

---

## 15. Reutilización de código existente

| Componente | Archivo | Reuso |
|---|---|---|
| `sealEnvelope` / `openEnvelope` | `server/src/crypto/sealedSender.ts` | CEK distribution, capability wrap |
| Delivery token | `server/src/crypto/deliveryToken.ts` | Channel delivery tokens |
| Mailbox ID derivation | `server/src/crypto/mailbox.ts` | Patrón de channelId |
| Socket.IO rooms | `handler.ts` (`socket.join`, `io.to().emit()`) | Fan-out `pubchannel:{channelId}` |
| `group:rekey` | `handler.ts:1626` | CEK rotation en bans |
| `channel:msg` RBAC | `handler.ts:1354` | Permisos can_send, can_upload |
| `senderKeyDistRepo.enqueue` | `server/src/db/repos/` | Offline CEK queue |
| HKDF | `mobile/src/crypto/signal/ratchet.ts` | Key derivation labels |

---

## 16. Diferencias honestas con Zerion

| Aspecto | Zerion | AegisLink |
|---|---|---|
| Topología | STAR — publisher corre v3 onion service | HUB — relay central, Socket.IO rooms |
| Disponibilidad | Publisher offline = canal muerto, pull cada 5s | Relay 24/7, push instantáneo, offline queue |
| Public channel crypto | Posts en **plaintext** (sin cifrar) | Posts **siempre cifrados** (CEK, capability pública en invite link) |
| PQ crypto | ML-KEM-768 + ML-DSA-65 per-frame (hoy) | ML-KEM-768 en X3DH + per-chain ratchet (hoy, `R1-PQ-PER-FRAME-DESIGN.md`); canales usan Ed25519 + NaCl |
| Serialización | BdfDictionary (Bramble binary) | JSON sobre Socket.IO (consistente con el resto del stack) |
| Hash chain | Incluye wire signature bytes en hash | Incluye sig bytes en hash (igual) |
| Subscriber identity | Subscriber ML-DSA-65 obligatorio | Subscriber Ed25519 (PQ futuro para firmas de canal) |
| Relay trust | Sin relay — pull directo del publisher por Tor | Relay ve channelId + blob opaco, no ve from/content |
| Content de canales públicos | Plaintext al relay | Cifrado siempre — relay es blob forwarder incluso para públicos |

**Ventaja Zerion**: sin relay = sin punto de ataque centralizado.
**Ventaja AegisLink**: relay = disponibilidad 24/7, offline queue, push instantáneo,
canales públicos cifrados (relay nunca ve contenido), no depende de que el publisher
esté online.

---

## 17. Límites honestos

1. **Temporal correlation**: relay infiere "alguien en la room envió algo" por timing.
   Mismo límite que 1:1 sealed-sender. Mitigación: cover traffic (§14).
2. **CEK compartida**: miembro comprometido expone posts de esa generación de CEK.
   Mitigación: rotación por época (no solo por ban).
3. **Admin como bottleneck**: distribución de CEK y approval requieren admin online.
   Mitigación: múltiples admins, o pre-distribuir envelopes en relay para self-serve.
4. **Room size visible al relay**: relay sabe cuántos sockets, no quiénes.
   Aceptable para canales públicos.
5. **Sin PQ en firmas de canal (v1)**: usamos Ed25519, no ML-DSA-65. El roadmap PQ
   (`R1-PQ-PER-FRAME-DESIGN.md`) cubre el ratchet; firmas de canal PQ son Phase futura.

---

## 18. Fases de implementación

### Phase 0 — Spike crypto (1 semana) — ✅ HECHO
> Evidencia: `mobile/src/crypto/publicChannelKey.ts`, `channelKey.ts`; tests
> `publicChannelKey.parity.test.ts`, `channelKey.sealRecipients.test.ts`.

- `server/src/crypto/channelKey.ts`: CEK, HKDF delivery token, content key wrap,
  secretbox seal/unseal con firma interna, hash chain, manifest signing.
- Tests: round-trip, hash chain verification, delegation cert, tombstone, HMAC challenge.
- Aislado del path vivo.

### Phase 1 — Server infrastructure (1-2 semanas) — ✅ HECHO
> Evidencia: handlers `pubchannel:*` en `server/src/relay/handler.ts`; test
> `server/src/__tests__/publicChannels.relay.test.ts`. Flag `PUBLIC_CHANNELS=off`.

- DB: `public_channels`, `public_channel_pending_joins`, `public_channel_posts`.
- REST: `GET/POST /public-channels`.
- Socket events: todos los de §5.1.
- Flag-gated: `PUBLIC_CHANNELS=off`.

### Phase 2 — Mobile client (2 semanas) — ✅ HECHO
> Evidencia: `mobile/src/channels/`, `mobile/src/socket/publicChannels.ts`,
> `mobile/src/store/channels.ts`, pantallas `Channel*.tsx` + `ChannelsPanel.tsx`
> (segmento dentro de Groups); 69 tests de canales en verde.

- `mobile/src/crypto/channelKey.ts`: CEK store, derivation, secretbox wrapper.
- UI: discovery, channel view, join/apply flow, post composition.
- Hash chain verification, manifest validation.

### Phase 3 — Desktop parity (1 semana) — ⏳ PENDIENTE
> Sin empezar (cero archivos `pubchannel` en `desktop/`). Bloquea la regla de oro #5
> (paridad mobile↔desktop) para activar el flag, aunque con `PUBLIC_CHANNELS=off` la
> feature está dormida y el resto es mergeable.

- Port verbatim de `channelKey.ts` (known-answer vectors).
- Socket events desktop.

### Phase 4 — Moderation + delegations (1 semana) — ⏳ PARCIAL
> Hechos: `pubchannel:ban`, `pubchannel:delete`, `pubchannel:tombstone` (server+mobile).
> Pendientes: editor delegations (`pubchannel:delegation`), flujo approval-gated completo
> (`apply`/`check_approval`/`approval_response`), CEK rotation (`pubchannel:rekey`).

- Ban + CEK rotation.
- Read-only, moderated, approval-gated.
- Editor delegations con DelegationCert.

### Phase 5 — Comments, reactions, attachments (1-2 semanas) — ⏳ PENDIENTE
> Sin implementar (no existen eventos `comment`/`reaction`/`announce`/`get_attachment`).

- Comments/reactions firmados por subscriber.
- Attachments con per-attachment key + AES-256-GCM.
- Announce (display name).

### Phase 6 — Tor + anti-correlation (diferido) — ⏳ DIFERIDO
- Tráfico por Tor embebido.
- Cover traffic.

---

## 19. Verificación

1. **Unit tests** (Phase 0): round-trip CEK, hash chain, delegation cert, content key
   wrap, delivery token, manifest sign/verify, tombstone.
2. **Integration tests** (Phase 1): socket events E2E con relay, join flow, offline queue,
   HMAC challenge, approval flow.
3. **On-device** (Phase 2): crear → discovery → join → post → verify relay log sin `from`
   → ban → verify baneado no puede enviar → tombstone.
4. **Parity** (Phase 3): known-answer vectors mobile = desktop.
5. **Security audit** (pre-merge): hash chain no manipulable, CEK no leaks, delivery
   token constant-time, no metadata en relay logs.
