# AegisLink — Roadmap (producto normal)

> **Creado:** 2026-07-05 · **Alcance:** **AegisLink normal** únicamente.
> Fuente de verdad forward-looking. Complementa (no reemplaza) el histórico ya cerrado
> en `SECURITY-ROADMAP-2026-06.md` (12 olas) y `AUDIT-2026-06-30-FULL.md`. El backlog
> `backlog_fases3_4.md` queda como registro de Fase 3/4; su estado de features sigue vigente.
>
> **Auditoría externa 2026-09-16:** 11 hallazgos verificados (10 correctos, 0 falsos positivos) en
> `AUDIT-2026-09-16-EXTERNAL-VERIFICATION.md` — es la fuente canónica de su estado. Tres de ellos
> (AL-02/07/09) se cierran ejecutando el Hito 1 de este roadmap.

## Alcance y exclusiones (decisión 2026-07-05)

**FUERA de este repo y de este roadmap:**
- **Sección 13 — AegisLink Work (enterprise: orgs, salas, roles, dashboard).** Tendrá su
  **propio repositorio** cuando se arranque. Todo el código Work se **extrae o elimina** de
  este repo (ver Hito 1). Los hallazgos de auditoría Work (H1, H2, M2) viajan con él.
- **Sección 14 — Pagos anónimos cripto / suscripciones (Lightning, etc.).** Es la
  monetización de Work → se va con Work. Los prototipos muertos en `mobile/src/_unused/`
  se eliminan de este repo (Hito 1).

**DENTRO de alcance:** las 12 secciones de mensajería personal E2EE (onboarding anónimo,
identidad on-device, chat 1:1, efímeros, adjuntos, grupos con votación, llamadas voz/vídeo,
pánico, backup, perfiles múltiples, mensajes programados) — todas ya implementadas; el roadmap
es de **consolidación, privacidad-por-defecto y alcance de plataforma**, no de features nuevas.

---

## Hito 0 — Desbloquear y sanear el árbol ✅ HECHO (2026-07-05)

CI de los dos PRs abiertos estaba en rojo. Reglas de oro de ramas/estructura rotas. Cerrado antes de seguir.

- [x] **Verde PR #240**: la causa real (a la hora de cerrar) no fue el `async` de `handler.ts:185`
      ni el lock de `typescript@5.9.3` — ambos ya habían sido arreglados en commits previos de la
      rama (`ecc8470`, `e7a74e1`). El único job en rojo era **Mobile tests**, por una aserción de test
      desactualizada (`client.deleteForEveryone.test.ts:269` esperaba la firma vieja de 2 args de
      `remoteDelete`, la implementación real y correcta ya usa 3 args para scoping por `senderId`).
      Fix: commit `64c89cd`. Mergeado a `main` en `08f4997`.
- [x] **Verde PR #239** (`feat/multi-device-spk`): la consolidación con #240 que este roadmap pedía
      ya había ocurrido — la rama `feat/multi-device-spk` se fusionó dentro de `feat/mnemonic-and-redis`
      antes de este cierre. Al mergear #240, GitHub detectó los commits y auto-cerró #239 como
      `MERGED` con el mismo merge commit (`08f4997`). Sin acción adicional.
- [x] **Basura trackeada fuera de git**: ya resuelto en un commit previo de la propia rama
      (`6241898 chore: untrack transient review/debug dumps (Hito 0)`), incluido en el merge de #240.
      Verificado post-merge: `alerts.json`, `all_alerts.json`, `mobile/crash2.txt`, `server/.expo/**`
      ya no están trackeados y sí están en `.gitignore`.
- [x] **Stash huérfano**: `stash@{0}: WIP on fix/decoy-pin-length` no era descartable — contenía una
      feature real y completa (ocultar view-once/scheduled/location en el attach sheet de grupos,
      `isGroup` prop + tests). Aplicado en rama `fix/attach-sheet-group-scope` (commit `c7df869`,
      15/15 tests verdes), stash dropeado. **Pendiente**: [PR #246](https://github.com/gabinotech22-cmyk/AegisLink/pull/246)
      abierto, aún sin mergear — único punto no cerrado de este hito.
- [x] **Ramas zombi**: `fix/dependabot-alerts` y `fix/technical-debt-audit` ya no existían (limpiadas
      antes de este cierre). Se encontraron y borraron en su lugar dos ramas distintas con diff neto
      cero contra `main` (contenido ya absorbido vía PR #233 y #237 con otros hashes):
      `fix/channel-header-name` y `fix/panic-lock-gestures`.
- [x] **Todo a `main`**: además de #239/#240, la auditoría de ramas huérfanas encontró **5 ramas más**
      sin PR abierto con trabajo real no fragmentario (`chore/repo-hygiene-rules`, `docs/onion-deployed-status`,
      `feat/mailbox-mode-production`, `fix/decoy-pin-length`, `fix/security-remediation`) — todas viejas
      (26-35 commits detrás), 3 con conflictos de merge reales. Resueltos vía subagentes en worktrees
      aislados (sin debilitar ninguna validación de seguridad al reconciliar `blob.ts`/`publicChannels.ts`)
      y mergeados como PR #241–#245. Cero ramas remotas huérfanas al cierre, salvo #246 en curso.

## Hito 1 — Extraer Work + pagos de este repo ✅ HECHO (2026-09-17)

Último `main` con el código Work: `976c09f` (recuperable por SHA al crear el repo Work). Cierra AL-02/07/09 de la auditoría 2026-09-16.

Objetivo: dejar este repo como **AegisLink normal puro**. El código Work es un bloque coherente
y separable (NO enredado con los canales públicos sellados, que son normales y viven en
`publicChannels.ts`). Rama dedicada `chore/extract-work` (NO sobre #240).

**Superficie Work identificada:**
| Capa | Archivos |
|---|---|
| Server REST | `server/src/routes/work.ts`, wiring en `server/src/index.ts:17,174,205` |
| Server DB | `server/src/db/repos/work.ts`, re-export `db/client.ts:661`, tablas `work_*`/`workspaces*` en `db/pg.ts` y `db/sqlite.ts` |
| Server relay | `server/src/relay/handlers/channels.ts` (`work:join`/`channel:*` de org), schemas Work en `relay/schemas.ts` |
| Server tests | `__tests__/workSenderKeyTrust.relay.test.ts`, `workspace.auth.test.ts`, partes de `ola8.relay.test.ts` |
| Mobile | iconos `assets/icon-work.*`, `android-icon-assets/work/**`, strings i18n `work.*` |
| Pagos (muerto) | `mobile/src/_unused/screens/Subscription.tsx`, `mobile/src/_unused/web3/payments/LightningPayment.ts` |
| Pagos (restos que se escaparon) | `server/src/routes/web3.ts` (`/subscription/invoice`, `/subscription/activate`), DDL `lightning_invoices`/`subscriptions`, `desktop/src/renderer/screens/Subscription.tsx` (accesible desde Perfil) — eliminados después, ver abajo |

**Hecho (PR `chore/extract-work`):**
- [x] **Preservado en historia git** (`976c09f`); sin branch de archivo.
- [x] **Prototipos de pagos** `mobile/src/_unused/**` borrados; `tsconfig` ya no los excluye.
- [x] **Restos de pagos en relay y desktop** (se escaparon de este hito): endpoints
      `/web3/subscription/*`, su DDL y la pantalla `Subscription.tsx` del desktop, que ofrecía
      una factura simulada imposible de pagar. Eliminados en #525 (`AUDIT-2026-09-24-WEB3-DID.md`
      P-1). Las tablas huérfanas `lightning_invoices`/`subscriptions` siguen la misma regla que las
      de Work: el `DROP` es operador-local.
- [x] **Server**: router `/work`, `repos/work`, tipos Work, schemas Work, rate-limit de `channel:msg`,
      rama Work del `typing`, presencia de org y el cron `pruneExpiredWorkMessages` eliminados.
      Los handlers `group:rekey`/`group:rekey_drain_ack` de grupos normales, que convivían en
      `handlers/channels.ts`, viven ahora en `handlers/groups.ts` sin cambios (mismos tests).
- [x] **Schema DB**: `CREATE TABLE work_*`/`workspaces*`/FTS y sus migraciones retirados de `sqlite.ts`
      y `pg.ts`. Las tablas huérfanas de despliegues existentes **no se tocan** desde el código
      (regla de oro de herramientas destructivas): un `DROP` es operador-local.
- [x] **Verificado**: tsc server/mobile, suites de grupos (`group-rekey-offline`, `drain-storm`,
      `drain-cap`, `ackScoping`, `ola8`) verdes; canales públicos sellados intactos.
- [x] **Doc↔código**: `backlog_fases3_4.md` (P1/G2), `PROJECT-STRUCTURE.md`, informe de auditoría
      (AL-02/07/09 cerrados por extracción).

## Hito 2 — Privacidad por defecto: sealed-sender activo 🟡 (diferenciador de mercado)

> Nota de vigencia (2026-09-23): el hallazgo original de 2026-07-05 ("`MAILBOX_MODE` OFF por
> defecto") ya no es cierto. Estado canónico en `docs/SEALED-SENDER-ARCHITECTURE.md` §5–§6.

- [x] **Buzón por defecto:** `MAILBOX_MODE` es opt-out desde F5b (#491) y fail-closed sin onion
      (`mobile/src/config.ts`); producción lo lleva ON desde 1.0.x.
- [x] **Indicadores en tiempo real sellados siempre (2026-09-24):** `typing` y read receipts viajan
      solo como mensajes E2EE sellados en todos los transportes; los eventos en claro del relay
      (`messaging.ts`) y sus listeners en mobile/desktop, eliminados. `AUDIT-2026-09-24-WEB3-DID.md`
      R-1; `docs/SEALED-SENDER-ARCHITECTURE.md` §6.1.
- [x] **v1 solo como último recurso + llamadas selladas en el oficial (2026-09-20):** con raíz de
      buzón conocida el cliente emite siempre v2 (primer contacto incluido); llamadas a contactos
      que anuncian `sealed-calls` por buzón. Gateado por `caps` en el perfil para convivir con
      1.0.6. `docs/PROTOCOL.md` §7.3. Pendiente: retirar v1 en el relay tras `APP_MIN_VERSION`.
- [x] **Tor siempre activo en mobile (2026-09-23):**
      - socket de control y todo el HTTP al relay por la onion, en un circuito separado del buzón;
      - sin interruptor ni respaldo por clearnet;
      - imágenes remotas por Tor y avatares-URL rechazados;
      - rate limits del relay por identidad sobre Tor.

      SEALED-SENDER §6.2; PROTOCOL §9.
- [x] **Bridges Tor (Snowflake/obfs4/meek + propios)** en mobile y desktop (2026-09-24):
      - modo automático que escala solo cuando el arranque se atasca;
      - bridges integrados de Tor Browser;
      - líneas propias validadas;
      - pantalla Privacidad → Red → Conexión a Tor.

      Desktop verificado con Tor real (Snowflake 100% en 51 s, obfs4 en 123 s). PROTOCOL §9.
- [ ] Verificar bridges en Android + iOS con build nativo (IPtProxy nuevo en los plugins).
- [ ] Verificar en 2 dispositivos reales (Android + iOS) el control-plane por Tor con circuitos
      aislados (build nativo nuevo: los plugins `withTorEmbedded*.js` cambiaron).

## Hito 3 — Terminar el endurecimiento cripto 🟠

- [x] **H3 — unificar `@noble/hashes`** ✅ (2026-09-25): mobile pasa de 1.8 a 2.4.0, la misma versión
      que desktop (imports con `.js`; `sha256` → `sha2.js`). El parche `nobleNextTickPatch` (que
      hacía ceder el hilo al PBKDF2 de backups v1/v2) no funciona con el ESM de v2, así que ese
      PBKDF2 pasa al núcleo C (`aegis_pbkdf2_sha256`, asíncrono, mismos bytes que @noble) y el
      parche se borra. Pruebas: `noble-kat.test.ts` (mismos vectores en las dos plataformas),
      `differential.mjs` (PBKDF2 C vs @noble y RFC 7914), `sodium-facade.test.ts`,
      `backup.test.ts` (backups v1/v2/v3). La verificación Metro en dispositivo la hace el E2E de
      Android del CI (compila el APK con Metro).
- [x] **F-1 — núcleo cripto nativo** ✅ (en mobile, efectivo desde el primer build nativo que lo incluya): portar hot-path (X25519, XSalsa20-Poly1305, Ed25519, HKDF/HMAC)
      a libsodium, conservando la capa TS. Cierra el gap constant-time a través del JIT. Sustitución de
      implementación, **no** cambio de protocolo (bytes idénticos, sin forzar actualización; sí exige
      build nativo nuevo, no OTA).
  - [x] **Spike (2026-09-24)**: libsodium 1.0.21 compilado desde fuente (firma minisign verificada)
        da bytes idénticos a TweetNaCl/@noble. `react-native-libsodium` se descarta (trae binarios
        precompilados: rompe builds reproducibles y F-Droid) → módulo JSI propio. Desktop:
        `sodium-native` en el proceso main, renderer vía `ipcRenderer.sendSync` (0,20 ms/X25519).
        Server: `sodium-native` no carga en Alpine (solo glibc) → imagen Debian slim.
  - [x] **Costura única** (#528): todo el código de producto obtiene NaCl/hash/HMAC/HKDF solo de
        `crypto/sodium` (mobile, desktop renderer y main, server), con guarda
        `crypto-imports.test.ts` y fixture dorado pre-libsodium `f1-golden.json` (`f1-golden.test.ts`
        en las 3 plataformas).
  - [x] **B1 — relay y desktop en libsodium nativo**: `sodium-native` 5.1.0 (libsodium 1.0.21) en el
        relay (`server/src/crypto/sodium/native.ts`) y en el proceso main de desktop (gemelo byte a
        byte); el renderer lo usa por IPC síncrona (`desktop/src/main/ipc/sodium.ts`, tabla validada en
        `ops.ts`), adjuntos por IPC asíncrona; HMAC/HKDF en `node:crypto` (SHA-2 sin clave sigue en el
        renderer: el PoW de registro son ~260k hashes). Pruebas:
        `sodium-native.differential.test.ts` (server y desktop), `sodium-ops.test.ts`,
        `sodium-facade.test.ts`, `f1-golden.test.ts`, firma universal de orden pequeño rechazada
        (`ed25519.test.ts`). Relay en imagen Debian slim (uid/gid 100/101 conservados) y `deploy.yml`
        aborta sin reiniciar si `sodium-native` no carga en el host. `tweetnacl` pasa a devDependency.
  - [x] **B2 — mobile en libsodium nativo**: módulo Expo local `mobile/modules/aegis-sodium` que
        compila libsodium **1.0.22 desde fuente** (vendorizado; firma minisign + SHA-256 del tarball
        verificados por `mobile/scripts/vendor-libsodium.mjs`, cada fichero fijado por
        `vendor-manifest.test.ts`) y un núcleo C (`cpp/aegis_sodium.c`) que valida toda longitud antes
        de llamar a libsodium. Android: CMake + JNI (`android/`, 16 KB page-aligned); iOS: podspec +
        Swift (`ios/`). La fachada `mobile/src/crypto/sodium` llama por JSI síncrono; HMAC/HKDF
        (`crypto_kdf_hkdf_sha256`) y el CSPRNG (`randombytes_buf`, también detrás del shim
        `getRandomValues` de @noble) pasan a nativo; SHA-2 sin clave sigue en JS, como en desktop. Sin
        fallback JS: sin el módulo en el binario, el cripto no arranca. Pruebas: job de CI
        `aegis-sodium-native` (núcleo C compilado para host vs TweetNaCl/@noble, optimizado y con
        ASan/UBSan: `modules/aegis-sodium/test/differential.mjs`), `sodium-facade.test.ts`,
        `f1-golden.test.ts` y toda la suite de Jest sobre libsodium real (`jest/nodeBackend.ts`,
        sodium-native). `tweetnacl` pasa a devDependency (oráculo de tests). Pendiente de verificar
        en dispositivo con el primer build EAS (Android e iOS).
- [ ] **F-1b — claves en memoria nativa (handles opacos)** 🟡: tras F-1, las claves privadas viven
      solo en memoria nativa (módulo en mobile, proceso main en desktop) y JS recibe un handle, como
      libsignal. Un XSS en el renderer ya no podría leer claves. Alcance aprobado (2026-09-25): fases 1
      (identidad), 2 (prekeys + ML-KEM desktop) y 3 (ratchet). Diseño:
      [`F1B-KEY-VAULT-DESIGN.md`](./F1B-KEY-VAULT-DESIGN.md).
      - [x] **1a — bóveda** ✅: C core `cpp/aegis_vault.c` (memoria guarded, handles, blobs
        envueltos con la KEK del perfil, slot autenticado) con la KEK en Keystore/Keychain
        (`VaultKek.kt`, `VaultKek.swift`); desktop en el proceso main (`main/crypto/vault/`, KEK en
        `safeStorage`, canal `vault:call`). Fachadas `crypto/sodium/vault.ts` en las dos plataformas.
        Pruebas: `differential.mjs` (bóveda C vs TweetNaCl/@noble, aislamiento, manipulación,
        liberación, bloqueo), `vault.test.ts` gemelos, `main/crypto/vault/__tests__/ops.test.ts`.
      - [x] **1b — claves de identidad** ✅: `Identity.secretKey`/`signingSecretKey` son handles de
        la bóveda en las dos plataformas; firmar, cifrar, X3DH, sealed sender, grupos, canales y
        llamadas van por handle. Migración única al hidratar (clave cruda → blob `vault1:`),
        borrado criptográfico al borrar perfil y en pánico, exportación solo en backup, vincular y
        frase (en desktop, tras un diálogo nativo del proceso main). En desktop además gana las
        comprobaciones de integridad de `identityFromStored` que solo tenía mobile. Pruebas:
        `identityFromStored.*.test.ts` y `vaultExport.guard.test.ts` (gemelos),
        `store/__tests__/identity.vaultMigration.test.ts`, `ops.test.ts`, `differential.mjs`
        (`vault_export`, `vault_copy`).
      - [x] **2 — prekeys y ML-KEM desktop en main** ✅: SPK/OPK/PQSPK se generan y guardan en la
        bóveda (blobs; migración de las guardadas en crudo), el X3DH receptor y el primer paso del
        ratchet las usan por handle, y la SPK sale solo hacia los dispositivos vinculados del usuario.
        Blobs v2 con el tipo autenticado y tipo `x25519prekey` (el escritorio la sincroniza sin
        diálogo y la identidad sigue protegida). ML-KEM-768 del escritorio pasa al proceso main
        (@noble; sodium-native no lo expone). Pruebas: `differential.mjs` (tipo reetiquetado, v1,
        prekey), `ensureDevicePreKeys.test.ts` (migración), `ratchetSerde.persistence.test.ts`
        (no persiste handles), `vault.test.ts`, `ops.test.ts` (deviceSync), `crypto-imports.test.ts`
        (sin @noble/post-quantum en el renderer).
      - [ ] 3 — estado del Double Ratchet (C en mobile, main en desktop), sellado.
- [x] **Argon2id nativo en mobile** ✅ (#549; efectivo desde el primer build nativo que lo incluya):
      PIN y backup v3 corren en libsodium nativo, fuera del hilo de JS. **Sin formato de backup
      nuevo**: el núcleo C llama a `argon2id_hash_raw` (acepta salts de 8–64 B), así que los backups
      existentes (salt 32 B) y el salt de dominio del PIN de pánico dan los mismos bytes que @noble.
      Restaurar un backup v3 pasa de minutos a menos de un segundo. PIN nuevo `a4` (19 MiB, t=2;
      antes 2 MiB, t=1 por la lentitud de Hermes); `a3`/`a2` se re-hashean al desbloquear. Pruebas:
      `modules/aegis-sodium/test/differential.mjs` (parámetros exactos del PIN y del backup + vector
      de referencia), `sodium-facade.test.ts`, `lock/__tests__/pin.test.ts`, flujo Maestro
      `.maestro/03-app-lock-pin.yaml` en emulador. Desktop sigue con @noble (V8 lo hace en <1 s).
- [x] **Prueba de trabajo (PoW) nativa en mobile** ✅ (efectiva desde el primer build nativo que la
      incluya): el minero del registro, de subidas de blobs y de envíos al mailbox corre en C
      (`aegis_pow_sha256`, fuera del hilo de JS) en vez de ~260k SHA-256 en JS sobre Hermes. Mismo
      orden de nonces que el minero JS, así que devuelve el mismo nonce y el relay no cambia. Cierra
      el fix 1 del sospechoso "PoW vs TTL" de `ROADMAP-2026-07.md` §2. Pruebas:
      `modules/aegis-sodium/test/differential.mjs` (núcleo C vs minero JS de referencia, incl.
      dificultad 18 y challenge no ASCII), `crypto/__tests__/registration.solvePoW.test.ts`,
      `sodium-facade.test.ts`. Desktop sigue en JS (V8 con JIT).
- [x] **ML-KEM-768 nativo en mobile** ✅ (efectivo desde el primer build nativo que lo incluya):
      PQXDH (prekeys PQ) y el ratchet PQ corren en `crypto_kem_mlkem768` de libsodium, tras la
      fachada `ml_kem768` (misma API que @noble). **Sin migración**: byte a byte idéntico a
      @noble/post-quantum (misma semilla → mismo par de claves y misma clave secreta expandida de
      2400 B, descapsulación cruzada, mismo secreto de rechazo implícito), así que las prekeys PQ
      ya publicadas y los estados de ratchet guardados siguen funcionando. `@noble/post-quantum`
      pasa a devDependency (oráculo). Pruebas: `modules/aegis-sodium/test/differential.mjs`
      (núcleo C vs @noble, incl. claves generadas como las generaba la app y rechazo de claves
      inválidas), `sodium-facade.test.ts`, `f1-golden.test.ts` (sesión híbrida persistida con
      @noble 0.6.1), `crypto-imports.test.ts` (nada de @noble/post-quantum en producción).
- [ ] **ML-KEM-768 nativo en desktop**: sigue en @noble. `sodium-native` no trae ML-KEM, y el
      BoringSSL de Electron 42 genera claves ML-KEM pero **no importa la clave pública de otro**
      (no puede encapsular; probado en DER/SPKI, PEM, raw y JWK). Decisión del dueño (2026-09-25):
      se resuelve dentro de F-1b, cuando las claves del desktop salgan del renderer.
- [x] **"Partial coverage" de la auditoría 2026-06-30** ✅ (2026-09-25), verificado contra el código:
      - Zeroización de intermedios X3DH/PQXDH y `assertNonZero` del secreto ML-KEM: ya estaban en
        las dos plataformas (`x3dh.ts` y `ratchet.ts`, en `try/finally`). El único hueco era que
        `ratchetEncrypt` de desktop no borraba la clave de mensaje si el sellado lanzaba; ahora sí,
        como mobile. Test gemelo `crypto/signal/__tests__/ratchet.zeroize.test.ts` (mobile y desktop).
      - Barrido constant-time: las comprobaciones de escritura-y-relectura de secretos de prekeys
        en mobile (`x3dh.ts`, `registration.ts`, `socket/client.ts`) comparaban la clave con `===`;
        pasan a `secretB64Equals` (`crypto/secretEquals.ts`, test `secretEquals.test.ts`). El resto
        ya usaba `nacl.verify` / `timingSafeEqual`; lo que queda con `===` son datos públicos.

## Hito 4 — Paridad de plataforma y alcance 🟡

- [x] **iOS**: publicado en App Store desde 1.0.x (release 1.0.6 live, iOS build 33); el pinning TLS
      cubre ambas plataformas (`mobile/app.json` + `app.plugin.js`).
- [x] **Desktop media wiring** ✅ (2026-09-25): el desktop solo reconocía la URI `blob:` v1 (4 partes)
      y la imagen sin pie, así que los adjuntos de los clientes actuales (v2/v3) salían rotos o como
      texto, y guardaba una URL temporal que moría al reiniciar. Ahora lee todos los formatos del
      móvil (imagen con pie, vídeo, audio, archivo, álbum `[multi:N]`), guarda la referencia cifrada
      y descifra al pintar (`utils/incomingMedia.ts`, `hooks/useMediaUrl.ts`,
      `components/MediaBubbles.tsx`); los archivos se guardan con un clic y los caducados avisan.
      Al enviar, el desktop metía todo lo elegido (PDF, ZIP…) en `[image:…]`; ahora manda vídeo y
      archivo con su formato (`utils/outgoingMedia.ts`), y las imágenes del botón directo del chat
      salen sin metadatos EXIF/GPS (`utils/stripImageMetadata.ts`, fail-closed; antes solo las
      limpiaba la hoja de adjuntos). Tests `incomingMedia.test.ts`, `outgoingMedia.test.ts`,
      `useMediaUrl.test.ts`. Pendiente: copia local cifrada (como mobile) para que los adjuntos
      sobrevivan al TTL de 24 h del relay.
- [ ] **Paridad mobile↔desktop** continua: mantener los parity-tests de los dos `socket/client.ts` como
      lever (no refactor cosmético — decisión M4).
- [ ] **F-2 — UnifiedPush**: transporte wake-up sin Google/Apple (ntfy/Gotify), FCM/APNs como fallback.
      Parcial: el build Android `foss` ya no lleva FCM (`plugins/withFossPush.js`, `config.ts`
      `REMOTE_PUSH_ENABLED`) y despierta por ntfy sobre Tor + servicio en primer plano. Falta el
      conector UnifiedPush (distribuidor externo) y en iOS no hay alternativa a APNs.
- [x] **Badge del icono = no leídos reales** — 1.0.7: el contador del icono se recalcula en cada
      cambio de contadores (`notifications/push.ts` `syncAppBadge`: al leer un chat, al recibir, al
      cargar, al volver a primer plano, al cambiar el ajuste); antes solo se incrementaba al llegar
      una notificación y nunca bajaba. Test `appBadge.test.ts`.
- [x] **Sincronizar a mano ("tirar para refrescar")** — 1.0.7: en la lista de chats, chat 1:1, grupo
      y feed de canal, tirar hacia abajo dispara lo mismo que volver del segundo plano (vaciar el
      buzón por Tor, empujar el outbox, reconectar; el feed además se vuelve a pedir). Es la
      mitigación visible a "Tor tarda en arrancar". `socket/client.ts` `syncNow`,
      `hooks/useSyncRefresh.ts` (+ tests). No registra nada: un sync manual es indistinguible de
      una vuelta a primer plano.

## Hito 5 — Vigilancia de deuda (continua) 🔵

- [ ] **M5 — `any`** (~40 restantes, triados): reducir al tocar cada archivo; contrato IPC desktop es el cluster grande.
- [ ] **God-files**: política vigente = NO retro-acortar los 4 aceptados; escribir archivos nuevos <800 desde el inicio.
- [x] **Guard `no-console`** en `desktop/src/renderer/**` ✅ (2026-09-25): el desktop no usa ESLint, así
      que es un test que escanea el código (como `crypto-imports.test.ts`) y falla ante cualquier
      `console.*` fuera de `utils/logger.ts` (`utils/__tests__/noConsole.test.ts`). Los dos avisos de
      `socket/calls.ts` pasan por el logger.
- [x] **SESSION_HANDOFF.md** (fechado 2026-06-05, obsoleto): **archivado** con cabecera
      que enumera qué es falso (relay AWS muerto, §5 ya mergeado) y redirige a
      [`AUDIT-2026-08-FUNCTIONAL.md`](./AUDIT-2026-08-FUNCTIONAL.md). Nota: el archivo
      es local, está gitignored (`.gitignore:50`) — el drift nunca llegó al repo.
      Auditoría 2026-08, DOC-1.

## Hito 6 — Federación de relays: "elige tu servidor" 🟡 (decidido 2026-09-16)

Hoy el relay es autoalojable pero los clientes de tienda van fijados al oficial y **no hay
federación** (todos los contactos deben estar en el mismo relay). Decisión del dueño: modelo
**SimpleX** — cada usuario elige el relay de su buzón (solo `.onion`), la dirección de contacto
lleva el relay, el cliente habla con varios relays, sin relay-a-relay. Pantalla en
`Privacy → Red → Mi relay`. Diseño, slices F0–F7 y su **estado canónico** en
[`FEDERATION-DESIGN.md`](./FEDERATION-DESIGN.md) (aquí no se duplica).

Estado 2026-09-19: **F0–F7 en `main`** (#483, #485, #486, #487, #488, #489, #490, #491, #492 y
la PR de F7). `FEDERATION` va **ON por defecto** en ambos clientes desde **1.0.7**; la pantalla
"Mi relay" es visible. Lo que queda es operativo, no de código: publicar 1.0.7 y entonces
`APP_MIN_VERSION=1.0.7` en el relay (clientes viejos ante un enlace v2 → "Actualiza"); la prueba
real 2 dispositivos × 2 relays y sus resultados viven en `AUDIT-2026-09-19-FEDERATION-F7.md`.

---

## Trade-offs aceptados (no son deuda abierta)
- **M4 god-files** (2× `socket/client.ts`, `Chat.tsx`, `GroupChat.tsx`): won't-do consciente.
- **A-1 rate-limit Redis**: diferido hasta escalar horizontalmente (relay mono-instancia).
- **`did:ethr` on-chain**: opt-in futuro; rompería "anónimo por defecto sin wallet". `did:key` off-chain ya está.
