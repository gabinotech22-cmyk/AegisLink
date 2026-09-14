# AegisLink Desktop — Beta 1 (Windows)

Estado canónico del cliente desktop. Si este doc y el código discrepan, gana el
código (regla de oro doc↔código). Última verificación: 2026-09-14, rama
`fix/desktop-beta-packaging`.

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
| `npm test` (vitest) | ✅ 23 ficheros / 179 tests | CI `desktop-test` en `.github/workflows/ci.yml` |
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

**Consecuencia local**: tras `npm run package`, `node_modules` queda con el
binario de Electron y `npm test` en local fallará al cargar SQLCipher. Restaurar
con:

```bash
cd desktop && npm rebuild better-sqlite3-multiple-ciphers
```

(CI no lo sufre: `npm ci` instala el prebuilt de Node y nunca empaqueta.)

## Cómo construir la beta

```bash
cd desktop
npm ci
npm run typecheck && npm test
npm run build
npm run package        # → dist/AegisLink Setup <ver>.exe (NSIS) + dist/AegisLink <ver>.exe (portable)
```

`desktop/.env` (gitignored) debe apuntar al relay de producción:
`VITE_RELAY_URL=https://aegislink.duckdns.org` y `VITE_TURN_URL=turn:aegislink.duckdns.org:3478`.
Sin `.env` el build apunta a `localhost:3001` (`desktop/src/renderer/config.ts`).

## Limitaciones conocidas de Beta 1 (declaradas, no ocultas)

1. **Sin Tor.** El desktop no embebe Tor ni configura proxy SOCKS; por tanto
   `MAILBOX_ENABLED` es `false` (fail-closed en `config.ts`) y la entrega usa el
   transporte por `aegisId`. El relay ve la IP del desktop. Mobile sí tiene Tor
   embebido. Ver decisión pendiente D-1.
2. **UI solo en inglés.** Existen `en/es/it.json` pero solo 3 pantallas
   (`Onboarding`, `Privacy`, `DeleteAccountSection`) usan `react-i18next`; las
   otras 41 tienen literales en inglés. Ver D-2.
3. **Sin lectura de QR.** `ScanQR.tsx` acepta pegar el Aegis ID / JSON; no
   decodifica imágenes ni usa cámara.
4. **Sin canales públicos, sin llamadas de grupo, sin múltiples perfiles**
   (sección 11). El API multi-slot de `secureStorage`/`db` existe pero main
   **no aísla por slot** (PAR-1b del audit de agosto) — no cablear
   `ProfileSwitcher` hasta resolverlo con un fichero de DB por slot.
5. **Sin auto-update ni firma.** Cada beta se distribuye como `.exe` manual;
   Windows SmartScreen mostrará "editor desconocido".
6. **Solo Windows x64.** `mac`/`linux` están en la config de electron-builder
   pero no se han construido ni probado.

## Decisiones de producto pendientes

- **D-1 · Tor en desktop.** Opciones: (a) bundlear `tor` expert bundle y
  `session.setProxy({ proxyRules: 'socks5://127.0.0.1:<port>' })` como hacen
  Cwtch/Ricochet — coherente con "Tor siempre, sin toggle"; (b) declarar la
  beta como "sin Tor" en la pantalla de onboarding del desktop. Recomendación:
  (b) para Beta 1 con aviso visible, (a) como requisito para salir de beta.
- **D-2 · i18n.** Beta 1 en inglés; portar las 41 pantallas a `t()` antes de
  la 1.0 desktop (las claves ya existen en los JSON).
- **D-3 · Firma de código.** Certificado OV/EV (~200-400 €/año) o Azure Trusted
  Signing; sin ella la beta es "instalable con aviso" y muchos usuarios de
  privacidad no pasarán del SmartScreen.
- **D-4 · Canal de distribución.** GitHub Releases con `SHA256SUMS` firmado con
  la clave del proyecto es lo mínimo; auto-update (`electron-updater`) solo
  cuando exista firma.
