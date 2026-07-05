# AegisLink — Roadmap (producto normal)

> **Creado:** 2026-07-05 · **Alcance:** **AegisLink normal** únicamente.
> Fuente de verdad forward-looking. Complementa (no reemplaza) el histórico ya cerrado
> en `SECURITY-ROADMAP-2026-06.md` (12 olas) y `AUDIT-2026-06-30-FULL.md`. El backlog
> `backlog_fases3_4.md` queda como registro de Fase 3/4; su estado de features sigue vigente.

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

## Hito 0 — Desbloquear y sanear el árbol (INMEDIATO) 🔴

CI de los dos PRs abiertos está en rojo. Reglas de oro de ramas/estructura rotas. Cerrar antes de nada.

- [ ] **Verde PR #240**: commitear el fix `async` de `server/src/relay/handler.ts:185`
      (arregla `error TS1308` → Server TS + Server tests + Build smoke) y resincronizar
      `mobile/package-lock.json` (`npm install`, falta `typescript@5.9.3`) → arregla todos los jobs mobile.
- [ ] **Verde PR #239** (`feat/multi-device-spk`): misma familia (lock + `await`); evaluar
      solapamiento con #240 (device-linking) y consolidar para no fragmentar (regla ramas #5).
- [ ] **Basura trackeada fuera de git** (regla estructura): `alerts.json`, `all_alerts.json`,
      `pr_236..240_comments.txt`, `mobile/crash2.txt`, `server/.expo/devices.json` →
      `git rm --cached` + `.gitignore`.
- [ ] **Stash huérfano**: aplicar o descartar `stash@{0}: WIP on fix/decoy-pin-length` (regla ramas #2).
- [ ] **Ramas zombi**: borrar `fix/dependabot-alerts` y `fix/technical-debt-audit` (idénticas a `main`);
      `fix/panic-lock-gestures` está contenida en `fix/decoy-pin-length`.
- [ ] **Todo a `main`**: mergear lo verde; no acumular ramas que no llegan a `main` (regla ramas #4).

## Hito 1 — Extraer Work + pagos de este repo 🟠

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

**Plan:**
- [ ] **Preservar antes de borrar**: el código Work debe poder migrar a su repo futuro. Opción
      recomendada = mantenerlo en historia git (basta `git rm`; se recupera por SHA / `git filter-repo`
      al crear el repo Work). Alternativa = branch de archivo `archive/work-snapshot`.
- [ ] **Borrar ya (cero acoplamiento)**: los prototipos de pagos en `_unused/` — código muerto, no cableado.
- [ ] **Extraer server**: quitar router `/work` + prune de `index.ts`, quitar `repos/work` y su
      re-export, quitar `channels.ts` (handler de org) y su `attach`, limpiar schemas Work.
- [ ] **Schema DB**: retirar `CREATE TABLE work_*`/`workspaces*` de `pg.ts` y `sqlite.ts` (migración
      de retirada documentada; datos Work en prod, si los hay, se exportan antes).
- [ ] **Verificar fail-closed**: tras la poda, `npm run build` + tests server verdes; confirmar que
      canales públicos sellados (normal) siguen intactos (no comparten `workRepo`).
- [ ] **Doc↔código**: actualizar `backlog_fases3_4.md` (P1/G2 → "movidos a repo Work") y este roadmap.

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

## Hito 3 — Terminar el endurecimiento cripto 🟠

- [ ] **H3 — unificar `@noble/hashes`** mobile v1 ↔ desktop v2 (hoy mitigado por KAT cross-platform;
      falta unificar mayor + verificación Metro on-device).
- [ ] **F-1 — núcleo cripto nativo**: portar hot-path (X25519, XSalsa20-Poly1305, Ed25519, HKDF/HMAC)
      a binding libsodium, conservando la capa TS. Cierra el gap constant-time a través del JIT.
- [ ] Cerrar los "partial coverage" de la auditoría: zeroización en intermedios X3DH/PQXDH,
      `assertNonZero` ML-KEM, barrido constant-time de comparaciones restantes.

## Hito 4 — Paridad de plataforma y alcance 🟡

- [ ] **iOS**: no hay target iOS todavía; el pinning M-1 solo cubre Android. Definir si entra o no.
- [ ] **Desktop media wiring**: cerrar `[[bug_desktop_media_not_wired]]` (UI de adjuntos desktop).
- [ ] **Paridad mobile↔desktop** continua: mantener los parity-tests de los dos `socket/client.ts` como
      lever (no refactor cosmético — decisión M4).
- [ ] **F-2 — UnifiedPush**: transporte wake-up sin Google/Apple (ntfy/Gotify), FCM/APNs como fallback.

## Hito 5 — Vigilancia de deuda (continua) 🔵

- [ ] **M5 — `any`** (~40 restantes, triados): reducir al tocar cada archivo; contrato IPC desktop es el cluster grande.
- [ ] **God-files**: política vigente = NO retro-acortar los 4 aceptados; escribir archivos nuevos <800 desde el inicio.
- [ ] **Lint `no-console`** en `desktop/src/renderer/**` para prevenir regresión del logger.
- [ ] **SESSION_HANDOFF.md** (fechado 2026-06-05, obsoleto): archivar o reescribir — hoy contradice el código (regla doc↔código).

---

## Trade-offs aceptados (no son deuda abierta)
- **M4 god-files** (2× `socket/client.ts`, `Chat.tsx`, `GroupChat.tsx`): won't-do consciente.
- **A-1 rate-limit Redis**: diferido hasta escalar horizontalmente (relay mono-instancia).
- **`did:ethr` on-chain**: opt-in futuro; rompería "anónimo por defecto sin wallet". `did:key` off-chain ya está.
