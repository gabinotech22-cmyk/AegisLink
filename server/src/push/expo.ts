import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { pushRepo } from '../db/client.js';
import { sendVoipWakeUp } from './apns-voip.js';

export type CallMedia = 'audio' | 'video';

/**
 * Silent push wake-ups. The payload says "wake up, there's something for you"
 * — never the message content. The recipient app opens its socket and drains
 * the offline queue exactly as it would on a normal foreground reconnect.
 *
 * This mirrors Signal's design: FCM/APNs are reachability hints only; the
 * message body is fetched and decrypted on-device via our own relay.
 */
// Parameters kept for call-site compatibility but fromAegisId/media/callId
// are intentionally not forwarded to the push provider — blind wake-up only.

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
    // iOS and Android differ on ONE field — `_contentAvailable` — and it is the
    // difference between "the banner always shows" and "the banner silently never
    // shows" (audit 2026-07-26). On iOS, pairing content-available with a visible
    // alert makes the OS classify the push as a BACKGROUND notification subject to
    // the background-refresh budget; under normal message volume iOS throttles it
    // and the visible alert vanishes with it — a force-quit app then gets NO
    // notification at all. Reproduced on-device: the identical payload WITHOUT the
    // flag always displays; calls stayed reliable only because they are rare and
    // never exhaust the budget. A plain high-priority alert is never throttled.
    // Android KEEPS the flag: its headless background-reconnect task relies on the
    // background-fetch wake to drain the queue, and FCM high-priority data messages
    // are not throttled this way.
    const isIos = row.platform === 'ios';
    messages.push({
      to: row.expo_token,
      // Visible push: generic title + body so the OS shows a banner even when the
      // app cannot be woken for background execution (Doze mode, battery
      // optimization). Zero-metadata — no sender, no count, no content. The app,
      // while it is alive, replaces this with a richer local notification via
      // showIncomingNotification().
      sound: 'default',
      priority: 'high',
      title: 'AegisLink',
      body: 'Nuevo mensaje cifrado · E2EE',
      data: { kind: 'wakeup' },
      // iOS: omit content-available so the alert is GUARANTEED to display.
      // Android: keep it as the background-fetch wake for the reconnect task.
      ...(isIos ? {} : { _contentAvailable: true }),
      channelId: 'aegislink-messages', // Android notification channel (ignored on iOS)
    });
  }

  await sendChunked(messages);
}

/**
 * High-priority wake-up push for an incoming call.
 *
 * Visible heads-up wake-up: when the app is fully killed the JS runtime cannot
 * run to post a local notification, so the OS itself must ring and display the
 * incoming call. We send a generic, ZERO-METADATA visible push — no caller
 * identity, no media type — just enough for the OS to ring with Accept/Decline.
 * The caller's identity stays sealed inside the call:invite socket event and is
 * only surfaced (showIncomingCallNotification) once the app wakes and reconnects.
 * TTL is 30 seconds — stale calls are never delivered by the OS.
 */
/**
 * Returns `true` if at least one valid push token was found and the wake-up
 * was dispatched; `false` if the recipient has no registered tokens (or all
 * tokens were invalid/pruned). The caller uses this to decide whether the
 * callee is reachable via push, or truly unreachable and should be told
 * peer_offline immediately.
 */
export async function sendCallWakeUp(
  toAegisId: string,
  _fromAegisId: string,
  media: CallMedia,
  callId: string,
): Promise<boolean> {
  // iOS PushKit path first: a VoIP push is the only thing that reliably rings a
  // fully-killed iOS app. fromAegisId is NEVER forwarded — the callId is a
  // random UUID that reveals nothing.
  const voipSent = await sendVoipWakeUp(toAegisId, callId, media);

  const tokens = await pushRepo.forRecipient(toAegisId);
  if (tokens.length === 0) return voipSent;

  // Only suppress the redundant iOS Expo heads-up (avoids a double ring with
  // CallKit) when the account has exactly ONE iOS device. sendVoipWakeUp only
  // reports a per-recipient success and push_tokens carries no device id, so if
  // there are multiple iOS devices we cannot tell which one actually got the
  // VoIP push — suppressing all of them could starve a device (a stale VoIP
  // token on one device would drop CallKit AND Expo on the others). In that
  // case we keep the Expo fallback for every iOS device (correctness over the
  // minor double-ring on the one that also got VoIP).
  const iosExpoCount = tokens.filter((r) => r.platform === 'ios').length;
  const suppressIosExpo = voipSent && iosExpoCount === 1;

  const messages: ExpoPushMessage[] = [];
  for (const row of tokens) {
    if (!Expo.isExpoPushToken(row.expo_token)) {
      void pushRepo.delete(row.expo_token);
      continue;
    }
    // Skip the single iOS Expo token when a VoIP push already went out — CallKit rings.
    if (suppressIosExpo && row.platform === 'ios') continue;
    messages.push({
      to: row.expo_token,
      sound: 'default',
      priority: 'high',
      _contentAvailable: true,
      ttl: 30,
      // Generic, zero-metadata title/body so the OS rings + shows a heads-up
      // even when the app is killed. Caller identity stays sealed in call:invite.
      title: 'AegisLink',
      body: 'Llamada entrante · E2EE',
      data: { kind: 'call_wakeup' },
      categoryId: 'aegislink-call',  // Contestar / Rechazar actions on the heads-up
      channelId: 'aegislink-calls',  // MAX importance + bypassDnd (created client-side)
    });
  }

  if (messages.length === 0) return voipSent;
  await sendChunked(messages);
  return true;
}

/**
 * Wake-up push for an active group voice channel (Discord-style, no ring).
 *
 * Zero-metadata, exactly like sendCallWakeUp: a generic visible heads-up so the
 * OS can wake the (possibly killed) app. No group name, no callId, no roster —
 * those stay sealed in the `group_call:channel` heartbeat, which the app
 * re-receives within one heartbeat interval after it reconnects, and only then
 * surfaces the rich local "Unirse / Descartar" notification.
 *
 * Returns true if at least one wake-up was dispatched.
 */
export async function sendGroupCallWakeUp(toAegisId: string): Promise<boolean> {
  const tokens = await pushRepo.forRecipient(toAegisId);
  if (tokens.length === 0) return false;

  const messages: ExpoPushMessage[] = [];
  for (const row of tokens) {
    if (!Expo.isExpoPushToken(row.expo_token)) {
      void pushRepo.delete(row.expo_token);
      continue;
    }
    messages.push({
      to: row.expo_token,
      sound: 'default',
      priority: 'high',
      _contentAvailable: true,
      ttl: 30,
      title: 'AegisLink',
      body: 'Canal de voz activo · E2EE',
      data: { kind: 'call_wakeup' },
      channelId: 'aegislink-calls',
    });
  }

  if (messages.length === 0) return false;
  await sendChunked(messages);
  return true;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function sendChunked(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;
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
          if (isDev) console.warn('[push] ticket error', t.status);
        }
      }
    } catch (e) {
      if (isDev) console.warn('[push] chunk send failed', (e as Error).message);
    }
  }
}

// Allow __DEV__ guard in Node — true when NODE_ENV !== 'production'
const isDev = process.env['NODE_ENV'] !== 'production';
