# AegisLink — Roadmap de remediación de seguridad (auditoría 2026-06)

> Estado: **abierto**. Origen: auditoría de superficie (21 hallazgos) + auditoría profunda
> (4 críticos nuevos confirmados a mano + ~15 nuevos). Ningún hueco se cierra como "hecho"
> hasta estar **commiteado, testeado y mergeado a `main`** (regla de oro del proyecto).
>
> Orden: de **menor a mayor esfuerzo** para atacar rápido y mantener ritmo, PERO los
> CRÍTICOS (C-3…C-6) son **bloqueantes de cualquier push público** sin importar su posición.
> Cada "Ola" = una rama `fix/*` coherente (no fragmentar un mismo cambio en varias ramas).

## Leyenda
- 🔴 CRÍTICO · 🟠 ALTO · 🟡 MEDIO · 🔵 BAJO
- **Esf.**: XS (≤1h) · S (≤medio día) · M (≤2 días) · L (≤1 semana) · XL (arquitectónico)
- **Ref.**: mirar código/diseño de Session o SimpleX antes de implementar

---

## OLA 1 — Quick wins críticos/altos (one-liners y few-liners) · rama `fix/sec-wave1-failclosed`
Máximo impacto por línea cambiada. Todo XS. Hacer primero para cerrar sangrado inmediato.

| ID | Sev | Esf | Hallazgo | Archivo | Fix |
|----|-----|-----|----------|---------|-----|
| C-4 | 🔴 | XS | `encryptBody` cae a cleartext en `catch` | `desktop/src/main/ipc/database.ts:68-70` | Eliminar `catch { return body }`; dejar propagar. El write debe fallar, no degradar. |
| C-5 | 🔴 | XS | Clave DB escrita `plain:` en producción | `desktop/.../database.ts:35-40` | Replicar guard `if (app.isPackaged) throw` de `secureStorage.ts:71-75`. |
| — | 🟡 | XS | `getDbKey` regenera clave en silencio → pérdida de historial | `desktop/.../database.ts:52-55` | No regenerar: lanzar error y exponer flujo de recuperación al usuario. |
| A-11 | 🟠 | XS | `shell.openExternal()` sin validar esquema (clase Follina) | `desktop/.../index.ts:31-33` | Permitir solo `https:`/`http:`; `deny` lo demás. |
| A-12 | 🟠 | XS | Logging dev filtra fragmentos de ratchet | `desktop/.../client.ts:997-1006` | Gate tras flag dedicado `AEGIS_RATCHET_DEBUG`, hashear prefijos de clave. |
| HIGH-crypto | 🟠 | XS | `bytesEqual` no constant-time | `mobile/src/crypto/signal/ratchet.ts:132` | Reemplazar por XOR-acumulado constant-time (también en desktop). |
| A-4 | 🟠 | XS | CORS `?? '*'` abre todo si no se configura | `server/src/index.ts:41` | Fail-closed: si `CORS_ORIGIN` no está, rechazar (o lista vacía). |
| A-5 | 🟡 | XS | `globalThis.aegisEmitPollUpdate` side-channel | `server/.../handler.ts:333` | Convertir a método del relay / `EventEmitter` tipado. |
| LOW-cleanup | 🔵 | XS | `electron-updater` instalado sin usar; `title` muerto en notif | `desktop/package.json:19`, `notifications.ts:14` | Quitar dep; documentar override de title o quitar param. |

**Tests Ola 1**: round-trip `encryptBody/decryptBody`; `getDbKey` lanza en packaged sin safeStorage; `bytesEqual` constant-time (test de igualdad/longitud).

---

## OLA 2 — C-3: Fuga de chain key de grupo · rama `fix/sec-channelkey-leak`
🔴 CRÍTICO · Esf **M** · toca mobile + server + migración DB → **va junto en una rama**.

El campo `chainKeyB64` viaja en claro y el relay lo **persiste en SQLite**. El `ciphertextB64`
sellado ya transporta la clave; el campo es 100% eliminable.

Pasos:
1. `mobile/src/crypto/channelKey.ts` — quitar `chainKeyB64` de `SenderKeyDistributionMessage` (l.23) y de `sealSenderKeyFor` (l.122).
2. `mobile/src/socket/client.ts:828,846,965` — quitar del envío y recepción.
3. `server/src/relay/handler.ts:183,209` — quitar del schema Zod; `1150,1239,1258` — quitar de routing/persistencia.
4. `server/src/db/client.ts` — migración: drop columna `chain_key_b64` de `senderKeyDistRepo`.
5. Tests: `group-rekey-offline.test.ts` — quitar `chainKeyB64` (l.218-224,369); añadir assert de que el drain **no** contiene clave en claro.

**Ref.** SimpleX: SenderKeys nunca exponen material fuera del sobre por par-de-claves. Confirmar contra su `SenderKeys` design.

---

## OLA 3 — Autenticación de device link / revoke · rama `fix/sec-devicelink-auth`
Esf **S-M**. Cierra C-6 (crítico) + A-7 (alto) + device:link spam.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| C-6 | 🔴 | `DELETE /:aegisId/:deviceId` sin auth (`deviceLink.ts:152`) | Exigir firma Ed25519 sobre `aegisId\|deviceId\|timestamp`, verificar contra identity pubkey. |
| A-7 | 🟠 | `link-confirm` confía solo en posesión del token (`deviceLink.ts:105`) | Segundo factor: prompt en el device ya autenticado mostrando **fingerprint** de la nueva clave; persistir solo tras aprobación explícita. |
| MED | 🟡 | `device:link` socket sin auth ni rate-limit por target (`handler.ts:425`) | Rate-limit por `targetAegisId` (p.ej. 3/15min), descarte silencioso. |
| B-6 | 🔵 | Sin cap server-side de linked devices | Cap duro (p.ej. 5) en `devicesRepo.upsert`. |

**Ref.** Signal/SimpleX: el flujo de "link new device" siempre requiere confirmación interactiva en el device existente con verificación de fingerprint. **Mirar el linking flow de SimpleX (QR + confirmación).**

---

## OLA 4 — Endurecer crypto core · rama `fix/sec-crypto-hardening`
Esf **S**. Defensa en profundidad en el layer más crítico.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| HIGH | 🟠 | X3DH no zeroiza intermedios (dh1-4, dhOut, EK_sec, sharedSecret) | `try/finally` con `zeroize()` en `performX3DH` y `performX3DHReceiver` (igualar disciplina de `ratchet.ts`). |
| HIGH | 🟠 | PQXDH downgrade silencioso (solo `__DEV__`) | Telemetría local visible en prod (sin enviar al server) + indicador de sesión sin PQ; planear modo PQ-mandatory. |
| MED | 🟡 | ML-KEM shared secret sin check de all-zero | `assertNonZero` tras encaps/decaps. |
| A-10 | 🟠 | Desktop `saveSessionState` omite `createdAtMs` | Añadir el campo a la serialización (`desktop/.../client.ts:672`). |
| MED | 🟡 | Identity signing key derivada del box key (single point) | Documentar trade-off en threat model; evaluar modo split-key opcional. |
| LOW | 🔵 | Fingerprint de palabras solo 64-bit | Subir a 16 palabras (128-bit) o documentar que el hex es la verdad autoritativa. |

**Ref.** Signal Double Ratchet spec §3.5 (zeroization). Verificar contra `libsignal`.

---

## OLA 5 — Paridad desktop↔mobile del ratchet · rama `fix/sec-desktop-session-parity`
Esf **M**. El desktop quedó atrás en mecanismos anti-desync. Portar de mobile.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| A-9 | 🟠 | Desktop sin `withSessionLock` → desync permanente por glare | Portar `withSessionLock(aegisId)` (~20 líneas) a `getOrCreateSession` y adopción X3DH. |
| MED | 🟡 | Prekey secrets desktop solo en SecureStore | Portar tabla `prekey_secrets` + `loadSpkSecret/saveSpkSecret` (DB como fuente de verdad). |
| MED | 🟡 | Desktop `getOrCreateSession` sin fallback de directorio para signing key | Portar cadena de fallback de mobile (`lookupIdentity`). |
| LOW | 🔵 | Recovery fallback timer no se cancela en disconnect | Portar `recoveryFallbackTimers` Map + cleanup. |
| HIGH | 🟠 | **Cero tests en `desktop/src/`** | Suite mínima: `assertTrustedSender`, `assertKeyAllowed`, round-trip DB, `getDbKey`, `reviveBytes`. |

---

## OLA 6 — Metadatos de llamadas (sealed-sender) · rama `fix/sec-call-sealed-sender`
🟠 ALTO · Esf **M-L** (puente) / **XL** (épica). El gap de metadatos más grande: las llamadas exponen `from` al relay.

> **ACTUALIZADO 2026-06-19:** al investigar A-6 se confirmó que el leak está **a la par
> de los envelopes** (handler.ts:572 estampa `from: me` igual). No es un fix de llamadas
> sino del **transporte completo**. Modelo elegido = **Signal sealed-sender** (submission
> sin auth + delivery token + identidad del emisor sellada dentro del sobre), que **conserva
> `aegisId` y el onboarding** (marca, NO negociable). SimpleX (colas sin identidad) se
> estudió y **descartó por marca**. **Diseño en [docs/SEALED-SENDER-ARCHITECTURE.md].**
> Siguiente entregable = Fase 0 (spike del sobre sealed + delivery token + medir latencia).

- `handler.ts:1525` — `forward()` añade `from: me` a todo evento de señalización.
- Fix: cifrar el payload de señalización (SDP/ICE) contra la pubkey del callee; el relay reenvía blob opaco a `to` sin aprender `from` (identidad embebida en el payload cifrado), igual que envelopes.
- Llamadas grupales: documentar como limitación inherente; evaluar modelo de "designated forwarder" futuro.
- LOW relacionado: TURN→STUN fallback filtra IP real (`ice.ts:39`) → fallar la llamada en vez de degradar, o toggle opt-in.

**Ref.** Signal usa sealed-sender para señalización. **SimpleX no usa identificadores en absoluto (colas unidireccionales)** — mirar su modelo de señalización de llamadas; es el estándar de oro en metadatos.

---

## OLA 7 — Autenticación de endpoints sin proteger · rama `fix/sec-endpoint-auth`
Esf **S-M**. Varios endpoints confían en conocimiento de un ID, no en prueba criptográfica.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| A-8 | 🟠 | `voterHash` client-supplied → ballot stuffing (`polls.ts:33`) | Derivar server-side: firmar voto con Ed25519, `voterHash = SHA256(pollId\|signerPubKey)`. |
| MED | 🟡 | Work GET sin firma (`work.ts:692,791`) | Aplicar `verifySig()` como en los endpoints de mutación. |
| MED | 🟡 | TURN credentials sin auth (`turn.ts:39`) | Mover tras socket autenticado o exigir PoW. |
| C-1 | ✅ | Blob download sin auth (`blob.ts:125`) — recalibrado MEDIO | **HECHO** (`fix/sec-blob-download-auth`): `download/:id` exige `?t=HMAC(BLOB_SECRET,id)` (constant-time, fail-closed en prod). Token minteado en upload, viaja como 5º componente de la URI `blob:` dentro del sobre E2EE. Paridad mobile+desktop; legacy v1 (4 partes) aceptado. Tests server+mobile. |

---

## OLA 8 — Mensajes efímeros + Work E2EE server-enforced · rama `fix/sec-ephemeral-work`
Esf **M**.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| A-3 | ✅ | Timer efímero solo client-side | **HECHO** (`fix/sec-ephemeral-work`): `ephemeralTtl` opcional en `EnvelopeIn`/`EnvelopeV2In` (bound ≤ MESSAGE_TTL_MS); el relay fija `expires_at = createdAt+ttl` al encolar, `purgeExpired` lo borra a su expiración. Mobile+desktop envían el TTL derivado de `expiresAt`. Test de regresión. |
| M-6 | ✅ | Work `channel:msg` body en cleartext en DB | **HECHO**: el relay rechaza `channel:msg` salvo `encrypted:true` + `nonce` (`encryption_required`, fail-closed). Nunca persiste body legible. Test de regresión. |
| B-5 | ✅ | FTS5 indexa body cifrado (gibberish) | **HECHO**: los triggers FTS indexan body `''` (búsqueda full-text server-side imposible sobre E2EE → client-side). Migración recrea triggers + `delete-all` para evictar ciphertext previo. |

---

## OLA 9 — Rate limiting distribuido + hardening server · rama `fix/sec-ratelimit-redis`
Esf **M**.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| A-1 | ⏸️ | Rate limits in-memory no compartidos entre instancias | **DIFERIDO** (follow-up de infra): despliegue mono-instancia → no es vuln activa. Migrar a Redis solo al escalar horizontalmente; añade dependencia dura + riesgo en la VM ([[incident_n8n_oom_vm]]). No bundlear en hardening. |
| MED | ✅ | Mapas de rate-limit con eviction FIFO → reset por desbordar cap | **HECHO** (`fix/sec-ratelimit-hardening`): `evictExpired()` solo expulsa entradas con ventana ya vencida, nunca contadores activos de víctimas. Los 3 buckets (channelMsg/lowFreq/rekey) lo usan. |
| A-2 | ✅ | PoW registro 14 bits → ID squatting | **HECHO**: dificultad parametrizada por challenge y atada a la emisión (anti-downgrade). `REGISTRATION_POW_DIFFICULTY=18` en prod (vs 14 base de blobs); el cliente ya lee `difficulty` del challenge. Test de regresión. |
| MED | ✅ | Sin validación de clock skew en timestamps | **RESUELTO POR DISEÑO**: el relay sella `createdAt`/`created_at` server-side (`Date.now()`) en todo path persistido; `EnvelopeIn` ni acepta `createdAt` del cliente; `verifyAdminSig`/TURN ya validan `ts` ±60s. Sin código nuevo (evita dead code). |
| MED | ✅ | IPC desktop sin validación de longitud | **HECHO**: `assertMaxLen()` en handlers IPC del main (ratchet `stateJson` ≤1MB, message `body`/`mediaUri` ≤8MB) — defensa contra renderer comprometido. |
| B-8 | ✅ | DNS rebinding en `proxyLinkPreview` | **HECHO**: `assertPublicHost()` resuelve A/AAAA y rechaza si CUALQUIER IP cae en rango bloqueado (`isBlockedIp`, +CGNAT +IPv4-mapped), antes del fetch inicial y tras redirects. Ventana TOCTOU residual → firewall de egress (ops). Test de regresión. |

---

## OLA 10 — Cifrado at-rest completo (SQLCipher) · rama `fix/sec-sqlcipher`
🟡 MEDIO · Esf **XL** (arquitectónico). El cambio más grande, alineado con "cero metadatos".

- Hoy se cifran campos individuales; quedan en claro: schema, `chat_id`, `created_at`, conteos, membresía, delivery status, WAL/journal.
- Mobile: `expo-sqlite` con SQLCipher vía módulo nativo. Desktop: `better-sqlite3-multiple-ciphers`.
- Interino: cifrar columnas restantes o cifrado determinista para columnas indexadas.

**Ref.** SimpleX cifra toda la DB con SQLCipher por defecto. **Mirar su esquema de derivación de la clave de DB desde la passphrase del usuario.**

---

## OLA 11 — Pinning, rotación, lifecycle · rama `fix/sec-pinning-rotation`
Esf **M-L**.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| M-1 | ✅ | Sin certificate pinning en mobile (`config.ts:32`) | **YA EXISTÍA** (auditado): `app.plugin.js` genera `network_security_config.xml` con pinning SPKI SHA-256 (leaf + intermedio LE + backup offline en frío), cablea `android:networkSecurityConfig`, fail-closed cleartext, `debug-overrides` solo en builds debuggables. Cubre fetch Y socket.io a nivel OS. iOS pendiente (sin target iOS todavía). |
| C-2 | ✅ | Desktop keystore sin segundo factor (DPAPI = usuario de sesión) | **Fase 1** (#74): lock desktop era un stub (cualquier PIN de 4 dígitos abría) → PIN Argon2id real con salt por-install + constant-time + rate-limit→pánico (paridad mobile). **Fase 2** (`fix/sec-c2-fase2-dbkey-wrap`): la DB key SQLCipher se envuelve con una KEK derivada del PIN (Argon2id) **dentro** de la capa DPAPI → `dpapi(secretbox(dbKey,nonce,KEK))`. Apertura de la DB diferida hasta unlock en frío; ni con la sesión del SO se abre sin el PIN. Opt-in atado al lock; sin recuperación (PIN perdido = historial irrecuperable). Tests: `database.pinwrap.test.ts` + `dbKeyWrap.test.ts`. |
| B-3 | ✅ | Sin rotación automática de SPK | **HECHO** (`feat/b3-spk-rotation`): trigger por edad ~semanal en `auth:ok` (mobile+desktop), stamp `createdAt` durable, grace window ampliado a K=5 SPK (≥28 días, cubre cola relay 30d). Tests mobile (harness auth:ok) + desktop (helpers puros). |
| GROUP | ✅ | SenderKey sin rotación al remover miembro | **YA EXISTÍA** (auditado): `rekeyGroupAfterRemoval` genera clave fresca, sellada solo a los que quedan, sealed-sender, con test de regresión. |
| M-2 | ✅ | OPK no per-device | `fix/sec-m2-opk-per-device`: `prekeys_onetime` ahora lleva `device_id` (PK `(aegis_id, device_id, key_id)`), espejando SPK/PQ-SPK. `getBundles` hace `pop` del OPK del pool **del propio device** (no del compartido) → un device ya no recibe un OPK ajeno (X3DH DH4 fallaba). `auth:ok` devuelve `countOneTime(me, deviceId)` per-device. Migración idempotente (PG ALTER+PK, SQLite drop+recreate guardado). Clientes sin cambios (deviceId ya viaja en el body). Test: two-device OPK isolation en `prekeys.test.ts`. |
| M-4 | ✅ | Sin CSP en landing/web servida por relay | **HECHO** (`fix/sec-csp-landing`): CSP global `default-src 'none'` para la API JSON/blob + CSP por-página en `/g` `/a` con `script-src 'sha256-…'` (script inline pineado por hash, sin `'unsafe-inline'`). Test `links.csp.test.ts` verifica que el hash casa con el script servido. |

**Ref.** Signal: rotación de SPK y re-key de grupo en cambio de membresía. libsignal `SenderKey`.

---

## OLA 12 — Lifecycle de datos + UX de fallos · rama `fix/sec-data-lifecycle`
Esf **S-M**. Mayormente robustez y privacidad de borde.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| B-2 | ✅ | Sin endpoint de account deletion | `fix/sec-b2-account-deletion`: `DELETE /identity/:id` autenticado por firma Ed25519 sobre `${aegisId}:delete:${bucket}` (±60s, mismo PoK que prekeys — regla #3). `identityRepo.deleteAccount` borra en cascada todo el rastro server-side: identidad, prekeys (SPK/OPK/PQ), mensajes y dist. de SenderKey en cola (por recipient), push + delivery tokens, linked_devices. Sealed-sender ⇒ no hay copias salientes que borrar. Test: `identity.delete.test.ts` (borra+cascada, firma forjada→403, ts viejo→400, id desconocido→404). UI cliente (botón "borrar cuenta" + wipe local) = follow-up. |
| B-1 | ✅ | `MAX_DRAIN_DEVICES=2` insuficiente | `fix/sec-ola12-drain-cors-hardening`: cap de drain dinámico `drainCapFor()` = `max(2, 1 primary + linked_devices activos)`. El 2 pasa a ser floor (`MIN_DRAIN_CAP`), así que el cambio solo puede alargar la vida de una fila, nunca acortarla → imposible sub-entrega. `devicesRepo.countActive` cuenta no-revocados. Aplicado a `messageRepo` y `senderKeyDistRepo`. Test `drain-cap.test.ts` (3 devices sobreviven a 2 drains; floor; revocados no inflan). |
| B-7 | 🔵 | Uploads TTL 24h sin aviso | Cliente maneja 404 graceful: "adjunto expirado". |
| M-3 | ✅ | `drained_by` JSON en TEXT sin validar | `fix/sec-ola12-drain-cors-hardening`: helper `parseDrainedBy()` compartido valida `Array.isArray` + filtra a strings; payload corrupto/no-array degrada a `[]` en vez de lanzar en el `.includes()`/`.push()` downstream. Reemplaza los 4 IIFE con cast inseguro (`as string[]`) en ambos repos. Test directo del helper (`42`, `{}`, `null`, no-json, elementos no-string). |
| M-5 | 🟡 | 130 `console.log` en mobile | Logger con levels stripeado en build. |
| MED | ✅ | Desktop CORS wildcard inyectado para renderer | `fix/sec-ola12-drain-cors-hardening`: `Access-Control-Allow-Origin` pasa de `*` al origen exacto del renderer (`new URL(ELECTRON_RENDERER_URL).origin` en dev; `'null'` empaquetado vía `file://`). El CSP `connect-src` ya limita destinos al relay; sin auto-test (gap de infra de tests desktop, A-9). |
| MED | ✅ | Padding de metadata puede fallar bucket en UTF-8 | `fix/sec-ola12-metadata-padding`: `stripAndPad` reescrito determinista — bucket elegido sobre la longitud en **bytes** UTF-8 + filler de espacios ASCII (1 byte) hasta el bucket exacto, en una pasada. Elimina el campo `pad` random, el loop de 4 iteraciones y los 3 fallbacks. Paridad mobile↔desktop byte-idéntica; `unpad` retrocompatible (sigue stripeando whitespace). Test `metadata.test.ts`: fuzz ASCII + UTF-8 multibyte (😀/€/中) asegura `output.length ∈ BUCKETS` siempre y bucket mínimo; round-trip intacto. |
| B-4 | 🔵 | Pantallas críticas sin tests | Profile, Privacy, Lock, Backup, Devices, GroupPosts, etc. |

---

## Secuencia recomendada (rápido → profundo, con críticos al frente)
1. **Ola 1** (quick wins, cierra C-4/C-5) → 2. **Ola 2** (C-3) → 3. **Ola 3** (C-6/A-7) →
4. **Ola 6** (sealed-sender llamadas — el diferenciador de mercado) → 5. **Ola 4 + 5** (crypto + paridad) →
6. **Ola 7 + 8 + 9** (endpoints, efímeros, rate-limit) → 7. **Ola 10** (SQLCipher) →
8. **Ola 11 + 12** (pinning, rotación, lifecycle).

> Las Olas 1-3 cierran **todos los críticos**. Ninguna distribución pública antes de eso.
