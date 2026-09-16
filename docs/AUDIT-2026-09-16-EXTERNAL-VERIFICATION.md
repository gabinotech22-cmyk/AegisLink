# Verificación de la auditoría externa 2026-09-16

> **Método:** cada hallazgo del informe externo se contrastó contra el código y
> los tests de `main @ 07076c1` (regla de oro doc↔código #6: `grep` y tests, no
> memoria ni `.md` viejo). Cada veredicto lleva su `archivo:línea`.
>
> **Fecha:** 2026-09-16 · **Origen:** informe externo `AegisLink-security-audit-2026-09-16.md`
> (11 hallazgos AL-01…AL-11, en italiano, autor no vinculado al proyecto).

## 0. Resumen

**La auditoría es correcta en 10 de 11 hallazgos y no contiene falsos positivos.**
AL-07 acierta en lo esencial (la cronología Work no persiste el `nonce`) pero se
equivoca en un detalle (dice que el FTS indexa ciphertext; ya no — B-5). En AL-01
el auditor se quedó **corto**: además del mismatch de claves, el relay nunca
responde el `ack` que el móvil espera y `device:list` devuelve una forma que
ningún cliente entiende. La vinculación de desktop está rota de punta a punta.

Tres hallazgos (AL-02, AL-07, AL-09) viven en la superficie **Work** (orgs,
canales de org, `POST /work/org`), que **ningún cliente usa** — `emitChannelMsg`
(`mobile/src/socket/client.ts:1538`) no tiene callers y el desktop no tiene Work
— y que el `ROADMAP.md` Hito 1 marca para extraer del repo. Decisión: se cierran
ejecutando Hito 1 (borrar la superficie), no parcheando código muerto.

La auditoría también tropezó con **documentación desactualizada** (`DEVELOPMENT.md`
decía Node 22+, el server exige Node 24 → sus 55 suites fallaron con
`ENOENT sqlite`). La regla "La doc no miente" existía en `CLAUDE.md` pero sin
enforcement; esta tanda añade el gate `docs-sync` en CI y la plantilla de PR.

**Estado:** 11 abiertos → se cierran en tres PRs encadenadas (§4).

## 1. Superficie medida

- `server/src/relay/{handler.ts,schemas.ts,handlers/devices.ts,handlers/channels.ts}`
- `server/src/db/{client.ts,sqlite.ts,repos/work.ts}`
- `server/src/routes/{proxyLinkPreview.ts,blob.ts,backup.ts,work.ts}`, `server/src/index.ts`
- `mobile/src/screens/Devices.tsx`, `mobile/src/components/{LinkPreview,GifPicker}.tsx`
- `desktop/src/renderer/screens/{LinkDevice,Devices}.tsx`
- `.github/workflows/ci.yml`, lockfiles de `server/`, `mobile/`, `desktop/`

## 2. Hallazgos verificados

### AL-01 · Vinculación de desktop rota criptográficamente; revocación no aplicada — **alto**, **CONFIRMADO (y peor)**

Evidencia:
- `server/src/relay/schemas.ts:308-312` — `DeviceLinkApprove` no admite `mobilePubKey`; Zod lo descarta.
- `server/src/relay/handlers/devices.ts:42-47` — el relay reenvía la X25519 **permanente** de `identityRepo`.
- `mobile/src/screens/Devices.tsx:185-209` — el móvil cifra con un par **efímero** → `nacl.box.open` en
  `desktop/src/renderer/screens/LinkDevice.tsx:115-120` falla siempre.
- `server/src/db/client.ts:224-226` — comentario que admite que nada llama a `devicesRepo.upsert`.
- `devicesRepo.isRevoked` (`client.ts:777`) no tiene callers fuera de tests.

Lo que el auditor no vio:
- El móvil espera un ack (`Devices.tsx:221-225`); el handler no lo llama nunca → "Request timed out" a los 8 s.
- `device:list` devuelve `{count, platforms}` (`devices.ts:67-70`); mobile (`Devices.tsx:108`) y desktop
  (`Devices.tsx:51`) esperan `{ok, devices[]}` → la lista siempre está vacía.

Estado: **abierto → PR-B**. Limitación estructural que queda documentada (§3.1): el desktop recibe
las claves secretas de identidad, así que revocar en el relay no revoca de verdad.

### AL-02 · Borrado cross-org en canales Work — **alto**, **CONFIRMADO**

`server/src/relay/handlers/channels.ts:250-262` valida que el llamante es miembro de `orgId` y que
`message.channel_id === channelId`, pero nunca `channel.org_id === orgId`. Superficie sin clientes.
Estado: **abierto → PR-C** (extracción de Work).

### AL-03 · SSRF por DNS rebinding + lectura sin límite en link-preview — **alto**, **CONFIRMADO**

- `server/src/routes/proxyLinkPreview.ts:109-114` — el propio comentario reconoce la ventana TOCTOU.
- `:235` — `fetch(currentUrl)` vuelve a resolver DNS tras `assertPublicHost`.
- `:288` — `await upstream.arrayBuffer()` carga toda la respuesta antes de `slice(0, 8192)`.
- `proxyLinkPreview.ssrf.test.ts` cubre el caso textual y los redirects; no cubre rebinding ni el límite.

Estado: **abierto → PR-B**.

### AL-04 · Memoria antes del PoW en uploads + carrera en la quota — **alto**, **CONFIRMADO**

- `server/src/routes/blob.ts:123` — `express.raw({ limit: '50mb' })` corre **antes** de `verifyPoW` (`:136`).
- `:155` comprueba `currentTotalBytes + uploadLength`; `:168` incrementa en el callback de `writeFile` →
  varias peticiones pasan el check antes de que ninguna sume.

Estado: **abierto → PR-B**.

### AL-05 · Las previews remotas revelan IP y hora de lectura — **alto (privacidad)**, **CONFIRMADO**

- `mobile/src/components/LinkPreview.tsx:131` — `<Image source={{ uri: data.image }}>` carga `og:image`
  directamente del origen que eligió el emisor.
- `mobile/src/components/GifPicker.tsx:340` — las previews de GIF se cargan del proveedor.
- El relay solo proxya el HTML (`proxyLinkPreview.ts:292-294`), no los bytes de imagen.

Estado: **abierto → PR-B** (decisión de producto en §3.2).

### AL-06 · Los ACK no están atados a la cola autenticada — **medio**, **CONFIRMADO**

- `server/src/relay/handler.ts:509-514` (mailbox) y `:590-595` (aegisId) llaman a
  `messageRepo.delete(id[, deviceId])` sin comprobar `recipient`.
- `server/src/db/client.ts:331-348` — `DELETE FROM messages WHERE id = ?`.
- `channels.ts:464-473` — `group:rekey_drain_ack` → `senderKeyDistRepo.delete(distId, deviceId)`, mismo patrón.
- `handler.ts:171-174` — `deviceId` viene del handshake sin validar.

Estado: **abierto → PR-B**.

### AL-07 · La cronología Work E2EE pierde el `nonce` — **medio**, **PARCIALMENTE CORRECTO**

- Cierto: `server/src/db/sqlite.ts:311-324` — `work_messages` no tiene columna `nonce` ni `encrypted`;
  `channels.ts:170-179` no lo persiste → el historial es indescifrable tras reconectar.
- **Falso**: "el FTS indexa ciphertext". B-5 ya indexa body vacío: triggers `sqlite.ts:371-392` y
  migración `:492-519` (`delete-all` del índice).

Superficie sin clientes. Estado: **abierto → PR-C** (extracción de Work).

### AL-08 · Backups declarados de 5 MB pero bloqueados a 64 KB — **medio**, **CONFIRMADO**

`server/src/index.ts:131` — `express.json({ limit: '64kb' })` global; `routes/backup.ts` no monta parser
propio; `MAX_BACKUP_BYTES` (`:42`) es inalcanzable. Estado: **abierto → PR-B**.

### AL-09 · `POST /work/org` no puede producir una firma válida — **medio**, **CONFIRMADO**

`server/src/routes/work.ts:136-137` — `orgId = randomUUID()` y luego verifica la firma sobre ese `orgId`.
Ningún cliente llama al endpoint. Estado: **abierto → PR-C** (extracción de Work).

### AL-10 · Dependencias con advisories — **medio/alto**, **CONFIRMADO**

`server/package-lock.json`: `socket.io-parser 4.2.6` (l.5975), `qs 6.15.2` (l.5587),
`ip-address 10.2.0` (l.4001), `undici 7.28.0` (l.6608). Estado: **abierto → PR-B**.
Restricción: el lockfile de `mobile/` se regenera **siempre con npm@10** (npm 11 rompe el CI).

### AL-11 · El job `permissions-audit` siempre se salta — **bajo/proceso**, **CONFIRMADO**

`.github/workflows/ci.yml:449-462` comprueba `mobile/android/…/AndroidManifest.xml`; ese directorio no
está trackeado (`git ls-files mobile/android` vacío) → `has_android=false` → todo "skipped".
Estado: **abierto → PR-B**.

### DOC-1 · Drift de documentación que hizo tropezar al auditor — **bajo**, **cerrado en esta PR**

- `docs/DEVELOPMENT.md:4` decía "Node.js 22+"; `ci.yml:98,120` fija Node 24 para el server porque
  `node:sqlite` solo es estable ahí. Corregido.
- `docs/SECURITY-ROADMAP-2026-06.md:74` marcaba 🟡 el rate-limit de `device:link` que ya existe
  (`server/src/relay/rateLimits.ts:153`, `socketRateLimits.unit.test.ts:27`). Corregido.
- Enforcement: job `docs-sync` en CI + `.github/PULL_REQUEST_TEMPLATE.md` + mapa código→doc en `CLAUDE.md`.

## 3. Decisiones de producto propuestas

1. **Revocación real de desktop.** El desktop recibe las claves secretas de identidad (por diseño del
   link actual), así que revocar en el relay solo bloquea un `deviceId`. Revocación real = rotar
   identidad (nuevo par + re-X3DH con contactos). Recomendación: documentarlo en `PROTOCOL.md` y en la
   UI de revocar; identidad-por-dispositivo (modelo Signal/SimpleX) como hito propio post-launch.
2. **GIFs.** Proxyar los bytes por el relay cuesta ancho de banda, caché y otra superficie SSRF.
   Recomendación: aviso en el picker ahora; `og:image` pasa a carga bajo gesto explícito; proxy de bytes
   solo si el uso lo justifica.
3. **Desktops ya vinculados.** El fail-closed de AL-01 expulsa cualquier desktop sin fila en
   `linked_devices`. No hay beta pública firmada → cero afectados conocidos; testers re-vinculan.
4. **Streaming de uploads.** Con el PoW delante del parser, el body en memoria queda acotado por el coste
   del PoW. Streaming a fichero temporal se deja como backlog.

## 4. Orden de cierre

| PR | Rama | Cierra |
|---|---|---|
| A | `docs/audit-2026-09-16-verification-and-doc-sync-rule` | DOC-1, regla + gate `docs-sync`, este informe |
| B | `fix/security-audit-2026-09-16-server` | AL-01, AL-03, AL-04, AL-05, AL-06, AL-08, AL-10, AL-11 |
| C | `chore/extract-work` (Hito 1 del ROADMAP) | AL-02, AL-07, AL-09 |

Cada PR se mergea antes de abrir la siguiente (regla de oro de ramas). Este documento es la fuente
canónica del estado de estos hallazgos; `ROADMAP.md` enlaza aquí.
