/**
 * Local notifications for sealed public channel posts (issue #206).
 *
 * Privacy invariants:
 *  - The notification is built ENTIRELY on-device from the already-decrypted
 *    post body (the relay only ever saw the opaque ciphertext fan-out).
 *  - The per-channel mute state lives in the encrypted local preferences blob
 *    (store/preferences → SecureStore) and NEVER travels to the relay.
 *  - There is no SERVER push for channel posts: the relay does not know who
 *    subscribes to a channel and building a channel→push-token table would be
 *    a metadata leak. Instead the device polls on its OWN schedule via a
 *    background-fetch task (notifications/channelBackgroundSync.ts) that
 *    delta-pulls subscribed channels and calls this function — leak-free,
 *    best-effort catch-up rather than a real-time banner. Live posts still
 *    notify immediately while the socket is up (store/channels attachLive).
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import i18n from '../i18n';
import { logger } from '../utils/logger';
import { previewLabel } from '../utils/messagePreview';
import { usePreferences } from '../store/preferences';
import { getActiveChatNotificationId } from './push';

/** Whether notifications for this channel are muted (local-only preference). */
export function isChannelMuted(channelId: string): boolean {
  return usePreferences.getState().mutedChannels.includes(channelId);
}

/** Flip the local per-channel mute toggle (persisted via the encrypted prefs blob). */
export async function setChannelMuted(channelId: string, muted: boolean): Promise<void> {
  const prefs = usePreferences.getState();
  const current = prefs.mutedChannels;
  const next = muted
    ? (current.includes(channelId) ? current : [...current, channelId])
    : current.filter((id) => id !== channelId);
  if (next === current) return;
  await prefs.set('mutedChannels', next);
}

/**
 * Surface a new (decrypted, chain-verified) channel post as a local
 * notification. Skipped when: master switch off, channel muted, or the user is
 * currently looking at this channel's feed.
 */
export async function showChannelPostNotification(
  channelId: string,
  channelName: string,
  body: string,
): Promise<void> {
  try {
    const prefs = usePreferences.getState();
    if (!prefs.notifMaster) return;
    if (prefs.mutedChannels.includes(channelId)) return;
    // Don't notify for the channel the user is actively viewing.
    if (getActiveChatNotificationId() === channelId) return;

    const showContent = prefs.notifPreview;
    const title = `AegisLink · ${channelName}`;
    const notificationBody = showContent
      ? `${previewLabel(body, i18n.t)} ● E2EE`
      : `${i18n.t('channels.newPostGeneric', 'New post')} ● E2EE`;

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: notificationBody,
        sound: prefs.notifSound ? 'msg_received.mp3' : undefined,
        data: { channelId, isChannel: true },
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-messages' } : {}),
      },
      trigger: null,
    });
  } catch (err) {
    if (__DEV__) logger.warn('[channelNotifications] showChannelPostNotification failed:', err);
  }
}
