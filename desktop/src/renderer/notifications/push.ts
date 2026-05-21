/**
 * AegisLink Desktop — notifications module.
 *
 * Replaces mobile/src/notifications/push.ts (which uses expo-notifications).
 * On desktop, notifications are shown via window.aegis.notifications.show()
 * (IPC bridge to Electron's Notification API exposed in preload/index.ts).
 *
 * Push tokens and deep-link handling are not applicable on desktop:
 *   - No APNs/FCM registration needed — the relay uses Socket.IO for real-time
 *     delivery when the app is open, and the OS wakes the app on launch.
 *   - setNotificationOpenChatHandler is a stub for API compatibility with callers
 *     that import this module (e.g. mobile components shared via monorepo).
 */

type NotificationOpenHandler = (contactId: string) => void;

let _openHandler: NotificationOpenHandler | null = null;

/**
 * Show a system notification via Electron's main process.
 * Never includes message content in the title/body beyond the sender name —
 * consistent with the mobile wake-up-only policy.
 */
export async function showNotification(title: string, body: string): Promise<void> {
  await window.aegis.notifications.show(title, body);
}

/**
 * Show an incoming message notification.
 *
 * Mirrors the mobile showIncomingNotification signature so callers in shared
 * code compile without changes.
 *
 * @param _contactId  - sender's aegisId (not shown in notification for privacy)
 * @param senderName  - display name (may be truncated aegisId)
 * @param _body       - raw plaintext (NOT included in notification body)
 * @param isGroup     - whether the message is from a group
 * @param groupName   - optional group name for group messages
 */
export async function showIncomingNotification(
  _contactId: string,
  senderName: string,
  _body: string,
  isGroup: boolean,
  groupName?: string,
): Promise<void> {
  const title = isGroup && groupName ? groupName : 'AegisLink';
  const notifBody = isGroup && groupName
    ? `New message from ${senderName}`
    : `New message from ${senderName}`;
  await window.aegis.notifications.show(title, notifBody);
}

/**
 * Register a handler to be called when the user clicks a notification and
 * the app should navigate to a specific chat.
 *
 * Desktop stub: Electron notifications do not carry a contactId payload in
 * the current IPC surface. This is a no-op until deep-link support is added
 * to the notifications IPC handler (Fase 4+ hardening).
 */
export function setNotificationOpenChatHandler(handler: NotificationOpenHandler): void {
  _openHandler = handler;
  // _openHandler is stored but never called until the IPC surface is extended.
  void _openHandler; // suppress unused variable lint warning
}
