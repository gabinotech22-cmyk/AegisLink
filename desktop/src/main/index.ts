import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerSecureStorageHandlers } from './ipc/secureStorage'
import { registerDatabaseHandlers, closeDatabase } from './ipc/database'
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

  // Open external links in the OS browser, not inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
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
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register all IPC handlers before any window is created
registerSecureStorageHandlers()
registerDatabaseHandlers()
registerNotificationHandlers()

app.whenReady().then(() => {
  // C-2: Enforce Content-Security-Policy via response header injection
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* wss://localhost:*; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-src 'none';"
        ]
      }
    })
  })

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
