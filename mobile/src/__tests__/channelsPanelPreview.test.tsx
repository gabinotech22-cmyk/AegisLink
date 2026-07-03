/**
 * ChannelsPanel -- last-post preview regression (#205).
 *
 * Before this fix, every subscribed-channel row always showed the raw
 * `channelType` ('open' | 'readonly' | 'moderated' | 'approval') as its
 * subtitle, even once posts existed. This guards that:
 *  - a channel WITH a decrypted post in `feeds[channelId]` shows the post
 *    body (truncated to one line) + a relative/clock timestamp instead of
 *    the channel type;
 *  - a channel with NO posts yet still falls back to the channel type
 *    subtitle (no blank/broken row).
 *
 * The preview is read straight from the Zustand `feeds` slice, which only
 * ever holds posts that already passed `ingestChannelPosts` (chain-verified +
 * decrypted with the local CEK) -- this test never touches the network or
 * plaintext-at-rest, consistent with the zero-metadata rule.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

jest.mock('../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', textFaint: '#555',
      accent: '#00FF88', accentInk: '#000', danger: '#f43', divider: '#222',
      surface: '#111', surface2: '#222', border: '#333', borderStrong: '#555',
      radius: 12, radiusS: 8, font: 'Inter', fontMono: 'IBMPlexMono', fontDisplay: 'Inter',
    },
  }),
}));

jest.mock('../components/icons', () => ({
  I: {
    ChevronL: () => null, Key: () => null, Search: () => null, Plus: () => null,
    Timer: () => null,
  },
}));

jest.mock('../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../components/ChannelsEmptyVisual', () => ({ ChannelsEmptyVisual: () => null }));
jest.mock('../components/AlertHost', () => ({ themedAlert: jest.fn() }));
jest.mock('../channels/useChannelAvatar', () => ({ useChannelAvatar: () => null }));
jest.mock('../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../store/identity', () => ({ useIdentity: jest.fn() }));
jest.mock('../store/channels', () => ({ useChannels: jest.fn() }));

import { useIdentity } from '../store/identity';
import { useChannels, type ChannelSummary, type FeedPost } from '../store/channels';
import { ChannelsPanel } from '../screens/ChannelsPanel';

function mockChannelsState(overrides: {
  subscribed: ChannelSummary[];
  feeds: Record<string, FeedPost[]>;
}) {
  const state = {
    subscribed: overrides.subscribed,
    feeds: overrides.feeds,
    hydrated: true,
    hydrateSubscribed: jest.fn(async () => {}),
    pendingApplications: [],
    checkApprovals: jest.fn(async () => {}),
    loadFeed: jest.fn(async () => {}),
    joinViaInvite: jest.fn(async () => ({ ok: false })),
  };
  (useChannels as unknown as jest.Mock).mockImplementation(
    (selector: (s: typeof state) => unknown) => selector(state),
  );
}

const CHANNEL_A: ChannelSummary = {
  channelId: 'chan-a',
  name: 'Aegis Notes',
  description: '',
  channelType: 'approval',
  owned: false,
  avatarHash: null,
  channelEd25519PubB64: null,
};

const CHANNEL_B: ChannelSummary = {
  channelId: 'chan-b',
  name: 'No Posts Yet',
  description: '',
  channelType: 'open',
  owned: false,
  avatarHash: null,
  channelEd25519PubB64: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  (useIdentity as unknown as jest.Mock).mockImplementation(
    (selector: (s: { identity: null }) => unknown) => selector({ identity: null }),
  );
});

describe('ChannelsPanel last-post preview (#205)', () => {
  it('shows the decrypted last-post body instead of the channel type when a post exists', () => {
    mockChannelsState({
      subscribed: [CHANNEL_A],
      feeds: {
        'chan-a': [
          { id: 'chan-a:1', from: 'AEGIS-X', body: 'Hello channel members', senderName: null, media: null, ts: Date.now(), seqNum: 1 },
        ],
      },
    });

    render(
      <ChannelsPanel bottomInset={0} onOpenChannel={jest.fn()} onDiscover={jest.fn()} onCreate={jest.fn()} />,
    );

    expect(screen.getByText('Hello channel members')).toBeTruthy();
    expect(screen.queryByText('approval')).toBeNull();
  });

  it('falls back to the channel-type subtitle when no post has been fetched yet', () => {
    mockChannelsState({
      subscribed: [CHANNEL_B],
      feeds: {},
    });

    render(
      <ChannelsPanel bottomInset={0} onOpenChannel={jest.fn()} onDiscover={jest.fn()} onCreate={jest.fn()} />,
    );

    expect(screen.getByText('open')).toBeTruthy();
  });
});
