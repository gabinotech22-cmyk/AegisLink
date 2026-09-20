/**
 * AegisLink Desktop — notifications module.
 *
 * Desktop twin of mobile/src/notifications/push.ts. Notifications are shown
 * through window.aegis.notifications (IPC → Electron Notification in the main
 * process, main/ipc/notifications.ts). No push tokens: the socket delivers
 * while the app runs.
 *
 * Policy — the same switches the Notifications screen exposes, every one of
 * them honoured here (until 1.0.7 the screen was a stub and this module
 * ignored all of them):
 *   - master OFF → nothing, unless a keyword matched;
 *   - muted contact (`muted` / `mutedUntil`) → nothing, unless a keyword matched;
 *   - the chat is open and the window focused → nothing (the user is looking at it);
 *   - "show content" OFF → generic title/body, nothing about who or what;
 *   - sound OFF → silent;
 *   - badge = unread total, re-derived on every counter change (0 when off).
 */
import { logger } from '../utils/logger';
import { usePreferences } from '../store/preferences';
import i18n from '../i18n';
import { previewLabel } from '../utils/messagePreview';

const DEV = import.meta.env.DEV;

type NotificationOpenHandler = (chatId: string) => void;

let _openHandler: NotificationOpenHandler | null = null;
let _unsubscribeOpen: (() => void) | null = null;
let activeChatId: string | null = null;

/** The chat currently on screen (contact aegisId or group id), or null. */
export function setActiveChatNotificationId(id: string | null): void {
  activeChatId = id;
}

export function getActiveChatNotificationId(): string | null {
  return activeChatId;
}

/** Generic (content-free) notification, e.g. security events. */
export async function showNotification(title: string, body: string): Promise<void> {
  try {
    const prefs = usePreferences.getState();
    await window.aegis.notifications.show(title, body, { preview: false, silent: !prefs.notifSound });
  } catch (e) {
    if (DEV) logger.warn('[push] showNotification failed:', (e as Error).message);
  }
}

/** True when one of the user's keywords appears in the (decrypted, local) body. */
export function matchesKeyword(body: string, keywords: readonly string[]): boolean {
  const lower = body.toLowerCase();
  for (const kw of keywords) {
    const k = kw.trim().toLowerCase();
    if (k && lower.includes(k)) return true;
  }
  return false;
}

/** Pure decision so the policy is unit-testable without Electron. */
export function decideNotification(input: {
  prefs: { notifMaster: boolean; notifPreview: boolean; notifSound: boolean; notifKeywords: readonly string[] };
  contact: { muted?: boolean; mutedUntil?: number | null } | null | undefined;
  chatId: string;
  activeChatId: string | null;
  windowFocused: boolean;
  senderName: string;
  body: string;
  isGroup: boolean;
  groupName?: string;
  now: number;
}): { show: false } | { show: true; title: string; body: string; preview: boolean; silent: boolean } {
  const { prefs, contact } = input;
  const keyword = matchesKeyword(input.body, prefs.notifKeywords);
  if (!prefs.notifMaster && !keyword) return { show: false };
  const muted = !!contact?.muted || (!!contact?.mutedUntil && contact.mutedUntil > input.now);
  if (muted && !keyword) return { show: false };
  if (input.windowFocused && input.activeChatId === input.chatId) return { show: false };
  const who = input.isGroup ? (input.groupName ? `${input.groupName} · ${input.senderName}` : input.senderName) : input.senderName;
  return {
    show: true,
    preview: prefs.notifPreview,
    // With preview OFF the main process replaces both lines with generic text;
    // we still send nothing identifying, so a policy slip there leaks nothing.
    // With preview ON the body is the HUMAN label, never the wire text: a
    // media wire carries the blob key/nonce/token.
    title: prefs.notifPreview ? who : 'AegisLink',
    body: prefs.notifPreview ? previewLabel(input.body, i18n.t) : '',
    silent: !prefs.notifSound,
  };
}

/**
 * Incoming message notification. Signature mirrors mobile so shared call
 * sites compile unchanged.
 */
export async function showIncomingNotification(
  contactId: string,
  senderName: string,
  body: string,
  isGroup: boolean,
  groupName?: string,
  groupId?: string,
): Promise<void> {
  try {
    const prefs = usePreferences.getState();
    const chatId = isGroup ? (groupId ?? contactId) : contactId;
    let contact: { muted?: boolean; mutedUntil?: number | null } | undefined;
    try {
      const { useContacts } = await import('../store/contacts');
      contact = useContacts.getState().contacts.find((c) => c.aegisId === contactId);
    } catch { /* store unavailable — treat as not muted */ }
    let windowFocused = false;
    try { windowFocused = await window.aegis.notifications.isFocused(); } catch { /* unknown → notify */ }
    const d = decideNotification({
      prefs, contact, chatId, activeChatId, windowFocused, senderName, body, isGroup, groupName, now: Date.now(),
    });
    if (!d.show) return;
    await window.aegis.notifications.show(d.title, d.body, { preview: d.preview, silent: d.silent, chatId });
  } catch (e) {
    if (DEV) logger.warn('[push] showIncomingNotification failed:', (e as Error).message);
  }
}

/** Unread total from the store counters (same rule as mobile totalUnreadFrom). */
export function totalUnreadFrom(unreadCounts: Record<string, number> | null | undefined): number {
  if (!unreadCounts) return 0;
  let total = 0;
  for (const v of Object.values(unreadCounts)) if (typeof v === 'number' && v > 0) total += v;
  return total;
}

/**
 * Make the dock/taskbar badge equal the unread total — 0 when the badge
 * setting is off. Called from the messages store after every counter change.
 */
export async function syncAppBadge(): Promise<void> {
  try {
    const prefs = usePreferences.getState();
    const { useMessages } = await import('../store/messages');
    const count = prefs.notifBadge ? totalUnreadFrom(useMessages.getState().unreadCounts) : 0;
    await window.aegis.notifications.setBadge(count);
  } catch (e) {
    if (DEV) logger.warn('[push] syncAppBadge failed:', (e as Error).message);
  }
}

/**
 * Called when the user clicks a notification: the main process sends the
 * chat id it was shown for, we hand it to the app's navigation.
 */
export function setNotificationOpenChatHandler(handler: NotificationOpenHandler): void {
  _openHandler = handler;
  if (_unsubscribeOpen) return; // already listening — the handler above is what changed
  try {
    _unsubscribeOpen = window.aegis.notifications.onOpenChat((chatId) => { _openHandler?.(chatId); });
  } catch (e) {
    if (DEV) logger.warn('[push] onOpenChat unavailable:', (e as Error).message);
  }
}
