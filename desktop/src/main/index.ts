import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerSecureStorageHandlers } from './ipc/secureStorage'
import { registerDatabaseHandlers, openMainDbIfUnwrapped, closeDatabase } from './ipc/database'
import { registerNotificationHandlers } from './ipc/notifications'

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

  // H-1: Block all navigations to external origins
  win.webContents.on('will-navigate', (ev, url) => {
    const allowed =
      url.startsWith('file://') ||
      (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
    if (!allowed) ev.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools()
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register all IPC handlers before any window is created
registerSecureStorageHandlers()
registerDatabaseHandlers()
registerNotificationHandlers()

app.whenReady().then(() => {
  // Strip the Origin header on requests to the relay so the server treats the
  // desktop app like a native client (same as React Native, which sends none).
  // The renderer origin is http://localhost:517x in dev and file:// (-> "null")
  // when packaged — neither belongs in the relay's production CORS allowlist.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://aegislink.duckdns.org/*', 'wss://aegislink.duckdns.org/*'] },
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
        "connect-src 'self' ws://localhost:* wss://localhost:* https://aegislink.duckdns.org wss://aegislink.duckdns.org; " +
        "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-src 'none';"
      ]
    }
    // Counterpart of the Origin strip above: the relay never sees an Origin,
    // so it sends no CORS headers back — inject them here so the renderer's
    // fetch() can read the response. Chromium still enforces the CSP above,
    // which limits connect targets to the relay itself.
    if (details.url.startsWith('https://aegislink.duckdns.org/') || details.url === 'https://aegislink.duckdns.org') {
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
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDatabase()
})
