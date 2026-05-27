import { ipcMain, Notification } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

export function registerNotificationHandlers(): void {
  ipcMain.handle('notifications:show', (event, title: string, _body: unknown): void => {
    assertTrustedSender(event)
    if (typeof title !== 'string' || title.length > 512) throw new Error('invalid title')
    // M-3: body from renderer is intentionally ignored to prevent plaintext leakage.
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: 'AegisLink',
      body: 'Nuevo mensaje',
      silent: false
    })
    notification.show()
  })
}
