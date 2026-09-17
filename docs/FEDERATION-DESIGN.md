# Federación de relays — "elige tu servidor" (modelo SimpleX)

> **Estado:** documento de decisión aprobado por el dueño el 2026-09-16. Fuente canónica
> del diseño y del estado de sus slices (F0–F7). Nada de esto está implementado todavía:
> el estado de cada slice se actualiza **aquí** en la misma PR que la implemente (regla de
> oro doc↔código #2). `ROADMAP.md` enlaza a este doc, no duplica su estado.

## 0. Por qué

El README decía "spin up your own relay and point a client at it". El relay es autoalojable
(AGPL, `docker-compose.yml`), pero **ningún cliente publicado puede elegir servidor**:
`SERVER_URL`/`ONION_URL` son constantes de compilación (`mobile/src/config.ts`,
`desktop/src/renderer/config.ts`), los pines TLS van cocidos en el binario
(`mobile/app.plugin.js`) y, sobre todo, **no hay federación**: prekeys, mailboxes, blobs,
señalización de llamadas y SenderKey de grupos viven en UN relay. Un campo "URL del relay"
en Ajustes crearía islas incomunicadas (por eso Signal no lo permite). Un usuario que quiera
que "elige tu servidor" sea verdad necesita que su relay y el de sus contactos sean distintos
**y que hablen entre sí**.

Decisiones tomadas (👤 2026-09-16):

1. **Modelo SimpleX, no email.** Cada usuario elige el relay de **su buzón**; su dirección de
   contacto lleva el relay; el emisor entrega en el relay del receptor. **Sin protocolo
   relay-a-relay**: el cliente habla con varios relays. Sin directorio global.
2. **Relays propios solo `.onion`.** La dirección onion es la clave pública del servidor: sin
   CA, sin DNS, sin pines, sin IP. Tor va embebido en Android, iOS y desktop
   (`FASE4-TOR-EMBEDDED-IMPL.md`, `FASE4-TOR-IOS-DESIGN.md`, desktop #475). El relay oficial
   conserva clearnet + pines solo para el arranque; todo relay no oficial es una onion.
3. **Alcance de la primera entrega: todo.** Chat 1:1, adjuntos, grupos, llamadas y receipts
   deben funcionar entre dos personas en relays distintos antes de que la pantalla salga.
   Se construye en slices mergeables tras el flag `FEDERATION` (OFF hasta F7).

## 1. Hechos del código en los que se apoya (verificados 2026-09-16)

| Hecho | Dónde | Consecuencia |
|---|---|---|
| El auth de un socket **mailbox no necesita identidad registrada**: el relay recomputa `id = SHA256(signPub)[0:16]` y verifica una firma. `envelope:mb` solo exige un socket mailbox autenticado, cualquiera. | `server/src/relay/handler.ts` (`handleMailboxConnection`, `envelope:mb`); `mobile/src/socket/mailboxSocket.ts` | Un emisor puede entregar en el relay del receptor abriendo un socket mailbox con un **root efímero desechable**. Cero código de servidor para la entrega 1:1; el relay ajeno ve un id aleatorio que nunca recibe nada. |
| El root del mailbox viaja por `profile_update` E2EE junto al `deliveryToken`. | `mobile/src/socket/client.ts` (`ownMailboxRootField`, handler de `profile_update`) | `mailboxRelay` viaja por el mismo canal. |
| El enlace/QR de contacto es `aegislink://v1/<aegisId>/<pubkey>` (https `…/a#v1/…`). El primer contacto pide el bundle de prekeys al relay por aegisId. | `mobile/src/crypto/qr.ts`; `prekeys:fetch`; `GET /prekeys/bundle/:aegisId` (sin auth) | El enlace **v2** lleva el relay. |
| Blobs: `blob:<id>:<key>:<nonce>:<token>` sin host; se descargan de `RELAY_URL`. | `mobile/src/crypto/media.ts` | Blob ref **v3** con host. |
| Llamadas: `call:*:v2 { callId, to: aegisId, …sellado }` por el socket aegisId; el relay rutea por `sockets.get(to)` del **mismo** relay. | `mobile/src/socket/calls.ts`; `server/src/relay/callSignaling.ts` | Cross-relay ⇒ señalización por mailbox. |
| Grupos: los mensajes son fan-out de sobres 1:1 (ya federable); la distribución de SenderKey va por `group:rekey` encolada por aegisId en el relay. | `client.ts` (`group:rekey`); `server/src/relay/handlers/channels.ts` | Cross-relay ⇒ distribución por mailbox. |
| Receipts/typing son eventos relay-locales por aegisId. | `SEALED-SENDER-ARCHITECTURE.md §6.1` | Cross-relay ⇒ por mailbox (cierra también ese residuo). |
| Push wake por mailbox = ntfy co-hosteado con el relay, topic = mailboxId. | `FASE4-SLICE2B-PUSH-DESIGN.md` | Cada relay trae su ntfy; el cliente se suscribe al de **su** relay. |
| Perfiles múltiples aíslan identidad/SecureStore por slot. | `mobile/src/db/core.ts` | El relay es **por perfil**. |
| `FASE4-CONTROL-PLANE-DESIGN.md §4` ya recomendaba "C: embeber el bundle en el QR" y control-plane por Tor. | — | La federación va en esa dirección. |

## 2. Diseño

### D1. Dirección de contacto = identidad + relay
- Tipo `RelayRef = { onion: string }` (host `.onion` v3, sin esquema). El oficial es la
  constante `OFFICIAL_RELAY` (su onion actual). Solo onion: no hay `url`, no hay pines.
- Enlace/QR **v2**: `aegislink://v2/<aegisId>/<pubkey>/<onion>/<mailboxRoot>`; https `…/a#v2/…`.
  El root del buzón (32 bytes, base64) va en la dirección porque es la cola a la que un
  desconocido de otro relay escribe el primer mensaje (modelo SimpleX; F3b). **v1 se sigue
  aceptando** y significa "relay oficial". Entrada manual: `ABC-DEFG-HJKL@<onion>`; sin `@` =
  oficial (sin root: se resuelve por el lookup de identidad en ese relay).
- UI: el aegisId sigue siendo la marca; el relay se muestra debajo en gris ("relay: oficial" /
  "relay: abcd…xyz.onion") en Perfil, ContactDetail y Verify.
- El **fingerprint de verificación no cambia** (es identidad). El QR de verificación muestra
  además el relay, para que un cambio de relay sin `profile_update` sea visible a ojo.

### D2. Cliente multi-relay (`relayPool`)
- Módulo `mobile/src/net/relayPool.ts` (espejo en `desktop/src/renderer/net/`): mapa
  `onion → RelayConn`.
  - `home`: el relay del perfil — socket aegisId de control + socket mailbox propio + ntfy.
  - `foreign(onion)`: **socket mailbox desechable** — root aleatorio en memoria, nunca
    persistido, regenerado por sesión y por época — usado solo para `envelope:mb` hacia
    buzones de ese relay; se cierra por inactividad (5 min). Siempre por Tor (`TorSioSocket`).
  - HTTP por Tor hacia relays ajenos (patrón `fetchMailboxOverTor`): prekeys bundle, identity
    lookup (si el relay lo permite), blob download, `GET /relay/info`.
- Routing por contacto: `contact.relayOnion` (nuevo campo; `null` = oficial) en la DB de
  mobile (SQLCipher) y desktop. Todo lo que hoy asume "el relay" pasa por `relayFor(contact)`.
- El socket aegisId de control va **solo al home** (prekeys upload, push, deliveryToken,
  device link). La identidad **nunca** se autentica en un relay ajeno (reglas de oro #3/#4:
  un relay ajeno no aprende el aegisId del emisor).

### D3. Todo el tráfico entre personas viaja por mailbox
Entre relays solo existe el transporte mailbox, así que estos tipos pasan a ser payloads
sellados dentro de `envelope:mb`, gateados por capacidades del contacto (D6):
- `call.*` (invite/answer/ice/hangup; group call) — reutiliza el sellado por sesión + secretbox
  por candidato ICE ya existente (`FASE4-SEALED-CALL-SIGNALING-DESIGN.md`). El relay deja de ver
  `to: aegisId` en llamadas: **mejora de privacidad también en el relay oficial**.
- `group.senderKeyDist` — la distribución se sella por destinatario y viaja como sobre mailbox;
  el relay ya no encola `group:rekey` por aegisId (`senderKeyDistRepo` queda para clientes sin
  la capacidad hasta retirar v1).
- `receipt.delivered` / `receipt.read` / `typing` — opt-in por contacto como hoy, por mailbox.
- **Wake de llamadas:** Android = foreground-service con socket mailbox 24/7 (ya); iOS = el
  relay home del callee publica el wake (`registerIosWakeBinding` ya liga el token al mailbox).
  Para conservar la prioridad alta de llamada, el **wire exterior** lleva `wakeHint: 'call'`
  — un metadato declarado: "hay una llamada entrante para este mailbox", sin quién.

### D4. Cambiar de relay (migración) y la pantalla
- **Pantalla `Privacy → Red → "Mi relay"`** (`mobile/src/screens/RelaySettings.tsx`, nav
  `onNav('relay')`; desktop ídem):
  1. Estado actual: "Relay oficial de AegisLink" o `<onion>` + fecha de migración.
  2. "Usar mi propio relay": campo onion (validación v3: 56 chars base32 + `.onion`) →
     **Verificar**: `GET /relay/info` por Tor + `GET /health`.
  3. Consecuencias, en claro: "tus contactos recibirán tu nueva dirección automáticamente;
     durante 7 días seguirás recibiendo en el relay anterior; quien no abra la app en 7 días
     perderá tus mensajes hasta que le reenvíes tu enlace". Confirmación con PIN/biometría si
     app-lock está activo.
  4. **Migración** (`mobile/src/net/relayMigration.ts`): registrar identidad en el nuevo relay
     (`POST /identity` con PoW; `ensureRegistered.ts` parametrizado por relay) → subir prekeys
     al nuevo home → suscribir su ntfy → `profile_update { mailboxRelay }` a todos los contactos
     y grupos → `homeRelay = nuevo`, `previousRelay = { onion, until: now + 7 d }` → el pool
     mantiene el mailbox del relay viejo bindeado (solo recepción) hasta `until` → al vencer,
     `DELETE /identity/:id` (firmado) en el viejo y limpieza. Rollback si falla el registro.
  5. "Volver al relay oficial" = la misma migración en sentido inverso.
- Un contacto que recibe `mailboxRelay` actualiza `contact.relayOnion`; el pool descarta la
  conexión foreign antigua. Un sobre a un relay foreign que falla (Tor timeout) reintenta por el
  outbox durable (#435), **sin degradar** al transporte aegisId.

### D5. Servidor (poco y aditivo)
- `GET /relay/info` → `{ name, version, minClient, features: ['mailbox','ntfy','prekeys','blob'],
  maxBlobBytes }`.
- Sockets mailbox que solo envían: el cap de sobres/min por socket ya existe; se añade PoW
  opcional en `envelope:mb` bajo presión (`MAILBOX_SUBMIT_POW`, mismo `pow/challenge.ts`).
- `docs/SELF-HOSTING.md`: compose (relay + coturn + ntfy + tor hidden service), obtener la onion,
  compartir la dirección, límites (sin clearnet, sin pines).
- **No** hay relay-a-relay. **No** hay directorio global.

### D6. Compatibilidad y flag
- Flag `FEDERATION` (config, default OFF) hasta F7: con OFF todo se comporta como hoy.
- Clientes viejos ante un enlace v2 → "Actualiza AegisLink" (`UpdateRequired` + `minVersion`
  del relay, #478): al activar la feature se sube `minVersion`.
- Los payloads nuevos por mailbox se emiten **solo** a contactos cuyo `profile_update`
  anuncie `caps: ['mbx-calls','mbx-groups','mbx-receipts']`; si no, transporte actual. Cutover
  por contacto, sin ventana rota (mismo patrón que v1→v2).

## 3. Slices (una rama `feat/federation-*` por slice; flag OFF hasta F7)

| # | Estado | Rama | Contenido | Tests |
|---|---|---|---|---|
| F0 | ✅ #483 | `docs/federation-design` | Este documento; `ROADMAP.md` Hito 6; README honesto (#482) | gate `docs-sync` |
| F1 | ✅ `feat/federation-address` | `net/relayRef.ts` (puro, copia byte-idéntica mobile↔desktop) + `net/officialRelay.ts`; enlace/QR **v2** y entrada `id@onion` (`crypto/qr.ts` en ambas plataformas — el desktop además alcanza paridad: universal links, decode seguro, binding ID↔clave); flag `FEDERATION` (OFF) que rechaza con mensaje un relay ajeno en AddContact/ScanQR; columna `contacts.relay_onion` (mobile SQLCipher + desktop) y `StoredContact.relayOnion`; relay visible bajo el id en ContactDetail cuando es propio | mobile `net/__tests__/relayRef.test.ts` (KAT, 27) + `qr.links.test.ts` (+7 v2) + `db/__tests__/contactRelayOnion.test.ts` (3) + fuzz (`parseContactAddress`); desktop `net/__tests__/relayRef.test.ts` (mismos vectores) + `crypto/__tests__/qr.test.ts` (6) |
| F2 | ✅ `feat/federation-pool` | `net/relayPoolCore.ts` (puro, byte-idéntico mobile↔desktop): un socket mailbox **desechable** por relay ajeno (root aleatorio en memoria, nunca persistido, fresco tras cada cierre por inactividad de 5 min), firma solo challenges de 32 bytes; adaptadores `net/relayPool.ts` (mobile: `TorSioSocket` + `torHttpRequest`; desktop: `TorSioSocket` bridged + `fetch` por la sesión Tor); `net/homeRelay.ts` (`getHomeRelay()` = oficial hasta F5, `relayFor`/`isForeign`); envío a contactos ajenos **solo** por el pool (`queued` es terminal; fallo → outbox), prekeys por `GET /prekeys/bundle/:id` en el relay del contacto, `lookupIdentityAt` para `ID@onion`; blob **v3** `blob:<id>:<key>:<nonce>:<token>:<onion>` (host solo si el home no es el oficial; descarga por Tor nativo en mobile / `fetch` en desktop); server `GET /relay/info` (`features`, `protocol`, `minClient`, `maxBlobBytes`, política `IDENTITY_LOOKUP`). **De paso:** el `httpRequest` nativo sobre Tor que `tor.ts` declaraba desde #391 nunca existió (Android ni iOS) — el drenaje stateless era un no-op en dispositivo; ahora hay `httpRequest` + `httpDownload` en ambos plugins (**pendiente de build en dispositivo**, F7). | mobile `net/__tests__/relayPoolCore.test.ts` (8) + `media.test.ts` (+5 v3); desktop el **mismo** `relayPoolCore.test.ts` (8) + `mediaBlobUri.test.ts` (3); server `relayInfo.test.ts` (3) + **`relay.federation.test.ts`** (4: A en R1 entrega a B en R2 por buzón desechable sin identidad en el cable; por R1 solo queda encolado; prueba de posesión obligatoria) |
| F3 | ✅ `feat/federation-groups-receipts` | Receipts y typing ya viajaban como mensajes sellados (`type: 'read_receipt'`/`'typing'`) en modo mailbox; ahora también **siempre** para un contacto ajeno (`isForeign`), con lo que F2 los enruta por su relay. Distribución de SenderKey a un miembro ajeno como mensaje sellado **`sender_key_dist`** (la misma caja por destinatario de `group:rekey`; el receptor la abre solo contra la clave del emisor autenticado y exige que el `senderAegisId` firmado coincida); los miembros del mismo relay siguen en `group:rekey`. Sin `caps`: un contacto ajeno solo puede ser un cliente nuevo (los enlaces v2 no se parsean en clientes viejos); `caps` queda para F4 (llamadas en el relay oficial). Desktop: typing + receipts (no implementa SenderKey — PAR-1). Residuo Work `emitDeleteChannelMsg` eliminado. | mobile `client.federationControlPlane.test.ts` (6: typing/receipts sellados sin evento plano ni `prekeys:fetch`; bundle desde el relay ajeno; re-key mixto local+ajeno; `sender_key_dist` aceptado solo del emisor autenticado, rechazado si la caja la selló otro) |
| **F3b** | ✅ `feat/federation-first-contact` | **Hallazgo de F3:** el primer mensaje a un contacto nuevo iba **siempre en v1** (el inner v2 nunca llevaba `x3dhInit`) y v1 solo existe por el transporte aegisId, que no cruza relays; además el `mailboxRoot` del contacto solo llegaba por `profile_update` de una sesión ya establecida → el primer contacto cross-relay no podía arrancar. Hecho (modelo SimpleX: la dirección incluye la cola): (1) el enlace/QR **v2 lleva el `mailboxRoot`** (`…/<onion>/<root>`, 32 bytes obligatorios; un v2 sin root se rechaza y nunca se emite; `addFromQR` lo persiste); (2) `encryptMessageV2(…, firstContact)` mete en el inner `x3dh` + bloque **`fc = {ik, relay, root}`** y el sellado embebe la clave de firma del emisor (`spk`) — solo cuando la sesión tiene `x3dhInit` pendiente; el campo `fc` entra en la allow-list; (3) `openEnvelopeV2(…, {allowFirstContact})` (gateado por `FEDERATION`) acepta un emisor desconocido **solo** si es un bootstrap real (x3dh + fc bien formado), la clave pinneada de un contacto conocido siempre gana, y el receptor exige binding ID↔`fc.ik` antes de crear el contacto (**pending** en mobile, no verificado en desktop — PAR-1) con `relayOnion` + root y clave de firma TOFU; el `profile_update` de vuelta sale **después** de descifrar, sobre la sesión que el init acaba de establecer (sin glare); (4) un selector único (`buildOutgoingEnvelope`) para envío en vivo, outbox y `sendProfileTo`, y un único `deliverToForeignRelay`: un contacto ajeno **nunca** cae al socket home (el outbox de F2 sí lo hacía — corregido). La clave de firma NO va en el enlace: viaja sellada en el primer mensaje. Riesgo declarado: quien tenga el enlace conoce la secuencia de buzones (puede dirigir spam, no leer); mitigación en F5: rotar el root al migrar y opción "regenerar enlace". | mobile `crypto/__tests__/messaging.firstContact.test.ts` (5: abre solo con opt-in y reporta la clave TOFU; sin bootstrap se rechaza; la clave pinneada gana; `fc` malformado se rechaza; un v2 normal nunca lleva x3dh) + **`socket/__tests__/client.firstContact.test.ts`** (5: primer mensaje a un ajeno = v2 por el pool con x3dh+fc+spk, sin `envelope` ni token, que el destinatario abre solo como bootstrap; un desconocido crea contacto pending con relay+root y descifra, y el profile de vuelta sale por su relay; `fc.ik` ≠ id → dropped; desconocido sin fc → retry sin ack; relay caído → outbox, nunca el socket home) + `qr.links.test.ts` (+7 v2 con root, fuzz) ; desktop el mismo `messaging.firstContact.test.ts` (5) + `qr.test.ts` (6) |
| F4 | ⬜ (tras F3b) | `feat/federation-calls` | `call.*` por mailbox (1:1 y grupo); TURN de cada home; `wakeHint:'call'`; `callSignaling.ts` v2 se conserva para clientes sin `caps` | `callsMailbox.relay.test.ts` con dos relays; `callWake`; paridad desktop |
| F5 | ⬜ | `feat/federation-settings` | `RelaySettings` (mobile + desktop), `relayMigration.ts`, `profile_update.mailboxRelay`, gracia 7 d, ntfy por relay, `ensureRegistered` por relay, i18n EN/ES/IT | `RelaySettings.test.tsx`, `relayMigration.test.ts` (orden + rollback), `profileUpdate.relay.test.ts` |
| F6 | ⬜ | `feat/federation-selfhost` | `docs/SELF-HOSTING.md`, compose con tor + ntfy, `MAILBOX_SUBMIT_POW`, script idempotente de onion | `mailboxSubmitPow.relay.test.ts`; smoke de compose en CI (best-effort) |
| F7 | ⬜ | `feat/federation-enable` | `FEDERATION=ON`, subir `minVersion`, build preview; **prueba real 2 dispositivos × 2 relays** (oficial + relay de prueba en la VM de coturn) | enlace v2, chat, adjunto, grupo de 3 con 2 relays, llamada, migración ida y vuelta; informe `docs/AUDIT-…` |

Reglas por slice: paridad mobile↔desktop en la misma rama (#5); un test por cambio de
seguridad (#11); `Docs:` en la PR; nunca F(n+1) con F(n) sin mergear.

## 4. Decisiones de producto abiertas (con recomendación)

1. **Embeber el bundle de prekeys en el enlace v2** (paso "C" de `FASE4-CONTROL-PLANE-DESIGN.md §4`):
   elimina la consulta de directorio en el primer contacto; un relay ajeno ni siquiera ve
   `GET /prekeys/bundle`. **Recomendado en F1** (el QR crece ~400 B; sigue escaneable).
2. **Ventana de gracia** al migrar: **7 días** (recomendado) vs 30 (= TTL de cola).
3. **Directorio cero en relays propios:** no exponer `GET /identity/:id` a terceros (el pubkey ya
   va en el enlace). **Recomendado:** flag server `IDENTITY_LOOKUP=off` por defecto fuera del oficial.
4. **Canales públicos sellados** se quedan en el relay que los aloja (dirección autocontenida).
   Fuera de este diseño.

## 5. Residuo honesto

- Un relay ajeno ve: "un mailbox aleatorio (desechable) entregó un sobre a un mailbox X ahora".
  No ve identidades, no puede relinkear el desechable entre sesiones ni épocas.
- El relay **home** de cada usuario sigue viendo lo que ya ve hoy (`SEALED-SENDER-ARCHITECTURE.md §6`).
- `wakeHint: 'call'` añade un bit de metadato en el wire exterior de las llamadas; se declara
  y se acepta a cambio del wake de alta prioridad en iOS.
- Si el usuario migra y un contacto no abre la app en la ventana de gracia, ese contacto sigue
  entregando en el relay viejo hasta recibir el nuevo enlace. Es el mismo límite que SimpleX.

## 6. Referencias

- SimpleX SMP: servidores por cola elegidos por el receptor; sin identidad global; cliente
  multi-servidor. <https://github.com/simplex-chat/simplexmq/blob/stable/protocol/simplex-messaging.md>
- Session: desacople IP↔identidad vía onion routing; sin servidor propio del usuario.
- `SEALED-SENDER-ARCHITECTURE.md`, `FASE4-CONTROL-PLANE-DESIGN.md`,
  `FASE4-SEALED-CALL-SIGNALING-DESIGN.md`, `FASE4-SLICE2B-PUSH-DESIGN.md`.
