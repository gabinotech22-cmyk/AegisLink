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

**Hecho (PR `chore/extract-work`):**
- [x] **Preservado en historia git** (`976c09f`); sin branch de archivo.
- [x] **Prototipos de pagos** `mobile/src/_unused/**` borrados; `tsconfig` ya no los excluye.
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

## Hito 2 — Privacidad por defecto: sealed-sender activo 🔴 (diferenciador de mercado)

Hallazgo de la revisión 2026-07-05: **sealed-sender está implementado y testeado pero `MAILBOX_MODE`
está OFF por defecto** (`mobile/src/config.ts:97`, opt-in). Los builds enviados usan el `envelope`
legacy autenticado que estampa `from: me` y ve `to` (`handler.ts:532`) → el relay aprende el par
emisor↔receptor. Es la promesa estrella (regla seguridad #4, "sealed-sender en TODO") **no activa**.

- [ ] Verificar en 2 dispositivos reales el transporte mailbox (latencia, drenaje multi-epoch, onion).
- [ ] Plan de cutover a **mailbox por defecto** (o etiquetar explícitamente el modo actual como
      experimental en README y no venderlo como cero-metadatos hasta el cutover).
- [ ] Sellar o documentar como limitación los indicadores en tiempo real que hoy exponen el par al
      relay: `typing` (`messaging.ts:28`) y read-receipts `msg:read` (`messaging.ts:52`).
- [x] **v1 solo como último recurso + llamadas selladas en el oficial (2026-09-20):** con raíz de
      buzón conocida el cliente emite siempre v2 (primer contacto incluido); llamadas a contactos
      que anuncian `sealed-calls` por buzón. Gateado por `caps` en el perfil para convivir con
      1.0.6. `docs/PROTOCOL.md` §7.3. Pendiente: retirar v1 en el relay tras `APP_MIN_VERSION`.

## Hito 3 — Terminar el endurecimiento cripto 🟠

- [ ] **H3 — unificar `@noble/hashes`** mobile v1 ↔ desktop v2 (hoy mitigado por KAT cross-platform;
      falta unificar mayor + verificación Metro on-device).
- [ ] **F-1 — núcleo cripto nativo**: portar hot-path (X25519, XSalsa20-Poly1305, Ed25519, HKDF/HMAC)
      a binding libsodium, conservando la capa TS. Cierra el gap constant-time a través del JIT.
- [ ] Cerrar los "partial coverage" de la auditoría: zeroización en intermedios X3DH/PQXDH,
      `assertNonZero` ML-KEM, barrido constant-time de comparaciones restantes.

## Hito 4 — Paridad de plataforma y alcance 🟡

- [x] **iOS**: publicado en App Store desde 1.0.x (release 1.0.6 live, iOS build 33); el pinning TLS
      cubre ambas plataformas (`mobile/app.json` + `app.plugin.js`).
- [ ] **Desktop media wiring**: cerrar `[[bug_desktop_media_not_wired]]` (UI de adjuntos desktop).
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
- [ ] **Lint `no-console`** en `desktop/src/renderer/**` para prevenir regresión del logger.
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
