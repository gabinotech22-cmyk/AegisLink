# AegisLink Desktop — Beta 1 (Windows)

Estado canónico del cliente desktop. Si este doc y el código discrepan, gana el
código (regla de oro doc↔código). Última verificación: 2026-09-15 (`main`, tras #474/#475/#477).

## Qué es

Cliente Electron 42 (`desktop/`) con **paridad criptográfica completa** con
mobile: X3DH/PQXDH (ML-KEM-768), Double Ratchet transaccional, sealed-sender v2,
mailbox mode (código presente, ver limitaciones), SQLCipher at-rest con clave en
`safeStorage` (DPAPI) y PIN como segundo factor opcional. Verificado en
`docs/AUDIT-2026-08-FUNCTIONAL.md` §PAR-1.

Hardening del proceso main (`desktop/src/main/index.ts`): `contextIsolation`,
`sandbox`, `nodeIntegration: false`, CSP estricta por cabecera, navegación
pineada al `index.html` empaquetado, `setWindowOpenHandler` solo http(s), IPC
con `assertTrustedSender` + allow-list de claves del keystore, fail-closed si
`safeStorage` no está disponible en build empaquetado.

## Estado de verificación (Beta 1)

| Comprobación | Resultado | Evidencia |
|---|---|---|
| `npm run typecheck` | ✅ limpio | main + web tsconfigs |
| `npm test` (vitest) | ✅ 26 ficheros / 199 tests | CI `desktop-test` en `.github/workflows/ci.yml` |
| `npm run build` | ✅ | `out/` |
| `npm run package` (NSIS + portable x64) | ✅ arranca, abre DB cifrada, sin errores en log | ver "Bug de empaquetado" abajo |
| Firma de código | ❌ **NotSigned** | SmartScreen avisará al instalar |

### Bug de empaquetado corregido en esta rama

`buildDependenciesFromSource: true` hacía que electron-builder empaquetara el
`better_sqlite3.node` compilado para el ABI de **Node** (147, Node 26) en vez del
de **Electron 42** (146). El `.exe` arrancaba pero el proceso main fallaba con
`NODE_MODULE_VERSION 147 … requires 146` al abrir la DB — sin DB, sin identidad.
Con `false`, `@electron/rebuild` descarga el prebuilt oficial
`electron-v146-win32-x64` y el paquete funciona.

Y el paso `@electron/rebuild` de electron-builder **tampoco es fiable** (reportó éxito
dejando el binario de Node): por eso `npm run package` fuerza el ABI explícitamente con
`scripts/native-abi.mjs` (prebuild-install oficial, sin compilador).

## Tor — siempre activo, sin toggle (✅ HECHO, rama `feat/desktop-tor`)

Paridad con el Tor embebido de mobile (`docs/FASE4-TOR-EMBEDDED-IMPL.md`), pero
más completo: en desktop **todo** el tráfico va por Tor, no solo el buzón.

| Pieza | Dónde | Qué hace |
|---|---|---|
| Binario | `scripts/fetch-tor.mjs` → `resources/tor/<os>-<arch>/tor.exe` (gitignored), `extraResources` en `package.json` | Descarga el Tor Expert Bundle con **sha256 pineado** (del `sha256sums-signed-build.txt` firmado por Tor Project); rechaza y no extrae si no coincide |
| Proceso | `src/main/tor/torProcess.ts` | Spawn con `--SocksPort` ×2, `--ClientOnly`, `--__OwningControllerProcess <pid>` (muere con la app); parsea `Bootstrapped N%`; **reinicio automático** con backoff si Tor cae |
| Proxy de sesión | `src/main/index.ts` | `session.setProxy('socks5://127.0.0.1:<control>')` **antes** de crear la ventana → fail-closed: sin Tor no hay red. Resolución DNS dentro de Tor (SOCKS5 remoto), `.onion` incluido |
| Buzón aislado | `src/main/tor/sioBridge.ts` + `src/renderer/net/tor.ts` (`TorSioSocket`) | El socket de mailbox vive en main sobre el **segundo** listener SOCKS (grupo de sesión distinto = circuitos distintos) para que el relay no pueda relacionar mailbox-id y aegisId por circuito. Tubo tonto: la firma de posesión y el sellado siguen en el renderer. Solo acepta destinos `.onion` |
| Destino | `src/renderer/config.ts` | `RELAY_URL = ONION_URL` cuando está configurado: control, HTTP (PoW, prekeys, TURN creds) y mailbox atacan el hidden service. Sin exit nodes, sin pin TLS que rotar |
| CSP | `electron.vite.config.ts` (`relay-csp`) + cabecera en main | `connect-src` solo relay clearnet + onion (http/ws), calculado del `.env` en build |
| Llamadas | `main/index.ts` (`disable_non_proxied_udp`) + `calls.ts` (`iceTransportPolicy: 'relay'`) | WebRTC no abre UDP fuera del proxy; solo TURN-TCP/TLS vía Tor y sin candidatos host/srflx en el SDP → ni el TURN ni el peer ven la IP real |
| UI | `components/TorBanner.tsx`, `screens/Splash.tsx` | Progreso de bootstrap y errores; desaparece al 100 % |
| Tests | `src/main/tor/__tests__/pure.test.ts`, `src/renderer/net/__tests__/torSioSocket.test.ts`, `calls.sealedSenderPolicy.test.ts` (relay-only), `secureStorage.test.ts` (claves v2/mailbox) | 15 + 1 + 1 nuevos |

**Verificado 2026-09-14** (`electron-vite preview` con `--enable-logging`): `tor.exe`
arranca, dos listeners, Electron establece conexiones **solo** a 127.0.0.1:<control> y
127.0.0.1:<mailbox> (cero conexiones a IPs externas desde Electron), identidad creada y
publicada contra el `.onion`, Tor muere al cerrar la app.

**Bug atrapado de paso (alto):** la allow-list del keystore (`main/ipc/secureStorage.ts`)
no incluía `aegis.deliveryToken.*` ni `aegis.mailboxRoot.*` → cada escritura lanzaba
`Access denied`, sealed-sender v2 degradaba a v1 por contacto y el buzón nunca podía
derivar raíz. Corregido + test de regresión. Tampoco estaban `pbh.*`, `spk.createdAt`,
`prekeysPublished.<slot>`, `scheduled.grouposts.v1`.

**Residuo honesto:** el relay ve "un circuito Tor conectó el mailbox X" y "alguien pidió
el bundle de Y por Tor" (mismo residuo que Session, `FASE4-CONTROL-PLANE-DESIGN.md` §5).
Bridges/pluggable transports (redes que bloquean Tor) no van en Beta 1.

## Cómo construir la beta

```bash
cd desktop
npm ci
npm run typecheck && npm test
npm run build
npm run package        # fetch-tor (sha256 pineado) → ABI Electron → electron-builder → ABI Node
                       # → dist/AegisLink Setup <ver>.exe (NSIS) + dist/AegisLink <ver>.exe (portable)
```

`npm run package` deja `node_modules` con el binario de **Node** al terminar
(`scripts/native-abi.mjs node`), así que `npm test` sigue funcionando. Para probar
la app sin empaquetar: `node scripts/native-abi.mjs electron && npx electron-vite preview`
(y `node scripts/native-abi.mjs node` al acabar).

`desktop/.env` (gitignored) debe apuntar al relay de producción:
`VITE_RELAY_URL=https://aegislink.duckdns.org`, `VITE_TURN_URL=turn:aegislink.duckdns.org:3478`,
`VITE_ONION_URL=http://<onion>.onion` (ver `.env.example`; el modo buzón va activo por defecto desde F5b, `VITE_MAILBOX_MODE=off` solo para depurar).
Sin `.env` el build apunta a `localhost:3001` (`desktop/src/renderer/config.ts`) —
que Chromium no pasa por el proxy (loopback), así que el relay local de dev funciona
con Tor arrancado.

## Limitaciones conocidas de Beta 1 (declaradas, no ocultas)

1. ~~Sin Tor~~ → ✅ resuelto (sección Tor). Queda: sin bridges/PT para redes que
   bloquean Tor; latencia de llamadas mayor (TURN-TCP por Tor).
2. ~~UI solo en inglés~~ → ✅ resuelto (rama `feat/desktop-i18n`): las 44
   pantallas + componentes usan `i18n.t()`; EN/ES/IT completos (1.8k claves, los
   locales de mobile son el superset). Idioma inicial = elección guardada o el
   del SO. Test de integridad `i18n/__tests__/locales.test.ts` (todas las claves
   usadas existen en los 3 idiomas, placeholders iguales). Queda solo en inglés
   el cuerpo genérico de la notificación del SO ("New message", proceso main).
3. ~~Sin lectura de QR~~ → ✅ resuelto (rama `feat/desktop-qr-from-image`): "Escanear
   QR" y "Añadir contacto" leen un QR desde una **imagen** (captura, foto, PNG
   exportado) con `jsqr` en el renderer (`utils/qrImage.ts`; Chromium en
   Windows/Linux no trae `BarcodeDetector`); nada sale del equipo y el texto
   decodificado sigue el mismo camino que el pegado (clave TOFU del QR, relay +
   raíz de mailbox de un enlace v2). Test `utils/__tests__/qrImage.test.ts`.
   Queda: sin cámara (no tiene sentido en escritorio).
4. **Sin canales públicos, sin llamadas de grupo, sin múltiples perfiles**
   (sección 11). El API multi-slot de `secureStorage`/`db` existe pero main
   **no aísla por slot** (PAR-1b del audit de agosto) — no cablear
   `ProfileSwitcher` hasta resolverlo con un fichero de DB por slot.
5. **Sin auto-update ni firma.** Cada beta se distribuye como `.exe` manual;
   Windows SmartScreen mostrará "editor desconocido".
6. **Solo Windows x64.** `mac`/`linux` están en la config de electron-builder
   pero no se han construido ni probado.

## Decisiones de producto pendientes

- **D-1 · Tor en desktop.** ✅ Decidido (a) y hecho en `feat/desktop-tor`.
- **D-2 · i18n.** ✅ Hecho en `feat/desktop-i18n` (ver limitación 2).
- **D-3 · Firma de código.** Sin presupuesto. **Confirmado en vivo 2026-09-14:
  Smart App Control (Windows 11) bloquea el `.exe` sin firmar** — ni siquiera es
  "instalable con aviso", directamente no arranca en máquinas con SAC activo.
  Vía gratuita: **SignPath Foundation** (firma OSS gratuita para proyectos
  open source con licencia OSI — AegisLink es GPL-3.0). Requisitos verificados
  (signpath.org/terms): binarios construidos desde el repo de forma
  verificable (CI), roles Author/Reviewer/Approver con 2FA, aprobación manual
  por release y una "Code signing policy" pública → borrador listo en
  `docs/CODE-SIGNING-POLICY.md`. El build en CI ya existe:
  `.github/workflows/build-desktop.yml` (windows-latest: typecheck → tests →
  fetch-tor pineado → ABI Electron → electron-builder → `SHA256SUMS`, artefacto
  y subida opcional a un GitHub Release `desktop-v*`). Falta: crear cuenta en
  signpath.io, solicitar en signpath.org/apply y, al aprobarse, añadir el job
  `signpath/github-action-submit-signing-request` tras el empaquetado.
  Alternativa de pago: Azure Trusted Signing (~10 €/mes).
- **D-4 · Canal de distribución.** ✅ GitHub Releases vía `build-desktop.yml`
  (`gh workflow run build-desktop.yml -f tag=desktop-v1.0.0-beta.1 -f attach=true`)
  con `SHA256SUMS`; auto-update (`electron-updater`) solo cuando exista firma.
