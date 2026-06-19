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
| C-1 | 🟡 | Blob download sin auth (`blob.ts:125`) — recalibrado MEDIO | Token HMAC corto vinculado al mensaje: `HMAC(blobId, sharedSecret)` dentro del sobre. |

---

## OLA 8 — Mensajes efímeros + Work E2EE server-enforced · rama `fix/sec-ephemeral-work`
Esf **M**.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| A-3 | 🟠 | Timer efímero solo client-side | Enviar `ephemeralTtl` en el envelope; el relay respeta TTL corto en la cola offline. |
| M-6 | 🟡 | Work `channel:msg` body en cleartext en DB (`handler.ts:994`) | Cifrado obligatorio server-side-enforced; rechazar body no cifrado. |
| B-5 | 🔵 | FTS5 indexa body cifrado (gibberish) | Lógica condicional: no indexar si `encrypted:true`; búsqueda client-side. |

---

## OLA 9 — Rate limiting distribuido + hardening server · rama `fix/sec-ratelimit-redis`
Esf **M**.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| A-1 | 🟠 | Rate limits in-memory no compartidos entre instancias | Migrar a Redis (sliding window) — TODO ya marcado. |
| MED | 🟡 | Mapas de rate-limit con eviction FIFO → reset por desbordar cap | LRU o sliding-window en store persistente. |
| A-2 | 🟠 | PoW registro 14 bits → ID squatting | Subir a 18-20 bits en prod; vincular a IP rate-limit. |
| MED | 🟡 | Sin validación de clock skew en timestamps | Clamp `createdAt` a ±5min de server time al encolar. |
| MED | 🟡 | IPC desktop sin validación de longitud | Asserts de tamaño en handlers (`stateJson < 1MB`, etc.). |
| B-8 | 🔵 | DNS rebinding en `proxyLinkPreview` | Resolver DNS y validar IP contra blocklist antes de fetch. |

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
| M-1 | 🟡 | Sin certificate pinning en mobile (`config.ts:32`) | Pinning por hash de pubkey del server. |
| C-2 | 🟡 | Desktop keystore sin segundo factor (DPAPI = usuario de sesión) | PIN/passphrase del usuario como segunda capa (igual que mobile + biometría). |
| B-3 | 🟠 | Sin rotación automática de SPK | Rotación ~semanal (Signal). |
| GROUP | 🟡 | SenderKey sin rotación al remover miembro | Verificar/forzar re-key + redistribución al cambiar membresía (si no existe → ALTO). |
| M-2 | 🟡 | OPK no per-device | Pool de OPK per-device o consumo coordinado. |
| M-4 | 🟡 | Sin CSP en landing/web servida por relay | Header CSP en `linksRoutes`. |

**Ref.** Signal: rotación de SPK y re-key de grupo en cambio de membresía. libsignal `SenderKey`.

---

## OLA 12 — Lifecycle de datos + UX de fallos · rama `fix/sec-data-lifecycle`
Esf **S-M**. Mayormente robustez y privacidad de borde.

| ID | Sev | Hallazgo | Fix |
|----|-----|----------|-----|
| B-2 | 🔵 | Sin endpoint de account deletion | `DELETE` de identidad autenticado por firma. |
| B-1 | 🔵 | `MAX_DRAIN_DEVICES=2` insuficiente | Escalar dinámicamente al `linked_devices` count. |
| B-7 | 🔵 | Uploads TTL 24h sin aviso | Cliente maneja 404 graceful: "adjunto expirado". |
| M-3 | 🟡 | `drained_by` JSON en TEXT sin validar | Validar shape parseado o tabla de join. |
| M-5 | 🟡 | 130 `console.log` en mobile | Logger con levels stripeado en build. |
| MED | 🟡 | Desktop CORS wildcard inyectado para renderer | Inyectar origen específico (`file://` / `localhost:517x`), no `*`. |
| MED | 🟡 | Padding de metadata puede fallar bucket en UTF-8 | Test que asegure output == bucket exacto; padding simplificado. |
| B-4 | 🔵 | Pantallas críticas sin tests | Profile, Privacy, Lock, Backup, Devices, GroupPosts, etc. |

---

## Secuencia recomendada (rápido → profundo, con críticos al frente)
1. **Ola 1** (quick wins, cierra C-4/C-5) → 2. **Ola 2** (C-3) → 3. **Ola 3** (C-6/A-7) →
4. **Ola 6** (sealed-sender llamadas — el diferenciador de mercado) → 5. **Ola 4 + 5** (crypto + paridad) →
6. **Ola 7 + 8 + 9** (endpoints, efímeros, rate-limit) → 7. **Ola 10** (SQLCipher) →
8. **Ola 11 + 12** (pinning, rotación, lifecycle).

> Las Olas 1-3 cierran **todos los críticos**. Ninguna distribución pública antes de eso.
