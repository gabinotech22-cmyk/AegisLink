import { app, ipcMain, Notification, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

/** What the renderer may ask for. Everything is validated here, never trusted. */
interface ShowOpts {
  /** true only when the user turned "show content" ON — otherwise body is ignored (M-3). */
  preview?: unknown
  /** No sound (user turned notification sound off). */
  silent?: unknown
  /** Chat to open when the notification is clicked (contact aegisId or group id). */
  chatId?: unknown
}

const MAX_TITLE = 128
const MAX_BODY = 512
const MAX_CHAT_ID = 128
const GENERIC_TITLE = 'AegisLink'
const GENERIC_BODY = 'New message'

export function registerNotificationHandlers(): void {
  ipcMain.handle('notifications:show', (event, title: unknown, body: unknown, opts?: ShowOpts): void => {
    assertTrustedSender(event)
    if (!Notification.isSupported()) return
    const preview = opts?.preview === true
    const silent = opts?.silent === true
    const chatId = typeof opts?.chatId === 'string' && opts.chatId.length <= MAX_CHAT_ID ? opts.chatId : null
    // M-3: renderer-supplied text reaches the OS notification center ONLY when
    // the user explicitly enabled content previews; otherwise both lines are
    // generic and carry nothing about who wrote or what.
    const safeTitle = preview && typeof title === 'string' && title.length > 0 && title.length <= MAX_TITLE ? title : GENERIC_TITLE
    const safeBody = preview && typeof body === 'string' && body.length > 0 && body.length <= MAX_BODY ? body : GENERIC_BODY
    const notification = new Notification({ title: safeTitle, body: safeBody, silent })
    const win = BrowserWindow.fromWebContents(event.sender)
    notification.on('click', () => {
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (chatId) win.webContents.send('notifications:open-chat', chatId)
    })
    notification.show()
  })

  // App-icon badge (dock / taskbar overlay). The renderer derives the count
  // from its unread counters; 0 clears it.
  ipcMain.handle('notifications:badge', (event, count: unknown): void => {
    assertTrustedSender(event)
    const n = typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 999) : 0
    try { app.setBadgeCount(n) } catch { /* platform without badge support */ }
  })

  ipcMain.handle('notifications:focused', (event): boolean => {
    assertTrustedSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    return !!win && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized()
  })
}
