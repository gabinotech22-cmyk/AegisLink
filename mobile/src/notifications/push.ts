import * as Notifications from 'expo-notifications';
import { logger } from '../utils/logger';
import { Platform } from 'react-native';
import { SERVER_URL } from '../config';
import type { Identity } from '../crypto/identity';
import { tAsync } from '../i18n';

/** Language-neutral marker appended to message notifications. */
const E2EE_MARK = ' ● E2EE';

function makeSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Push wake-ups: register the Expo push token for our Aegis ID so the server
 * can ping us when an envelope arrives while we're offline.
 *
 * The push payload NEVER contains message content — it's purely a "wake up
 * and reconnect" signal. The real message is fetched via the relay socket on
 * reconnect and decrypted on-device.
 */

let registered = false;
// Whether the LOCAL notification behavior (tap routing, cold-start deep link,
// activeChatId reset, channels, categories) has been wired up. Tracked
// separately from `registered` because it must succeed even when the remote
// push-token registration fails (e.g. an emulator with no FCM).
let localHandlersAttached = false;

// Callback set by App.tsx to handle deep links from notification taps.
// A tap can target a 1:1 chat (aegisId), a group chat (groupId), or a public
// channel post (channelId) — the App handler routes to whichever is present.
// For group messages `aegisId` is the message SENDER (not the chat), so
// groupId MUST be provided to open the correct screen.
export interface NotificationOpenTarget {
  aegisId?: string;
  groupId?: string;
  channelId?: string;
}
let _onOpenChat: ((target: NotificationOpenTarget) => void) | null = null;

export function setNotificationOpenChatHandler(fn: (target: NotificationOpenTarget) => void) {
  _onOpenChat = fn;
}

/**
 * Resolve which chat a notification tap should open from its `data` payload.
 * Channel posts carry `isChannel:true` + `channelId` (see
 * notifications/channelNotifications.ts) → route by channelId. Group messages
 * carry `isGroup:true` + `groupId` (the `fromAegisId` is the SENDER, not the
 * chat) → route by groupId. 1:1 messages route by fromAegisId. Returns null
 * when there isn't enough to route (e.g. a contentless server wake-up push,
 * which by design carries no chat identity).
 */
export function resolveNotificationOpenTarget(
  data: Record<string, unknown> | undefined,
): NotificationOpenTarget | null {
  const fromAegisId = data?.fromAegisId as string | undefined;
  const groupId = data?.groupId as string | undefined;
  const channelId = data?.channelId as string | undefined;
  if (data?.isChannel === true) return channelId ? { channelId } : null;
  if (data?.isGroup === true) return groupId ? { groupId } : null;
  return fromAegisId ? { aegisId: fromAegisId } : null;
}

// Notification handler: suppress the server's generic wake-up push when the
// app is in the foreground — the socket handler will call showIncomingNotification()
// with the full decrypted sender name and body. When the app is in the background
// or killed, the OS shows the server push directly (visible push with generic text).
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const kind = (notification.request.content.data as Record<string, unknown>)?.kind as string | undefined;
    // Suppress the generic server wake-up banners — we'll show richer local ones
    if (kind === 'wakeup' || kind === 'call_wakeup') {
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    // Local notifications (from showIncomingNotification / showIncomingCallNotification)
    // have no 'kind' field — always show them
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    };
  },
});

/**
 * Wire up everything LOCAL about notifications: Android channels, tap/action
 * response routing, the cold-start deep link, the background→activeChatId reset,
 * and the action categories. Idempotent and side-effect-only.
 *
 * CRITICAL: this must run independently of getExpoPushTokenAsync(), which throws
 * on devices without a working FCM stack (e.g. most emulators). Previously all
 * of this lived AFTER the token call inside registerForPush, so a token failure
 * silently disabled notification taps (taps opened nothing) AND the
 * activeChatId reset (banners for the currently-open chat were suppressed even
 * while backgrounded — which manifested as "group notifications don't work"
 * whenever the group was the last-open screen).
 */
function attachLocalNotificationHandlers(): void {
  if (localHandlersAttached) return;
  localHandlersAttached = true;

  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('aegislink-messages', {
      name: 'Mensajes',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#5bf2b9',
      // On-brand soft bell (see assets/sounds/gen_sounds.py). Channel sound is
      // immutable after creation — published builds ship it from the first
      // version, so no channel-id bump is needed.
      sound: 'msg_received.mp3',
      showBadge: true,
    });
    void Notifications.setNotificationChannelAsync('aegislink-calls', {
      name: 'Llamadas',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 200, 500],
      lightColor: '#5bf2b9',
      // Calm arpeggiated ring instead of the OS default ringtone.
      sound: 'call_incoming.mp3',
      bypassDnd: true,
    });
    void Notifications.setNotificationChannelAsync('aegislink-security', {
      name: 'Seguridad',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 100, 100, 100, 100, 100],
      lightColor: '#ff6b6b',
      sound: 'default',
      bypassDnd: true,
    });
  }

  // Handle notification action taps (Reply, Mark read) and default tap to open chat
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as Record<string, unknown>;
    const fromAegisId = data?.fromAegisId as string | undefined;
    const actionId = response.actionIdentifier;

    if (actionId === 'REPLY') {
      // User replied from notification — encrypt and send without opening the app.
      // The socket may be down (background wake): sendMessage/sendGroupMessage
      // persist to the SQLite outbox before emitting, so triggering reconnect()
      // is enough — flushOutbox() drains the job on the next auth:ok.
      const replyText = (response as { userText?: string }).userText?.trim();
      const isGroup = data?.isGroup === true;
      const groupId = data?.groupId as string | undefined;
      if (replyText && (isGroup ? groupId : fromAegisId)) {
        void (async () => {
          try {
            const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
            const identity = useIdentity.getState().identity;
            if (!identity) return;
            const client = require('../socket/client') as typeof import('../socket/client');
            if (!client.isConnected()) client.connect(identity);
            if (isGroup && groupId) {
              await client.sendGroupMessage({ identity, groupId, plaintext: replyText });
            } else if (fromAegisId) {
              const { useContacts } = require('../store/contacts') as typeof import('../store/contacts');
              let contact = useContacts.getState().get(fromAegisId);
              if (!contact) {
                // Background wake before the app hydrated stores — load from SQLite.
                await useContacts.getState().hydrate();
                contact = useContacts.getState().get(fromAegisId);
              }
              if (!contact) return;
              const { decodeBase64 } = require('tweetnacl-util') as typeof import('tweetnacl-util');
              await client.sendMessage({
                identity,
                recipientAegisId: fromAegisId,
                recipientPublicKey: decodeBase64(contact.publicKeyB64),
                plaintext: replyText,
              });
            }
            // Only dismiss once the reply is sent (or safely queued in the outbox).
            await Notifications.dismissNotificationAsync(response.notification.request.identifier);
          } catch (e) {
            if (__DEV__) logger.warn('[push] inline reply failed:', e);
          }
        })();
      }
    } else if (actionId === 'MARK_READ') {
      // For group notifications the chat is the group, not the sender.
      const chatId = data?.isGroup === true ? (data?.groupId as string | undefined) : fromAegisId;
      if (chatId) {
        try {
          const { useMessages } = require('../store/messages') as typeof import('../store/messages');
          void useMessages.getState().markRead(chatId);
          void Notifications.dismissNotificationAsync(response.notification.request.identifier);
        } catch (e) {
          if (__DEV__) logger.warn('[push] mark-read action failed:', e);
        }
      }
    } else if ((data?.type as string) === 'call_invite') {
      // App was woken by a call push — reconnect socket so the relay can
      // re-deliver call:invite once the authenticated socket is established.
      try {
        const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
        const identity = useIdentity.getState().identity;
        const client = require('../socket/client') as typeof import('../socket/client');
        if (identity) client.connect(identity);
      } catch { /* socket module not yet loaded — no-op */ }
      // Also surface the incoming call screen if caller info is available
      if (fromAegisId && _onOpenChat) {
        _onOpenChat({ aegisId: fromAegisId });
      }
    } else if (actionId === 'DISMISS_GROUPCALL') {
      // User dismissed the voice-channel banner — just clear the notification.
      void Notifications.dismissNotificationAsync(response.notification.request.identifier);
    } else if (
      (data?.type as string) === 'group_call_channel' ||
      actionId === 'JOIN_GROUPCALL'
    ) {
      // Tap or "Unirse" on a voice-channel notification: reconnect so the relay
      // re-delivers the channel heartbeat, then join if the channel is already
      // known locally, else open the group chat where the live banner appears.
      const groupId = data?.groupId as string | undefined;
      try {
        const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
        const identity = useIdentity.getState().identity;
        const client = require('../socket/client') as typeof import('../socket/client');
        if (identity && !client.isConnected()) client.connect(identity);
      } catch { /* socket module not yet loaded — no-op */ }
      if (groupId) {
        try {
          const { useActiveCalls } = require('../store/activeCalls') as typeof import('../store/activeCalls');
          if (useActiveCalls.getState().getFresh(groupId, Date.now())) {
            const { joinGroupCall } = require('../socket/groupCalls') as typeof import('../socket/groupCalls');
            void joinGroupCall(groupId);
          } else if (_onOpenChat) {
            _onOpenChat({ groupId });
          }
        } catch { /* stores not ready — best effort */ }
      }
    } else {
      // Default tap — open the group chat (by groupId) or the 1:1 chat.
      const target = resolveNotificationOpenTarget(data);
      if (target && _onOpenChat) _onOpenChat(target);
    }
  });

  // Check if app was opened from a notification (cold-start deep link)
  void (async () => {
    try {
      const lastResponse = await Notifications.getLastNotificationResponseAsync();
      if (!lastResponse) return;
      const data = lastResponse.notification.request.content.data as Record<string, unknown>;
      const fromAegisId = data?.fromAegisId as string | undefined;
      if ((data?.type as string) === 'call_invite') {
        // Cold-start from a call push — reconnect socket first, then navigate
        try {
          const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
          const identity = useIdentity.getState().identity;
          const client = require('../socket/client') as typeof import('../socket/client');
          if (identity) client.connect(identity);
        } catch { /* socket module not yet loaded — no-op */ }
        if (fromAegisId && _onOpenChat) {
          setTimeout(() => _onOpenChat?.({ aegisId: fromAegisId }), 500);
        }
      } else {
        // Route by groupId for group messages (fromAegisId is the sender).
        const target = resolveNotificationOpenTarget(data);
        if (target && _onOpenChat) setTimeout(() => _onOpenChat?.(target), 500);
      }
    } catch { /* no last response / module not ready — no-op */ }
  })();

  // When the app moves to the background or becomes inactive, clear activeChatId
  // so that notifications are shown for the previously-focused chat. Without this,
  // a user who backgrounds the app while in a chat would never receive banners for
  // new messages in that chat until the app is foregrounded and navigated away.
  const { AppState } = require('react-native') as typeof import('react-native');
  AppState.addEventListener('change', (nextState: string) => {
    if (nextState === 'background' || nextState === 'inactive') {
      activeChatId = null;
    }
  });

  // Register notification action categories (Reply + Mark as read)
  void Notifications.setNotificationCategoryAsync('aegislink-message', [
    {
      identifier: 'REPLY',
      buttonTitle: 'Responder',
      textInput: {
        submitButtonTitle: 'Enviar',
        placeholder: 'Mensaje cifrado…',
      },
      options: { opensAppToForeground: false },
    },
    {
      identifier: 'MARK_READ',
      buttonTitle: 'Marcar leído',
      options: { opensAppToForeground: false, isDestructive: false },
    },
  ]);

  void Notifications.setNotificationCategoryAsync('aegislink-call', [
    {
      identifier: 'ACCEPT_CALL',
      buttonTitle: 'Contestar',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'DECLINE_CALL',
      buttonTitle: 'Rechazar',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);

  // Group voice-channel banner notification (Discord-style: join, don't ring).
  void Notifications.setNotificationCategoryAsync('aegislink-groupcall', [
    {
      identifier: 'JOIN_GROUPCALL',
      buttonTitle: 'Unirse',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'DISMISS_GROUPCALL',
      buttonTitle: 'Descartar',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);
}

export async function registerForPush(identity: Identity): Promise<{ token: string | null }> {
  // Local notification UX (tap routing, cold-start, activeChatId reset, channels,
  // categories) must work even when the remote push token can't be obtained —
  // attach it FIRST, unconditionally, before anything that may throw.
  attachLocalNotificationHandlers();

  if (registered) return { token: null };

  try {
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted || perm.status === 'granted';
    if (!granted && perm.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted || asked.status === 'granted';
    }
    if (!granted) {
      if (__DEV__) logger.debug('[push] notification permission denied — wake-ups disabled');
      return { token: null };
    }

    // Route background wake-up pushes to the headless reconnect task so a
    // killed/backgrounded app can rebuild its socket (and surface rich call
    // notifications) without a tap. Independent of the token POST below.
    try {
      const { registerBackgroundReconnect } = require('./backgroundReconnect') as typeof import('./backgroundReconnect');
      await registerBackgroundReconnect();
    } catch { /* task module unavailable — fall back to tap-to-wake */ }

    // Channels have NO server push (the relay can't hold a subscriber list
    // without leaking metadata). Register a device-scheduled background-fetch
    // that delta-pulls subscribed channels and fires local notifications.
    try {
      const { registerChannelBackgroundSync } = require('./channelBackgroundSync') as typeof import('./channelBackgroundSync');
      await registerChannelBackgroundSync();
    } catch { /* task module unavailable (Expo Go) — foreground live notify still works */ }

    try {
      const { registerDailySummaryTask } = require('./dailySummaryTask') as typeof import('./dailySummaryTask');
      await registerDailySummaryTask();
    } catch { /* task module unavailable */ }

    const tokenResponse = await Notifications.getExpoPushTokenAsync();
    const expoToken = tokenResponse.data;

    // The actual token→aegisId association happens over the AUTHENTICATED
    // Socket.IO path (socket.on('push:register') after the Ed25519
    // challenge-response). The old unauthenticated POST /push/register was
    // removed server-side (H-4 security fix); calling it here only 404'd and
    // forced this function to report failure. We just acquire the token; the
    // socket layer (socket/client.ts) emits push:register once authenticated.
    registered = true;
    if (__DEV__) logger.debug('[push] registered for wake-ups, token:', expoToken);
    return { token: expoToken };
  } catch (e) {
    // Token acquisition/registration failed (e.g. emulator without FCM). Local
    // notifications + tap routing already work via attachLocalNotificationHandlers().
    if (__DEV__) logger.warn('[push] remote token registration failed (local notifications still active):', (e as Error).message);
    return { token: null };
  }
}

/** Revoke push token on logout */
export async function unregisterPush(aegisId: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/push/unregister`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: makeSignal(8_000),
      body: JSON.stringify({ aegisId }),
    });
  } catch { /* best effort */ }
  registered = false;
}

let activeChatId: string | null = null;

/** Tell push subsystem which chat screen is currently focused to avoid duplicate sounds/banners */
export function setActiveChatNotificationId(id: string | null) {
  activeChatId = id;
}

/**
 * The chat id (contact aegisId or group id) whose screen is currently focused,
 * or null. Used to suppress unread-count increments for messages that arrive
 * while the user is already looking at the conversation — same guard the push
 * banner and in-app sound already use.
 */
export function getActiveChatNotificationId(): string | null {
  return activeChatId;
}

/**
 * Surface decrypted E2EE messages as local notifications in strict alignment
 * with AegisLink preference switches (sound, badge, keywords bypass, muted, preview).
 */
export async function showIncomingNotification(
  senderAegisId: string,
  senderName: string,
  body: string,
  isGroup: boolean,
  groupName?: string,
  groupId?: string
) {
  try {
    const { usePreferences } = require('../store/preferences');
    const prefs = usePreferences.getState();

    const targetChatId = isGroup ? (groupId ?? groupName ?? senderAegisId) : senderAegisId;
    let isMuted = prefs.mutedChats.includes(targetChatId);

    if (!isMuted) {
      try {
        const { getContact } = require('../db/local');
        const contact = await getContact(senderAegisId);
        if (contact && contact.mutedUntil && contact.mutedUntil > Date.now()) {
          isMuted = true;
        }
      } catch (e) {
        if (__DEV__) logger.warn('[push] failed to check database muted_until:', e);
      }
    }

    // Keyword bypass prioritizes alerting even in silent or muted states
    let keywordMatch = false;
    const lowerBody = body.toLowerCase();
    for (const kw of prefs.notifKeywords) {
      const trimmed = kw.trim().toLowerCase();
      if (trimmed && lowerBody.includes(trimmed)) {
        keywordMatch = true;
        break;
      }
    }

    if (!prefs.notifMaster && !keywordMatch) return;
    if (isMuted && !keywordMatch) return;

    // Per-contact "mentions only": suppress unless a keyword/mention matched.
    const mentionsOnly = prefs.mentionsOnlyChats?.includes(targetChatId) ?? false;
    if (mentionsOnly && !keywordMatch) return;

    // Avoid displaying alert if the user is already actively looking at the sender's chat
    if (activeChatId === targetChatId) return;

    const showContent = prefs.notifPreview || keywordMatch;
    let title = 'AegisLink';
    let notificationBody = '';

    if (showContent) {
      if (isGroup && groupName) {
        title = `AegisLink · ${groupName}`;
        notificationBody = `${senderName}: ${body}${E2EE_MARK}`;
      } else {
        title = `AegisLink · ${senderName}`;
        notificationBody = `${body}${E2EE_MARK}`;
      }
    } else {
      if (isGroup && groupName) {
        title = `AegisLink · ${groupName}`;
        notificationBody = (await tAsync('notif.groupNewMessage')) + E2EE_MARK;
      } else {
        notificationBody = (await tAsync('notif.newMessage')) + E2EE_MARK;
      }
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: notificationBody,
        sound: prefs.notifSound ? 'msg_received.mp3' : undefined,
        categoryIdentifier: 'aegislink-message',
        // groupId is REQUIRED for a group tap to open the right screen — without
        // it the tap handler can only see fromAegisId (the sender) and would open
        // a 1:1 chat with whoever sent the group message.
        data: { fromAegisId: senderAegisId, isGroup, groupId, groupName },
        // Android notification channel
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-messages' } : {}),
      },
      trigger: null,
    });

    if (prefs.notifBadge) {
      const { useMessages } = require('../store/messages');
      const unreadCounts = useMessages.getState().unreadCounts ?? {};
      const totalUnread = Object.values(unreadCounts).reduce((acc: number, val: unknown) => acc + (typeof val === 'number' ? val : 0), 0);
      await Notifications.setBadgeCountAsync(totalUnread + 1);
    }
  } catch (err) {
    if (__DEV__) logger.warn('[push] showIncomingNotification failed:', err);
  }
}

/**
 * Trigger critical security notifications that bypass all settings/do-not-disturb
 * as specified in Section 06 of the AegisLink Notifications spec sheet.
 */
export async function showCriticalSecurityNotification(
  type: 'key_changed' | 'session_revoked' | 'auto_wipe',
  detail?: string
) {
  let title = await tAsync('notif.securityTitle');
  let body = '';

  if (type === 'key_changed') {
    body = await tAsync('notif.keyChanged', { name: detail ?? (await tAsync('notif.aContact')) });
  } else if (type === 'session_revoked') {
    title = await tAsync('notif.revokedTitle');
    body = await tAsync('notif.sessionRevoked');
  } else if (type === 'auto_wipe') {
    title = await tAsync('notif.autoWipeTitle');
    body = await tAsync('notif.autoWipeBody');
  }

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-security' } : {}),
      },
      trigger: null,
    });
  } catch (err) {
    if (__DEV__) logger.warn('[push] showCriticalSecurityNotification failed:', err);
  }
}

/**
 * Surface an open group voice channel as a local "Unirse / Descartar"
 * notification (Discord-style banner, not a ring). Mirrors the design mockup:
 * lock-screen card with a Join action; the payload itself carries no call
 * content. Skipped while the user is already looking at this group's chat (the
 * in-chat banner covers that) and honors master/mute preferences.
 */
export async function showGroupCallChannelNotification(
  groupId: string,
  groupName: string,
  callId: string,
): Promise<void> {
  try {
    // Don't double-notify the chat the user is currently viewing.
    if (activeChatId === groupId) return;

    const { usePreferences } = require('../store/preferences');
    const prefs = usePreferences.getState();
    if (!prefs.notifMaster) return;
    if (prefs.mutedChats.includes(groupId)) return;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: `AegisLink · ${groupName}`,
        body: await tAsync('notif.groupVoiceActive'),
        sound: prefs.notifSound ? 'call_incoming.mp3' : undefined,
        priority: Notifications.AndroidNotificationPriority.HIGH,
        categoryIdentifier: 'aegislink-groupcall',
        data: { type: 'group_call_channel', groupId, callId, isGroup: true },
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-calls' } : {}),
      },
      trigger: null,
    });
  } catch (err) {
    if (__DEV__) logger.warn('[push] showGroupCallChannelNotification failed:', err);
  }
}

export async function showIncomingCallNotification(
  callerAegisId: string,
  callerName: string,
  isVideo: boolean
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `AegisLink · ${isVideo ? '📹' : '📞'} ${callerName}`,
        body: isVideo ? await tAsync('notif.incomingVideoCall') : await tAsync('notif.incomingVoiceCall'),
        sound: 'call_incoming.mp3',
        priority: Notifications.AndroidNotificationPriority.MAX,
        categoryIdentifier: 'aegislink-call',
        data: { fromAegisId: callerAegisId, type: 'call', isVideo },
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-calls' } : {}),
      },
      trigger: null,
    });
  } catch (err) {
    if (__DEV__) logger.warn('[push] showIncomingCallNotification failed:', err);
  }
}
