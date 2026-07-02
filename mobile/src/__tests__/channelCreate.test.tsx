/**
 * ChannelCreateScreen -- create-channel feedback regressions.
 *
 * Guards against the prod incident (2026-07-02) where ~10 duplicate "testers"
 * channels appeared in the public directory:
 *  - a fast double-tap fired handleCreate twice before `busy` re-rendered
 *    (the ref guard must make the second call a no-op);
 *  - a thrown error inside createChannel was an unhandled rejection -- no
 *    alert, no navigation -- so users re-tapped and created duplicates.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

// ---- Mocks -----------------------------------------------------------------

jest.mock('../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../components/AlertHost';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

jest.mock('../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', textFaint: '#555',
      accent: '#00FF88', accentInk: '#000', danger: '#f43',
      surface: '#111', surface2: '#222', border: '#333', borderStrong: '#555',
      radius: 12, radiusS: 8, font: 'Inter', fontMono: 'IBMPlexMono',
    },
  }),
}));

jest.mock('../components/icons', () => ({
  I: { ChevronL: () => null, Plus: () => null, Video: () => null, Trash: () => null, Lock: () => null },
}));

jest.mock('../components/TopBar', () => ({
  TopBar: ({ title, left }: { title: string; left?: React.ReactNode }) => {
    const { View, Text } = require('react-native');
    return (
      <View>
        {left}
        <Text>{title}</Text>
      </View>
    );
  },
}));

jest.mock('../components/AvatarCropModal', () => ({ AvatarCropModal: () => null }));
jest.mock('../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../components/ShareLinkSheet', () => ({
  ShareLinkSheet: ({ visible }: { visible: boolean }) => {
    const { Text } = require('react-native');
    return visible ? <Text>SHARE_SHEET</Text> : null;
  },
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('../utils/pickingGuard', () => ({ withPickingGuard: jest.fn((fn: () => unknown) => fn()) }));
jest.mock('../channels/channelAvatarCache', () => ({ hashLocalFile: jest.fn() }));

const mockCreateChannel = jest.fn();
jest.mock('../store/channels', () => ({
  useChannels: (sel: (s: { createChannel: jest.Mock }) => unknown) => sel({ createChannel: mockCreateChannel }),
}));
jest.mock('../store/identity', () => ({
  useIdentity: (sel: (s: { identity: { aegisId: string } }) => unknown) => sel({ identity: { aegisId: 'AEGIS-ME' } }),
}));

// ---- Imports (after mocks) ---------------------------------------------------

import { ChannelCreateScreen } from '../screens/ChannelCreate';

function renderWithName(name = 'testers') {
  const utils = render(<ChannelCreateScreen onBack={jest.fn()} onCreated={jest.fn()} />);
  fireEvent.changeText(utils.getByPlaceholderText('channels.namePlaceholder'), name);
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ChannelCreateScreen -- double-tap guard', () => {
  it('a double-tap before re-render creates the channel only once', async () => {
    let resolve!: (v: unknown) => void;
    mockCreateChannel.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { getByText } = renderWithName();
    const btn = getByText('channels.create');

    // Both presses land inside one act() batch -- `busy` hasn't re-rendered
    // yet, exactly like two physical taps in the same frame.
    await act(async () => {
      fireEvent.press(btn);
      fireEvent.press(btn);
    });
    expect(mockCreateChannel).toHaveBeenCalledTimes(1);

    await act(async () => { resolve({ ok: true, channelId: 'c1', invite: 'aegislink://x' }); });
  });

  it('shows the share sheet (success feedback) when creation succeeds', async () => {
    mockCreateChannel.mockResolvedValue({ ok: true, channelId: 'c1', invite: 'aegislink://x' });
    const { getByText } = renderWithName();
    fireEvent.press(getByText('channels.create'));
    await waitFor(() => expect(getByText('SHARE_SHEET')).toBeTruthy());
  });
});

describe('ChannelCreateScreen -- failure feedback', () => {
  it('a thrown error surfaces as an alert instead of a silent unhandled rejection', async () => {
    mockCreateChannel.mockRejectedValue(new Error('secure_store_unavailable'));
    const { getByText } = renderWithName();
    fireEvent.press(getByText('channels.create'));
    await waitFor(() =>
      expect(themedAlert).toHaveBeenCalledWith('channels.createFailed', 'secure_store_unavailable'),
    );
  });

  it('maps the duplicate_name guard to a translated message', async () => {
    mockCreateChannel.mockResolvedValue({ ok: false, error: 'duplicate_name' });
    const { getByText } = renderWithName();
    fireEvent.press(getByText('channels.create'));
    await waitFor(() =>
      expect(themedAlert).toHaveBeenCalledWith('channels.createFailed', 'channels.duplicateName'),
    );
  });

  it('re-enables creation after a failure (retry is possible)', async () => {
    mockCreateChannel.mockResolvedValueOnce({ ok: false, error: 'register_failed' });
    mockCreateChannel.mockResolvedValueOnce({ ok: true, channelId: 'c2', invite: 'aegislink://y' });
    const { getByText } = renderWithName();

    fireEvent.press(getByText('channels.create'));
    await waitFor(() => expect(themedAlert).toHaveBeenCalled());

    fireEvent.press(getByText('channels.create'));
    await waitFor(() => expect(getByText('SHARE_SHEET')).toBeTruthy());
    expect(mockCreateChannel).toHaveBeenCalledTimes(2);
  });
});
