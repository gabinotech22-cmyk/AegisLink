/**
 * Channel post notifications + per-channel mute (issue #206).
 *
 * The visible notification is built LOCALLY from the already-decrypted post;
 * the mute list is a device-local preference. These tests pin the gating:
 * muted channel → silent; unmuted → notify; focused feed → silent; master
 * switch off → silent. Also covers the mute toggle helper itself.
 */

// expo-notifications runs setNotificationHandler at module load (via ../push) —
// stub the surface both modules touch.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'notif-id'),
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidNotificationPriority: { HIGH: 'high', MAX: 'max' },
}));
jest.mock('../../config', () => ({ SERVER_URL: 'https://example.test' }));
// Preferences persist through SecureStore — keep it in-memory for the test.
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  },
}));

import * as Notifications from 'expo-notifications';
import {
  showChannelPostNotification,
  setChannelMuted,
  isChannelMuted,
} from '../channelNotifications';
import { setActiveChatNotificationId } from '../push';
import { usePreferences } from '../../store/preferences';

const CHANNEL_ID = 'chan_abc123';
const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

describe('showChannelPostNotification', () => {
  beforeEach(() => {
    scheduleMock.mockClear();
    setActiveChatNotificationId(null);
    usePreferences.setState({ notifMaster: true, notifPreview: true, mutedChannels: [] });
  });

  it('notifies for a new post in an unmuted channel (title = channel name)', async () => {
    await showChannelPostNotification(CHANNEL_ID, 'Ops Updates', 'deploy at noon');

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const arg = scheduleMock.mock.calls[0][0] as {
      content: { title: string; body: string; data: Record<string, unknown> };
    };
    expect(arg.content.title).toBe('AegisLink · Ops Updates');
    expect(arg.content.body).toContain('deploy at noon');
    expect(arg.content.data).toEqual({ channelId: CHANNEL_ID, isChannel: true });
  });

  it('does NOT notify when the channel is muted', async () => {
    usePreferences.setState({ mutedChannels: [CHANNEL_ID] });

    await showChannelPostNotification(CHANNEL_ID, 'Ops Updates', 'deploy at noon');

    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('does NOT notify while the user is looking at that channel feed', async () => {
    setActiveChatNotificationId(CHANNEL_ID);

    await showChannelPostNotification(CHANNEL_ID, 'Ops Updates', 'deploy at noon');

    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('does NOT notify when the master notification switch is off', async () => {
    usePreferences.setState({ notifMaster: false });

    await showChannelPostNotification(CHANNEL_ID, 'Ops Updates', 'deploy at noon');

    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('hides the post body when notifPreview is off', async () => {
    usePreferences.setState({ notifPreview: false });

    await showChannelPostNotification(CHANNEL_ID, 'Ops Updates', 'secret contents');

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const arg = scheduleMock.mock.calls[0][0] as { content: { body: string } };
    expect(arg.content.body).not.toContain('secret contents');
  });
});

describe('setChannelMuted / isChannelMuted', () => {
  beforeEach(() => {
    usePreferences.setState({ mutedChannels: [] });
  });

  it('adds and removes the channel from the local mute list (idempotent)', async () => {
    expect(isChannelMuted(CHANNEL_ID)).toBe(false);

    await setChannelMuted(CHANNEL_ID, true);
    expect(isChannelMuted(CHANNEL_ID)).toBe(true);
    await setChannelMuted(CHANNEL_ID, true); // no duplicate
    expect(usePreferences.getState().mutedChannels).toEqual([CHANNEL_ID]);

    await setChannelMuted(CHANNEL_ID, false);
    expect(isChannelMuted(CHANNEL_ID)).toBe(false);
    expect(usePreferences.getState().mutedChannels).toEqual([]);
  });
});
