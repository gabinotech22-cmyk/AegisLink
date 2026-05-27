import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { SERVER_URL } from '../config';
import type { Identity } from '../crypto/identity';

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

// Callback set by App.tsx to handle deep links from notification taps
let _onOpenChat: ((aegisId: string) => void) | null = null;

export function setNotificationOpenChatHandler(fn: (aegisId: string) => void) {
  _onOpenChat = fn;
}

// Show banners for messages that arrive while the app is in background/foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPush(identity: Identity): Promise<{ token: string | null }> {
  if (registered) return { token: null };

  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('aegislink-messages', {
        name: 'Mensajes',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#5bf2b9',
        sound: 'default',
        showBadge: true,
      });
      await Notifications.setNotificationChannelAsync('aegislink-calls', {
        name: 'Llamadas',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 200, 500],
        lightColor: '#5bf2b9',
        sound: 'default',
        bypassDnd: true,
      });
      await Notifications.setNotificationChannelAsync('aegislink-security', {
        name: 'Seguridad',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 100, 100, 100, 100, 100],
        lightColor: '#ff6b6b',
        sound: 'default',
        bypassDnd: true,
      });
    }

    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted || perm.status === 'granted';
    if (!granted && perm.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted || asked.status === 'granted';
    }
    if (!granted) {
      if (__DEV__) console.log('[push] notification permission denied — wake-ups disabled');
      return { token: null };
    }

    const tokenResponse = await Notifications.getExpoPushTokenAsync();
    const expoToken = tokenResponse.data;

    const platform: 'ios' | 'android' | 'unknown' =
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown';

    const res = await fetch(`${SERVER_URL}/push/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: makeSignal(10_000),
      body: JSON.stringify({ aegisId: identity.aegisId, expoToken, platform }),
    });
    if (!res.ok) {
      if (__DEV__) console.warn('[push] server rejected token registration', res.status);
      return { token: null };
    }

    // Handle notification action taps (Reply, Mark read) and default tap to open chat
    Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>;
      const fromAegisId = data?.fromAegisId as string | undefined;
      const actionId = response.actionIdentifier;

      if (actionId === 'REPLY') {
        // User replied from notification — send the text via socket without opening app
        const replyText = (response as { userText?: string }).userText;
        if (replyText && fromAegisId) {
          try {
            const { sendMessage } = require('../socket/client') as { sendMessage: (to: string, text: string) => void };
            sendMessage(fromAegisId, replyText);
            void Notifications.dismissNotificationAsync(response.notification.request.identifier);
          } catch (e) {
            if (__DEV__) console.warn('[push] inline reply failed:', e);
          }
        }
      } else if (actionId === 'MARK_READ') {
        if (fromAegisId) {
          try {
            const { useMessages } = require('../store/messages') as { useMessages: { getState: () => { markRead: (id: string) => Promise<void> } } };
            void useMessages.getState().markRead(fromAegisId);
            void Notifications.dismissNotificationAsync(response.notification.request.identifier);
          } catch (e) {
            if (__DEV__) console.warn('[push] mark-read action failed:', e);
          }
        }
      } else if ((data?.type as string) === 'call_invite') {
        // App was woken by a call push — reconnect socket so the relay can
        // re-deliver call:invite once the authenticated socket is established.
        try {
          const { reconnect } = require('../socket/client') as { reconnect: () => void };
          reconnect();
        } catch { /* socket module not yet loaded — no-op */ }
        // Also surface the incoming call screen if caller info is available
        if (fromAegisId && _onOpenChat) {
          _onOpenChat(fromAegisId);
        }
      } else if (fromAegisId && _onOpenChat) {
        // Default tap — open chat
        _onOpenChat(fromAegisId);
      }
    });

    // Check if app was opened from a notification (cold-start deep link)
    const lastResponse = await Notifications.getLastNotificationResponseAsync();
    if (lastResponse) {
      const data = lastResponse.notification.request.content.data as Record<string, unknown>;
      const fromAegisId = data?.fromAegisId as string | undefined;
      if ((data?.type as string) === 'call_invite') {
        // Cold-start from a call push — reconnect socket first, then navigate
        try {
          const { reconnect } = require('../socket/client') as { reconnect: () => void };
          reconnect();
        } catch { /* socket module not yet loaded — no-op */ }
        if (fromAegisId && _onOpenChat) {
          setTimeout(() => _onOpenChat?.(fromAegisId), 500);
        }
      } else if (fromAegisId && _onOpenChat) {
        setTimeout(() => _onOpenChat?.(fromAegisId), 500);
      }
    }

    registered = true;
    if (__DEV__) console.log('[push] registered for wake-ups, token:', expoToken);

    // Register notification action categories (Reply + Mark as read)
    await Notifications.setNotificationCategoryAsync('aegislink-message', [
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

    await Notifications.setNotificationCategoryAsync('aegislink-call', [
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

    return { token: expoToken };
  } catch (e) {
    if (__DEV__) console.warn('[push] registration failed:', (e as Error).message);
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
 * Surface decrypted E2EE messages as local notifications in strict alignment
 * with AegisLink preference switches (sound, badge, keywords bypass, muted, preview).
 */
export async function showIncomingNotification(
  senderAegisId: string,
  senderName: string,
  body: string,
  isGroup: boolean,
  groupName?: string
) {
  try {
    const { usePreferences } = require('../store/preferences');
    const prefs = usePreferences.getState();

    const targetChatId = isGroup && groupName ? groupName : senderAegisId;
    let isMuted = prefs.mutedChats.includes(targetChatId);

    if (!isMuted) {
      try {
        const { getContact } = require('../db/local');
        const contact = await getContact(senderAegisId);
        if (contact && contact.mutedUntil && contact.mutedUntil > Date.now()) {
          isMuted = true;
        }
      } catch (e) {
        if (__DEV__) console.warn('[push] failed to check database muted_until:', e);
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

    // Avoid displaying alert if the user is already actively looking at the sender's chat
    if (activeChatId === targetChatId) return;

    const showContent = prefs.notifPreview || keywordMatch;
    let title = 'AegisLink';
    let notificationBody = '';

    if (showContent) {
      if (isGroup && groupName) {
        title = `AegisLink · ${groupName}`;
        notificationBody = `${senderName}: ${body} ● E2EE`;
      } else {
        title = `AegisLink · ${senderName}`;
        notificationBody = `${body} ● E2EE`;
      }
    } else {
      if (isGroup && groupName) {
        title = `AegisLink · ${groupName}`;
        notificationBody = `1 nuevo mensaje en grupo ● E2EE`;
      } else {
        notificationBody = `Nuevo mensaje cifrado ● E2EE`;
      }
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: notificationBody,
        sound: prefs.notifSound ? 'default' : undefined,
        categoryIdentifier: 'aegislink-message',
        data: { fromAegisId: senderAegisId, isGroup, groupName },
        // Android notification channel
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-messages' } : {}),
      },
      trigger: null,
    });

    if (prefs.notifBadge) {
      const { useMessages } = require('../store/messages');
      const unreadCounts = useMessages.getState().unreadCounts ?? {};
      const totalUnread = Object.values(unreadCounts).reduce((acc: number, val: any) => acc + (typeof val === 'number' ? val : 0), 0);
      await Notifications.setBadgeCountAsync(totalUnread + 1);
    }
  } catch (err) {
    if (__DEV__) console.warn('[push] showIncomingNotification failed:', err);
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
  let title = 'AegisLink · Seguridad';
  let body = '';

  if (type === 'key_changed') {
    body = `La clave de un contacto cambió. Re-verifica a ${detail ?? 'contacto'} antes de continuar.`;
  } else if (type === 'session_revoked') {
    title = 'AegisLink · Revocado';
    body = 'Sesión cerrada. Este dispositivo ha sido revocado remotamente por otra de tus instancias.';
  } else if (type === 'auto_wipe') {
    title = 'AegisLink · AUTO-WIPE INMINENTE';
    body = '10s para el borrado permanente por demasiados PINs fallidos.';
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
    if (__DEV__) console.warn('[push] showCriticalSecurityNotification failed:', err);
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
        body: isVideo ? 'Videollamada E2EE entrante' : 'Llamada de voz E2EE entrante',
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        categoryIdentifier: 'aegislink-call',
        data: { fromAegisId: callerAegisId, type: 'call', isVideo },
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-calls' } : {}),
      },
      trigger: null,
    });
  } catch (err) {
    if (__DEV__) console.warn('[push] showIncomingCallNotification failed:', err);
  }
}
