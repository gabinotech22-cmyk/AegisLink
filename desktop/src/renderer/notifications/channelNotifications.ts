/**
 * Channel post notifications (desktop). Parity in POLICY with
 * mobile/src/notifications/channelNotifications.ts; the delivery mechanism is
 * the OS notification through the preload bridge instead of expo-notifications.
 *
 * The policy is the part that matters, and it is the same three gates in the
 * same order: master switch off, channel muted, or the feed is already on
 * screen. Getting that wrong on desktop would mean a channel someone muted
 * still popping up on their monitor.
 *
 * Body content follows notifPreview. With preview off the notification says a
 * post arrived and nothing about it — a notification is rendered by the OS,
 * outside our encryption, and can sit on a lock screen in front of anyone.
 */
import { usePreferences } from '../store/preferences';
import { logger } from '../utils/logger';

/** Channel whose feed is currently open, so it does not notify itself. */
let activeChannelId: string | null = null;

/** Called by ChannelFeed on mount/unmount. */
export function setActiveChannel(channelId: string | null): void {
  activeChannelId = channelId;
}

/** Whether notifications for this channel are muted (local-only preference). */
export function isChannelMuted(channelId: string): boolean {
  return usePreferences.getState().mutedChannels.includes(channelId);
}

/** Flip the local per-channel mute toggle (persisted in the encrypted prefs blob). */
export async function setChannelMuted(channelId: string, muted: boolean): Promise<void> {
  const prefs = usePreferences.getState();
  const current = prefs.mutedChannels;
  const next = muted
    ? current.includes(channelId)
      ? current
      : [...current, channelId]
    : current.filter((id) => id !== channelId);
  if (next === current) return;
  await prefs.set('mutedChannels', next);
}

/**
 * Surface a new (decrypted, chain-verified) channel post as an OS notification.
 * Skipped when the master switch is off, the channel is muted, or the user is
 * already looking at this feed.
 */
export async function showChannelPostNotification(
  channelId: string,
  channelName: string,
  _body: string
): Promise<void> {
  try {
    const prefs = usePreferences.getState();
    if (!prefs.notifMaster) return;
    if (prefs.mutedChannels.includes(channelId)) return;
    if (activeChannelId === channelId) return;

    // The post text is deliberately NOT passed through, even when preview is on:
    // the desktop bridge shows a fixed body today (notifications/push.ts does the
    // same for messages), and leaking a channel post to the OS layer would be a
    // worse default than a generic line.
    const title = `AegisLink · ${channelName}`;
    await window.aegis.notifications.show(title, 'New post ● E2EE');
  } catch (err) {
    logger.warn(`[channelNotifications] failed: ${(err as Error).message}`);
  }
}
