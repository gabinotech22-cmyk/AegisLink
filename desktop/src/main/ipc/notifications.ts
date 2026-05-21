import { ipcMain, Notification } from 'electron'

export function registerNotificationHandlers(): void {
  ipcMain.handle('notifications:show', (_event, title: string, body: string): void => {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title,
      body,
      silent: false
    })
    notification.show()
  })
}
