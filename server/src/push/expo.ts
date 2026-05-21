import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { pushRepo } from '../db/client.js';

/**
 * Silent push wake-ups. The payload says "wake up, there's something for you"
 * — never the message content. The recipient app opens its socket and drains
 * the offline queue exactly as it would on a normal foreground reconnect.
 *
 * This mirrors Signal's design: FCM/APNs are reachability hints only; the
 * message body is fetched and decrypted on-device via our own relay.
 */

const expo = new Expo();

export async function notifyRecipient(aegisId: string): Promise<void> {
  // NOTE: aegisId is used only to look up push tokens in-process.
  // It is never sent to Expo or included in the push payload.
  const tokens = await pushRepo.forRecipient(aegisId);
  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = [];
  for (const row of tokens) {
    if (!Expo.isExpoPushToken(row.expo_token)) {
      void pushRepo.delete(row.expo_token);
      continue;
    }
    messages.push({
      to: row.expo_token,
      sound: null,
      priority: 'high',
      // Silent / data-only: no body/title means the OS won't show a banner
      // by default. The app's notification handler decides whether to surface
      // anything based on whether a chat is open.
      // Zero-metadata: no aegisId, no message count, no sender — just a wake-up
      // signal. The app reconnects and drains the queue itself.
      data: { kind: 'wakeup' },
      _contentAvailable: true, // iOS background fetch flag
    });
  }

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        if (t.status === 'error') {
          // DeviceNotRegistered means the token is invalid — drop it.
          if ('details' in t && t.details?.error === 'DeviceNotRegistered') {
            void pushRepo.delete(chunk[i].to as string);
          }
          console.warn('[push] ticket error', t.status);
        }
      }
    } catch (e) {
      console.warn('[push] chunk send failed', (e as Error).message);
    }
  }
}
