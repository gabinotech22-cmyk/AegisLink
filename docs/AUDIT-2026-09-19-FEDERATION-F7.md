# Federación F7 — activación, relay de prueba real y protocolo de prueba en dispositivo

> **Fecha:** 2026-09-19 · **Rama:** `feat/federation-enable` · **Épica:** `FEDERATION-DESIGN.md`
> (F0–F6 en `main` en #483…#492). Este doc es el informe de F7: qué se activó, qué se
> probó **en real** (relay propio levantado con el paquete F6 en una VM), qué hallazgo salió
> de esa prueba, y el **protocolo de prueba en dispositivo** con su resultado. Método: código y
> tests como única fuente (regla de oro doc #6); cada afirmación lleva su archivo o comando.

## 1. Qué cambia en F7

| Cambio | Dónde | Prueba |
|---|---|---|
| `FEDERATION` **ON por defecto** en mobile y desktop (`…_FEDERATION=off` = freno de emergencia) | `mobile/src/config.ts`, `desktop/src/renderer/config.ts` | `tsc` ambos; suites de pantallas (`Privacy`, `ScanQR`, `qr.links` — 32 tests) y suite completa desktop (275) verdes con el nuevo default; las suites de federación ya fijaban el flag explícitamente |
| Versión mobile **1.0.7** (`versionCode` 10007; EAS `appVersionSource=remote` asigna el real) | `mobile/app.json` | — |
| Relay propio con **ubicación oculta** (hallazgo §3): `torrc.selfhost` sin single-onion, elegido por `ONION_TORRC` | `infra/tor/torrc.selfhost`, `infra/tor/Dockerfile` (`ARG TORRC`), `infra/selfhost/docker-compose.yml`, `.env.example` | CI `selfhost-compose`: exige `TORRC: torrc.selfhost`, rechaza `SingleHopMode 1` en ese torrc, construye la imagen y `tor --verify-config` |
| Docs: flag/estado en README, ROADMAP, DEVELOPMENT, PROTOCOL, SELF-HOSTING, FEDERATION-DESIGN; **cabecera de vigencia** en todos los históricos (`FASE4-*.md`, `RELAY-ONION-SERVICE.md`, `AUDIT-*.md`, `SECURITY-ROADMAP-2026-06.md`, `SEALED-SENDER-ARCHITECTURE.md` §5) | `docs/` | regla de oro doc #8 |

**`minVersion`** es configuración del relay (`APP_MIN_VERSION`, `server/src/relay/appVersion.ts`),
no código: se sube a `1.0.7` en el relay oficial **cuando 1.0.7 esté en las tiendas**, no antes
(subirlo antes bloquearía a todos los usuarios con la 1.0.6 sin alternativa). Hasta entonces un
cliente 1.0.6 que reciba un enlace v2 hacia otro relay lo rechaza con "Actualiza AegisLink"
(`AddContact.tsx`, `FEDERATION-DESIGN.md` D6) — no se pierde nada, solo no lo puede usar.

## 2. Relay de prueba real (paquete F6 en una VM)

Levantado el 2026-09-19 en la VM de coturn (Hetzner, 2 vCPU / 4 GB) con el paquete tal cual
está en `main` — sin tocar nada del host más allá de clonar el repo en
`/opt/aegislink-testrelay` y ejecutar `infra/selfhost/up.sh`:

| Paso | Resultado |
|---|---|
| `./up.sh` (primer arranque, `.env` generado, build del relay, tor, ntfy) | ✅ relay `healthy`, tor `healthy`, ntfy up; onion impreso a la primera |
| `GET /relay/info` (desde dentro) | ✅ `{"name":"AegisLink test relay (F7)","protocol":1,"features":["mailbox","prekeys","blob","calls","ntfy","identity-lookup"],"maxBlobBytes":52428800}` |
| Alcance **desde la red Tor** con un cliente Tor independiente (contenedor Alpine desechable, `curl --socks5-hostname`) | ✅ `/health` → `{"ok":true}`; `/relay/info` con `features ⊇ {mailbox, prekeys}` (exactamente lo que comprueba `verifyRelay`, `net/relayMigration.ts`); ntfy por el onion `:8090/v1/health` → 200 |
| Tras el fix de §3: `docker volume rm selfhost_tor_keys && ./up.sh` | ✅ onion nuevo, `Bootstrapped 100%`, **sin** el aviso `HiddenServiceNonAnonymousMode` en los logs de tor |

El onion del relay de prueba no se publica en este doc (es un relay de pruebas, se apagará al
terminar F7; el dueño lo tiene en la salida de `print-onion.sh`).

## 3. Hallazgo: el relay propio heredaba el modo single-onion del oficial (arreglado)

**Qué.** `infra/selfhost/docker-compose.yml` construía el sidecar Tor con el mismo `torrc`
que el relay oficial, que lleva `HiddenServiceSingleHopMode 1` + `HiddenServiceNonAnonymousMode 1`.
Tor lo anuncia en el arranque: *"Every hidden service on this tor instance is NON-ANONYMOUS"*.

**Por qué importa.** Para el relay oficial es una decisión correcta y documentada
(`RELAY-ONION-SERVICE.md`: su ubicación ya es pública por el dominio clearnet; single-onion
recorta ~la mitad de la latencia y el anonimato del **cliente** no cambia). Para un relay
**propio** no: `SELF-HOSTING.md` promete "nadie necesita saber dónde está", y con single-onion
la red Tor (guardas/rendezvous) aprende la IP de la máquina del operador. Es una fuga de
metadatos del operador, no de los usuarios — pero contradice la promesa del doc y la razón de
ser del `.onion`-only (D1).

**Fix.** `infra/tor/torrc.selfhost` (servicio con ubicación oculta, 3 saltos del lado servidor)
es el default del paquete; `ONION_TORRC=torrc` en `.env` recupera el single-onion para quien
tenga una máquina cuya ubicación ya sea pública y prefiera latencia. Tor se niega a reutilizar
el directorio de claves entre modos, así que cambiar implica onion nuevo (documentado en
`SELF-HOSTING.md` §Opciones y §Solución de problemas). CI lo bloquea para siempre
(`selfhost-compose`).

Sin la prueba real no habría salido: el `docker compose config` del CI no arranca Tor.

## 3b. Hallazgos de la prueba en emulador (2 × Android, APK `1de1424`) — arreglados en la misma rama

Los tres salieron en los primeros 20 minutos con la app real; ningún test los cubría porque
ninguna suite combinaba *home propio* + *contacto en otro relay* + *pantallas*.

| # | Síntoma en el dispositivo | Causa | Fix | Test |
|---|---|---|---|---|
| H1 | B (en relay propio) → A: **"Errore di invio: `foreign_contact_needs_sealed_v2`"** en cada mensaje | `relayFor(contact)` devuelve `null` para "relay oficial"; desde un home propio ese contacto es *foreign* y `deliverToForeignRelay` tomaba `null` como "sin relay" → **ningún usuario en relay propio podía escribir a nadie del oficial** (la precondición de F7, rota). Mismo `null` en la descarga de prekeys (`GET /prekeys/bundle` iba al home equivocado). | `net/homeRelay.ts` **`resolveRelay(contact)`** = relay concreto incluido el oficial (`OFFICIAL_RELAY`); `deliverToForeignRelay` y la descarga de prekeys lo usan; error propio `foreign_relay_unknown` si no hay onion oficial configurado. Mobile + desktop. | `client.firstContact` (+1: home propio → contacto oficial: bundle y sobre por el pool al **onion oficial**, nada por el socket home, `fc.relay` = nuestro onion); `net/homeRelay` (+2 aserciones, ambas plataformas) |
| H2 | Contacto añadido **por ID** desde un home propio queda como "oficial" (`relayOnion: null`) aunque se resolvió en **nuestro** relay → tratado como foreign del oficial (dispara H1) | `addByAegisId` sin relay explícito guardaba `null` | Sin relay explícito → `relayOnion = canonicalRelay(getHomeRelay())` (un ID resuelto en nuestro home vive en nuestro home). Mobile + desktop. | cubierto por H1 + `contacts.*` verdes |
| H3 | El **enlace/QR propio** de B tras migrar seguía siendo **v1** (`…/a#v1/ID/clave`): sin relay ni root, nadie fuera del oficial puede alcanzarle | Los codificadores v2 existían desde F1 pero `AddContact`/`Profile`/`Verify` nunca pasaban relay+root; y pegar un enlace v2 en "Por ID" reducía a la ID pelada (perdía el root) | `net/ownAddress.ts` (byte-idéntico mobile↔desktop): `useOwnAddressParts()` → relay + root propios; todas las pantallas lo usan (v2 solo cuando está listo, nunca un v1 inalcanzable); "Por ID" con un enlace v2 pegado pasa por `addFromQR` (relay + root). | `qr.links` verdes; pantallas `tsc`; verificación en dispositivo (fila 3 del cuadro) |

Además, en el emulador A quedó una DB SQLCipher con clave perdida (restos de otra sesión) y la
app se quedó en "Initializing secure storage…" reintentando en bucle en vez de fallar claro —
**decisión de producto pendiente** (§5).

## 4. Protocolo de prueba en dispositivo (2 dispositivos × 2 relays)

> **Lección de la pasada 2026-09-20:** reinstalar sobre identidades que ya habían migrado de relay
> varias veces (`adb install -r` sobre restos de sesiones anteriores) dejó a los dos emuladores con
> mensajes en "enviando" para siempre y pareció una regresión. Con **instalación limpia**
> (desinstalar → instalar) todo pasó a la primera. Las filas de este cuadro se validan siempre desde
> identidades limpias; un `-r` solo vale para comprobar un fix concreto sobre un estado conocido.


Build: APK de prueba del workflow `test-apk.yml` sobre esta rama
(`gh workflow run test-apk.yml --ref feat/federation-enable`; artifact
`aegislink-test-apk-release`; instalar con `adb install -r` para conservar la identidad). Es
el **primer build nativo con el bridge F2/F5a** (`httpRequest` cualquier verbo, `httpDownload`,
`httpUpload`, socket de identidad sobre `TorSioSocket`) — hasta aquí solo estaba probado en
Jest con el módulo nativo simulado.

Dispositivo **A** = relay oficial (sin tocar nada). Dispositivo **B** = migra al relay de prueba.

| # | Paso | Qué demuestra | Resultado |
|---|---|---|---|
| 1 | B: Privacidad → Red → **Mi relay** → pegar onion → **Verificar** | `verifyRelay` por Tor nativo (`httpRequest` GET) | ✅ emulador B (~15 s, "Relay verificato · mailbox · prekeys") y A |
| 2 | B: **Cambiar** → confirmación (PIN/biometría si hay bloqueo) → estado "relay propio desde hoy, gracia 7 d" | `migrateHomeRelay`: registro + prekeys en el destino por Tor (POST), anuncio `profile_update.mailboxRelay`, `setHomeRelay`, reconexión del socket de identidad por `TorSioSocket` | ✅ A y B: en el relay de prueba 2 identidades, 2 prekeys firmadas, 199 one-time, 2 delivery tokens; B sin ninguna conexión clearnet (solo guardas Tor) |
| 3 | B: compartir enlace/QR → A lo añade | enlace **v2** `aegislink://v2/<id>/<pk>/<onion>/<root>` aceptado con `FEDERATION` ON | ✅ APK `faca282` (2026-09-19, identidades nuevas): B en el relay propio, A en el oficial; A añade a B por enlace y viceversa (H2/H3 verificados) |
| 4 | A → B primer mensaje; B responde | **primer contacto** sellado con bootstrap X3DH (`fc`) hacia un relay ajeno por el pool; respuesta por el relay oficial | ✅ APK `faca282`: mensaje en ambos sentidos, doble check; en el relay de prueba 1 one-time prekey consumida (199→198) y 1 mensaje en buzón a la hora del envío (H1 verificado) |
| 5 | A ↔ B: entregado / leído / "escribiendo…" | receipts y typing sellados cross-relay | 🟡 APK final `main@3e31ffc` (2026-09-20, instalación limpia): **entregado** ✅ (doble check en ambos sentidos con B en el relay propio); leído y "escribiendo…" sin comprobar explícitamente |
| 6 | A → B foto; B → A foto | blob **v3** con host `.onion`: subida por `httpUpload` nativo y descarga por `httpDownload` | ✅ APK final `main@3e31ffc`: foto en ambos sentidos con B en el relay propio, tras #495 (burbuja = wire id) y #496 (volumen de uploads del relay propio era de root → 500). No hay envío de documentos en el chat 1:1 (solo imagen/vídeo/audio/GIF), la fila se ajusta |
| 7 | Grupo de 3: A, B y C (C en el oficial) — mensajes en ambos sentidos | fan-out con miembros en 2 relays | ⬜ |
| 8 | A llama a B (audio) y B a A; colgar; con B en segundo plano/app cerrada | señalización `call_signal` sellada por el relay de B con `wakeHint: 'call'`; wake urgente por ntfy del relay propio | ⬜ |
| 9 | B: **Volver al relay oficial** → A sigue escribiendo a B sin tocar nada | migración de vuelta; A recibe el `mailboxRelay=null` y re-enruta; drenaje del buzón viejo (`fetchMailboxOverTor` stateless) | ⬜ |
| 10 | B: cerrar la app 10 min con A escribiendo | housekeeping de la ventana de gracia; nada perdido | ⬜ |
| 11 | Repetir 1–2 desde el **desktop** (VITE) | paridad desktop (base URL + Tor de sesión) | ⬜ |

Criterio de salida: 1–10 en verde en Android (iOS: lo que el bridge Tor iOS ya cubre en 1.0.x;
push/CallKit del espejo EAS sin APNs, hueco conocido). Un fallo en cualquier fila se anota
aquí con el log y se arregla en la misma rama antes de mergear F7; **el flag no se enciende en
una release sin este cuadro completo**.

## 5. Después de F7 (operativo, no código)

1. Publicar **1.0.7** (Android + iOS) con el flag ON. Desktop: siguiente beta con `VITE_FEDERATION` ON.
2. En el relay oficial (`/opt/aegislink/.env`, ambos `.env` — ver deriva conocida): `APP_LATEST_VERSION=1.0.7` al publicar; `APP_MIN_VERSION=1.0.7` **cuando la 1.0.7 lleve unos días en tiendas** (el bloqueo es inmediato para quien no actualice).
3. Relay de prueba: `docker compose down -v` en `/opt/aegislink-testrelay/infra/selfhost` al cerrar F7 (o conservarlo como relay de demo: entonces `./backup-onion-key.sh`).
4. Pendiente de decisión de producto (ya en `FEDERATION-DESIGN.md` §2): sealed-to también para llamadas (D6), retirar v1 del transporte (Fase 6 de `SEALED-SENDER-ARCHITECTURE.md`).
5. ✅ **Resuelto (2026-09-20, `fix/db-key-mismatch-recovery`; `docs/PROTOCOL.md` §7.4b):** `DbKeyMismatchError` + pantalla `StorageLocked` con restaurar backup / empezar de cero, confirmados. Texto original: una DB SQLCipher cuya clave ya no está en SecureStore deja la app en "Initializing secure storage…" para siempre. Recomendación: tras N fallos de descifrado de `page 1`, pantalla clara "Los datos locales no se pueden abrir" con **Restaurar backup** / **Empezar de cero** (borra la DB; la identidad sin backup se pierde y se dice). Sin esto, un usuario real lo vive como "la app no abre".
