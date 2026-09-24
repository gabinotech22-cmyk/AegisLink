# Auditoría 2026-09-24 — pasada adversarial: relay + módulo web3/DID

> **Método:** revisión con mentalidad de atacante del plano servidor (auth, mailbox, prekeys,
> proxies SSRF, CORS, señalización) y, al tirar del hilo, del módulo web3/DID completo en
> mobile, desktop y relay. Código y tests como única fuente de verdad (regla de oro doc #6).
>
> **Ramas:** `fix/web3-did-binding`, PR #525 (W-1 … W-8, P-1); `fix/deps-postcss-advisory`, PR #526
> (D-1). R-1 va en su propia rama. Estado vivo en las tablas.
>
> **Corrección de alcance:** todo `/web3` estaba **apagado en producción** (`WEB3_ENDPOINTS=off`,
> puesto en la auditoría 2026-07 H3 precisamente por la revocación sin binding). W-1 y P-1 eran
> fallos reales en el código, pero su explotación en producción era nula mientras el interruptor
> siguiera apagado. La primera versión de este informe no lo mencionaba y sobreestimaba el impacto.

## 0. Superficie revisada sin hallazgos

Challenge-response del socket (constant-time, TTL), `POST /mailbox/*` (binding
`mailboxId = SHA256(signPub)[0:16]`, nonce de un solo uso), `POST /prekeys` (firma contra la
clave **almacenada**), `DELETE /identity/:id`, `GET /proxy/linkpreview` (DNS pinning
anti-rebinding, IPv6 hex-mapped, re-validación por cada redirect), CORS (en producción solo el
dominio propio), fail-closed de `plain:` en desktop empaquetado, `me` del socket derivado del
handshake (no suplantable).

## 1. Hallazgos — módulo web3/DID (corregidos)

| # | Sev. | Estado | Hallazgo | Arreglo · evidencia |
|---|---|---|---|---|
| W-1 | ALTA (latente) | ✅ HECHO | `POST /web3/device/revoke` verificaba la firma contra una clave **que mandaba el cliente** y nunca la ligaba al DID: cualquiera podía desactivar para siempre cualquier DID con un par de claves desechable (reglas #3/#7). El único llamador enviaba un pseudo-DID inventado (`did:aegis:<deviceId>`), así que un binding "encima" habría sido teatro. | Endpoint (y su gemelo `GET /web3/device/revocation/:didHash`) **eliminados**. La desactivación la deriva el relay del borrado de cuenta firmado por el dueño contra la clave almacenada (`server/src/routes/identity.ts`). Tests: `identityDeleteRevokesDid.test.ts`, `web3Did.test.ts` (POST forjado → 404, nada revocado). |
| W-2 | MEDIA | ✅ HECHO | `GET /web3/did/resolve/:did` era un stub `501 not_implemented`. | Resolución W3C completa para `did:key`: 200 / 410 `deactivated` / 400 `invalidDid` / 501 `methodNotSupported` (`did:ethr` fuera por diseño, ROADMAP). Solo acepta `did:key` **canónico** (un alias no canónico se leería como activo). `server/src/crypto/didKey.ts`; tests `didKey.test.ts`, `web3Did.test.ts`. |
| W-3 | MEDIA | ✅ HECHO | `revoked_did_hashes` guardaba `signing_pub_key` — que **es** el DID en otra codificación — más firma y timestamp, contradiciendo "solo guardamos el hash" (regla #10). | Tabla solo `did_hash`; migración de una vez (SQLite `PRAGMA`, PG `information_schema`) que purga las filas heredadas (ninguna tenía binding) y reconstruye. Test de migración en `web3Did.test.ts`. |
| W-4 | MEDIA | ✅ HECHO | El wipe/pánico borraba la caché del DID con claves `aegis.did.v1.<id>::personal/work` que nada escribía; la real (`aegis.did.v1.<id>`) **sobrevivía a todo wipe**, y es la clave pública de firma → enlaza el dispositivo con la identidad borrada. | `purgeGlobalAppState` llama a `clearDID(aegisId)` (`mobile/src/db/core.ts`). Test en `db/__tests__/wipeDatabase.test.ts`. |
| W-5 | BAJA | ✅ HECHO | Código muerto con garantías falsas: `ProfileIsolation.ts` (`assertProfilesIsolated` exige DIDs distintos, pero misma clave ⇒ mismo DID), `RevokeDevice.ts`, comentarios de `DIDManager.ts` ("sin correlación DID↔aegisId"), documento DID con `keyAgreement` = clave Ed25519. | Módulos eliminados; resolver local en paridad exacta con el relay y sin `keyAgreement` (`resolveDID.test.ts`); comentarios corregidos; `Devices.tsx` ya no manda nada a web3 (`Devices.test.tsx`). |
| W-6 | BAJA | ✅ HECHO | El desktop prometía al borrar la cuenta "una señal de revocación a todos los relays" — no existía. | Ahora es cierto para el relay propio (W-1); texto ajustado en en/es/it. |
| W-8 | MEDIA | ✅ HECHO | Con `/web3` apagado, el resolver de W-2 no habría sido accesible y la desactivación de W-1 no se podría consultar: un arreglo a medias. | El interruptor se elimina (`server/src/index.ts`): `/web3` ya solo expone el resolver, de solo lectura y con rate-limit. Guarda en `web3Did.test.ts`. |

## 2. Decisiones de producto abiertas

| # | Sev. | Estado | Hueco | Recomendación |
|---|---|---|---|---|
| W-7 | INFO | 🟡 DOCUMENTADO | El DID es enlazable con el Aegis ID: codifica la misma clave de firma que el relay sirve en el bundle público de prekeys. No revela identidad real, pero no es un seudónimo independiente. | Si se quiere un DID no enlazable, derivarlo de una clave Ed25519 **aparte**; si no, dejar documentado (PROTOCOL §3.4) y no prometer más en la UI. |
| R-1 | MEDIA | 🔴 ABIERTO | `typing` y `msg:read` (`server/src/relay/handlers/messaging.ts`) reenvían `{from: me}` por el socket autenticado: el relay ve la arista emisor→receptor con timing, lo mismo que motivó retirar `msg:delete` en claro. | Mover los recibos de lectura dentro del ratchet (como `msg_delete`); decidir explícitamente typing (sellar o documentar que la presencia en vivo expone metadatos al relay). |
| P-1 | MEDIA | ✅ HECHO | `/web3/subscription/invoice` aceptaba escrituras sin autenticación, sin rate-limit y sin purga, y emitía facturas simuladas (`lnbc…mock_`) imposibles de pagar. Con `/web3` apagado en producción, el síntoma real era otro: el perfil del **desktop** mostraba "Suscripción anónima", que fallaba siempre. Los pagos habían salido del repo con Work (ROADMAP Hito 1), pero estos restos se escaparon. | Endpoints, repo, tipos y DDL retirados; pantalla, ruta, fila del Perfil y claves i18n del desktop retiradas (más dos claves muertas en mobile). Las tablas huérfanas no se borran desde código (operador-local, como las de Work). PR #525; guardas en `web3Did.test.ts`. |

## 3. Dependencias (alertas Dependabot abiertas el 2026-09-24)

| # | Sev. | Estado | Alerta | Resolución |
|---|---|---|---|---|
| D-1 | MEDIA | ✅ HECHO | #88 `postcss` ≤ 8.5.22 (GHSA-fxqj-rqcc-2cmp) en `mobile/package-lock.json`, vía `@expo/metro-config` (solo build). El suelo del `overrides` (`^8.5.10`) seguía admitiendo 8.5.20. | Suelo `^8.5.23`, lock a 8.5.28 regenerado con npm@10 (PR #526). La #419 de Dependabot (npm 11) rompía el lock y se cerró. |
| D-2 | ALTA ×2 | ✅ RIESGO ACEPTADO | #91/#92 `image-size` ≤ 2.0.2 (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq): bucle infinito con ICNS/JXL/HEIF. Solo lo usa Metro en build para medir los assets del propio repo; no entra en la app. | Sin 1.x parcheada, y la v2 no vale: `metro/src/Assets.js:171` le pasa rutas de archivo que la v2 rechaza, así que un `overrides` rompe el bundling. Alertas descartadas como `tolerable_risk` con ese motivo. **Revisar** cuando Expo pase a Metro con `image-size` v2. |
