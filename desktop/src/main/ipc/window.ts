import { ipcMain, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

/**
 * Privacy → "Block screenshots": Electron's content protection. On Windows
 * (SetWindowDisplayAffinity) and macOS the window is excluded from screen
 * capture and screen sharing; on Linux it is a no-op, which the renderer copy
 * states. This is the desktop counterpart of Android's FLAG_SECURE.
 */
export function registerWindowHandlers(): void {
  ipcMain.handle('window:set-content-protection', (event, enabled: unknown): boolean => {
    assertTrustedSender(event)
    const on = enabled === true
    for (const win of BrowserWindow.getAllWindows()) win.setContentProtection(on)
    return process.platform === 'win32' || process.platform === 'darwin'
  })
}
