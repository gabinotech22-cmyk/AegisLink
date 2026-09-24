import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { registerSecureStorageHandlers } from './ipc/secureStorage'
import { registerDatabaseHandlers, openMainDbIfUnwrapped, closeDatabase } from './ipc/database'
import { registerNotificationHandlers } from './ipc/notifications'
import { registerWindowHandlers } from './ipc/window'
import { registerSodiumHandlers } from './ipc/sodium'
import { startTor, stopTor, getTorStatus } from './tor/torProcess'
import { registerTorSioHandlers, disconnectAllTorSockets } from './tor/sioBridge'

// Relay hosts the renderer is allowed to reach. VITE_ vars are shared with the
// main build by electron-vite (envPrefix ['MAIN_VITE_', 'VITE_']).
const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? 'http://localhost:3001'
const ONION_URL = (import.meta.env.VITE_ONION_URL as string | undefined) ?? null
const RELAY_ORIGINS = [RELAY_URL, ONION_URL]
  .filter((u): u is string => !!u)
  .map((u) => { try { return new URL(u).origin } catch { return '' } })
  .filter(Boolean)
function isRelayUrl(url: string): boolean {
  return RELAY_ORIGINS.some((o) => url === o || url.startsWith(o + '/'))
}
/** `connect-src` entries for every relay origin (http(s) + matching ws(s)). */
function relayConnectSrc(): string {
  return RELAY_ORIGINS.flatMap((o) => [o, o.replace(/^http/, 'ws')]).join(' ')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0e0d',
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // Tor: WebRTC must not open UDP sockets outside the proxy — that would leak
  // the real IP to the TURN server / peer around Tor. With this policy Chromium
  // only uses proxied TCP candidates (TURN over TCP through the SOCKS proxy).
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // Open external links in the OS browser, not inside Electron.
  // Only http(s) is handed to the OS — never file://, ms-msdt:, smb:, etc.,
  // which would let a crafted link in a message trigger OS protocol handlers
  // (Follina-class abuse). (Golden rule #6: production fails closed.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') {
        void shell.openExternal(url)
      }
    } catch {
      // malformed URL — ignore
    }
    return { action: 'deny' }
  })

  // H-1 / audit 2026-07 (M5): restrict navigation to the app's OWN document.
  // The renderer is the privileged context (preload exposes window.aegis IPC to
  // the encrypted DB), so allowing ANY file:// let a planted local HTML file
  // navigate into it and drive those IPC calls (→ full E2EE compromise). Pin to
  // the exact packaged index.html (prod) or the Vite dev URL (dev); permit only
  // #hash / ?query suffixes of that same document, block everything else.
  const appUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  win.webContents.on('will-navigate', (ev, url) => {
    const sameDoc =
      url === appUrl || url.startsWith(appUrl + '#') || url.startsWith(appUrl + '?')
    // In dev, Vite navigates within its own origin (HMR, sub-paths).
    const devOk =
      is.dev &&
      !!process.env['ELECTRON_RENDERER_URL'] &&
      url.startsWith(process.env['ELECTRON_RENDERER_URL'])
    if (!sameDoc && !devOk) ev.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools()
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register all IPC handlers before any window is created
registerSodiumHandlers()
registerSecureStorageHandlers()
registerDatabaseHandlers()
registerNotificationHandlers()
registerWindowHandlers()
registerTorSioHandlers()

app.whenReady().then(async () => {
  // ── Tor always-on (fail-closed) ─────────────────────────────────────────────
  // Pick the SOCKS ports and point the WHOLE session at Tor BEFORE any window
  // exists. Until Tor bootstraps the proxy simply refuses connections — the
  // relay is never reached over clearnet. Loopback (dev Vite server / local
  // relay) is implicitly bypassed by Chromium.
  const { controlSocksPort } = await startTor()
  await session.defaultSession.setProxy({ proxyRules: `socks5://127.0.0.1:${controlSocksPort}` })

  // Strip the Origin header on requests to the relay so the server treats the
  // desktop app like a native client (same as React Native, which sends none).
  // The renderer origin is http://localhost:517x in dev and file:// (-> "null")
  // when packaged — neither belongs in the relay's production CORS allowlist.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: RELAY_ORIGINS.flatMap((o) => [`${o}/*`, `${o.replace(/^http/, 'ws')}/*`]) },
    (details, callback) => {
      delete details.requestHeaders['Origin']
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // C-2: Enforce Content-Security-Policy via response header injection.
  // In dev, Vite's react-refresh preamble is an inline script — allow it
  // there only; packaged builds keep the strict script-src.
  const scriptSrc = is.dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"

  // Specific renderer origin to echo back in CORS (no wildcard). The renderer
  // is the only context that fetches the relay: in dev it loads from the Vite
  // URL (http://localhost:517x); packaged it loads via file://, whose Origin
  // serializes to the string "null". Chromium validates Access-Control-Allow-
  // Origin against this exact origin, so `*` is unnecessarily broad.
  const rendererOrigin = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
    : 'null'
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
        `connect-src 'self' ws://localhost:* wss://localhost:* ${relayConnectSrc()}; ` +
        "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-src 'none';"
      ]
    }
    // Counterpart of the Origin strip above: the relay never sees an Origin,
    // so it sends no CORS headers back — inject them here so the renderer's
    // fetch() can read the response. Chromium still enforces the CSP above,
    // which limits connect targets to the relay itself.
    if (isRelayUrl(details.url)) {
      responseHeaders['Access-Control-Allow-Origin'] = [rendererOrigin]
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS']
      responseHeaders['Access-Control-Allow-Headers'] = ['Content-Type, Accept']
    }
    callback({ responseHeaders })
  })

  // Open the main DB for legacy / no-PIN installs now that the app is ready —
  // safeStorage (used by getDbKey) is illegal before this point on Electron 42+.
  // PIN-wrapped installs stay closed until the renderer sends db:unlock.
  openMainDbIfUnwrapped()

  createWindow()

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  closeDatabase()
  disconnectAllTorSockets()
  stopTor()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDatabase()
  disconnectAllTorSockets()
  stopTor()
})

// Keep the linter honest about the status accessor being part of the main API
// surface (used by sioBridge's `tor:status` handler).
void getTorStatus
