/**
 * GroupChatScreen — voice note and group call path tests
 *
 * Covers:
 * 1. Mic button is visible when draft is empty and no staged image
 * 2. Phone button renders in the header with correct accessibility label
 * 3. Phone button shows Alert (not startGroupCall) when group has 0 other members
 * 4. Phone button calls startGroupCall when group has valid other members
 * 5. handleVoiceSend calls encryptAndUploadMedia and sendGroupMessage with correct args
 * 6. handleVoiceSend appends message with type='audio'
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ── react-native-reanimated ────────────────────────────────────────────────
// Manual mock — requireActual('react-native-reanimated/mock') initialises native
// Worklets which is unavailable in the Jest node environment.
jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: RN.View },
    View: RN.View,
    useSharedValue: jest.fn((v: unknown) => ({ value: v })),
    useAnimatedStyle: jest.fn((fn: () => unknown) => fn()),
    withTiming: jest.fn((v: unknown) => v),
    withRepeat: jest.fn((v: unknown) => v),
    withSequence: jest.fn((...args: unknown[]) => args[0]),
    withSpring: jest.fn((v: unknown) => v),
    useReducedMotion: jest.fn(() => false),
    Easing: {
      inOut: jest.fn(() => (x: number) => x),
      ease: jest.fn((x: number) => x),
    },
    Animated: { View: RN.View },
  };
});

// ── react-i18next ──────────────────────────────────────────────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

// ── ThemeContext ───────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000',
      surface: '#111',
      surface2: '#222',
      surface3: '#333',
      text: '#fff',
      textDim: '#aaa',
      textFaint: '#555',
      accent: '#00FF88',
      accentDeep: '#00cc66',
      accentInk: '#000',
      danger: '#e63946',
      warn: '#f59e0b',
      border: '#333',
      borderStrong: '#555',
      divider: '#333',
      bubbleIn: '#222',
      bubbleInText: '#fff',
      bubbleOut: '#00FF88',
      bubbleOutText: '#000',
      radius: 14,
      radiusS: 8,
      radiusL: 22,
      font: 'System',
      fontMono: 'monospace',
      fontDisplay: 'System',
      dark: true,
    },
  }),
}));

// ── react-native-safe-area-context ─────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── icons ──────────────────────────────────────────────────────────────────
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── react-native-gesture-handler (incl. modern Gesture builder API) ──────────
jest.mock('react-native-gesture-handler', () => {
  const chain = () => {
    const g: Record<string, () => unknown> = {};
    ['enabled', 'minDistance', 'onStart', 'onUpdate', 'onEnd', 'onChange', 'runOnJS',
      'onBegin', 'onFinalize', 'hitSlop', 'simultaneousWithExternalGesture',
      'requireExternalGestureToFail'].forEach((m) => { g[m] = () => g; });
    return g;
  };
  const P = (props: { children?: React.ReactNode }) => (props && props.children != null ? props.children : null);
  return {
    __esModule: true,
    Gesture: { Pan: chain, Pinch: chain, Tap: chain, Simultaneous: () => chain(), Race: () => chain(), Exclusive: () => chain() },
    GestureDetector: P, GestureHandlerRootView: P, Swipeable: P, DrawerLayout: P,
    PanGestureHandler: P, TapGestureHandler: P, LongPressGestureHandler: P,
    RectButton: P, BorderlessButton: P, BaseButton: P,
    State: {}, Directions: {}, gestureHandlerRootHOC: (c: unknown) => c,
  };
});

// ── react-native-svg ───────────────────────────────────────────────────────
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Path: 'Path',
  Svg: 'Svg',
}));

// ── Avatar ─────────────────────────────────────────────────────────────────
jest.mock('../../components/Avatar', () => ({
  Avatar: () => null,
}));

// ── SwipeableMessage ───────────────────────────────────────────────────────
jest.mock('../../components/SwipeableMessage', () => ({
  SwipeableMessage: ({ children }: { children: React.ReactNode }) => children,
}));

// ── FormattedText ──────────────────────────────────────────────────────────
jest.mock('../../components/FormattedText', () => ({
  FormattedText: ({ text }: { text: string }) => {
    // Use require() inside factory — React is not accessible in jest.mock scope
    const { createElement } = require('react') as typeof import('react');
    const { Text } = require('react-native') as typeof import('react-native');
    return createElement(Text, null, text);
  },
}));

// ── AudioWaveform ──────────────────────────────────────────────────────────
jest.mock('../../components/AudioWaveform', () => ({
  AudioWaveform: () => null,
}));

// ── LinkPreview ────────────────────────────────────────────────────────────
jest.mock('../../components/LinkPreview', () => ({
  LinkPreview: () => null,
}));

// ── GifPicker ─────────────────────────────────────────────────────────────
jest.mock('../../components/GifPicker', () => ({
  GifPicker: () => null,
}));

// ── ForwardModal ───────────────────────────────────────────────────────────
jest.mock('../../components/ForwardModal', () => ({
  ForwardModal: () => null,
}));

// ── ImageViewerModal ───────────────────────────────────────────────────────
jest.mock('../../components/ImageViewerModal', () => ({
  ImageViewerModal: () => null,
}));

// ── MessageActionsSheet ────────────────────────────────────────────────────
jest.mock('../../components/MessageActionsSheet', () => ({
  MessageActionsSheet: () => null,
}));

// ── VoiceRecorderScreen ────────────────────────────────────────────────────
// Renders a minimal stand-in that exposes the onSend prop so tests can invoke it
const mockVoiceOnSend = jest.fn();
jest.mock('../VoiceRecorder', () => ({
  VoiceRecorderScreen: ({
    onSend,
    onBack,
  }: {
    onSend: (uri: string, ms: number) => void;
    onBack: () => void;
  }) => {
    mockVoiceOnSend.mockImplementation(onSend);
    // Use require() — React and named imports are not in jest.mock() scope
    const { createElement } = require('react') as typeof import('react');
    const { View, Pressable, Text } = require('react-native') as typeof import('react-native');
    return createElement(
      View,
      null,
      createElement(
        Pressable,
        {
          accessibilityLabel: 'Send voice',
          onPress: () => onSend('file:///voice.m4a', 5000),
        },
        createElement(Text, null, 'Send voice'),
      ),
      createElement(
        Pressable,
        { accessibilityLabel: 'Back from voice', onPress: onBack },
        createElement(Text, null, 'Back'),
      ),
    );
  },
}));

// ── SoundFX ────────────────────────────────────────────────────────────────
jest.mock('../../hooks/useSoundFX', () => ({
  SoundFX: {
    msgReceived: jest.fn().mockResolvedValue(undefined),
    msgSent: jest.fn().mockResolvedValue(undefined),
    callIncoming: jest.fn().mockResolvedValue(undefined),
    stopAll: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── notifications/push (required inline in loadChat effect) ───────────────
jest.mock('../../notifications/push', () => ({
  setActiveChatNotificationId: jest.fn(),
}));

// ── expo-image-manipulator ─────────────────────────────────────────────────
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: 'file:///compressed.jpg' }),
  SaveFormat: { JPEG: 'jpeg' },
}));

// ── expo-crypto ────────────────────────────────────────────────────────────
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn().mockReturnValue('test-uuid-0000'),
}));

// ── crypto/media ──────────────────────────────────────────────────────────
const mockEncryptAndUploadMedia = jest.fn().mockResolvedValue('blob://encrypted-uri');
jest.mock('../../crypto/media', () => ({
  encryptAndUploadMedia: (...args: unknown[]) => mockEncryptAndUploadMedia(...args),
}));

// ── socket/groupCalls ──────────────────────────────────────────────────────
const mockStartGroupCall = jest.fn().mockResolvedValue(undefined);
jest.mock('../../socket/groupCalls', () => ({
  startGroupCall: (...args: unknown[]) => mockStartGroupCall(...args),
}));

// ── socket/client ──────────────────────────────────────────────────────────
const mockSendGroupMessage = jest.fn().mockResolvedValue(undefined);
const mockSendGroupVote = jest.fn().mockResolvedValue(undefined);
jest.mock('../../socket/client', () => ({
  sendGroupMessage: (...args: unknown[]) => mockSendGroupMessage(...args),
  sendGroupVote: (...args: unknown[]) => mockSendGroupVote(...args),
}));

// ── stores ─────────────────────────────────────────────────────────────────

const mockIdentity = {
  aegisId: 'self-aegis-id',
  publicKeyB64: 'pubkey',
  secretKey: new Uint8Array(32),
};

jest.mock('../../store/identity', () => ({
  useIdentity: () => ({ identity: mockIdentity }),
}));

const mockAppendMsg = jest.fn().mockResolvedValue(undefined);
const mockLoadChat = jest.fn().mockResolvedValue(undefined);
const mockMarkRead = jest.fn().mockResolvedValue(undefined);
const mockToggleStar = jest.fn().mockResolvedValue(undefined);
const mockSoftDelete = jest.fn().mockResolvedValue(undefined);
const mockToggleReaction = jest.fn().mockResolvedValue(undefined);
let mockPendingMediaUri: string | null = null;
const mockSetPendingMedia = jest.fn();

jest.mock('../../store/messages', () => ({
  useMessages: (sel: (s: unknown) => unknown) =>
    sel({
      byChat: {},
      loadChat: mockLoadChat,
      markRead: mockMarkRead,
      toggleStar: mockToggleStar,
      softDelete: mockSoftDelete,
      toggleReaction: mockToggleReaction,
      append: mockAppendMsg,
      pendingMediaUri: mockPendingMediaUri,
      setPendingMedia: mockSetPendingMedia,
    }),
}));

jest.mock('../../store/contacts', () => ({
  useContacts: (sel: (s: { contacts: unknown[]; hydrate: () => Promise<void> }) => unknown) =>
    sel({ contacts: [], hydrate: jest.fn().mockResolvedValue(undefined) }),
}));

jest.mock('../../store/connection', () => ({
  useConnection: (sel: (s: { online: boolean }) => unknown) => sel({ online: true }),
}));

jest.mock('../../store/polls', () => ({
  usePollsStore: (sel: (s: unknown) => unknown) =>
    sel({
      results: {},
      castVote: jest.fn(),
      hydrate: jest.fn().mockResolvedValue(undefined),
    }),
}));

jest.mock('../../db/local', () => ({}));

// ── groups store ───────────────────────────────────────────────────────────
// Configurable per-test
let mockGroupMembers: string[] = ['self-aegis-id', 'peer-001', 'peer-002'];

jest.mock('../../store/groups', () => ({
  useGroups: (sel: (s: { groups: unknown[] }) => unknown) => {
    return sel({
      groups: [
        {
          id: 'g-test-1',
          name: 'Test Group',
          members: mockGroupMembers,
          createdAt: 1_000_000,
          avatarColor: '#00FF88',
          // Caller is owner → passes the admin-only call gate (can(call)).
          adminId: 'self-aegis-id',
        },
      ],
    });
  },
}));

// ── parseLocationMessage ───────────────────────────────────────────────────
jest.mock('../../utils/parseLocationMessage', () => ({
  parseLocationMessage: jest.fn().mockReturnValue(null),
}));

// ── Import after all mocks ─────────────────────────────────────────────────
import { GroupChatScreen } from '../GroupChat';
import type { StoredGroup } from '../../db/local';

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeGroup(overrides: Partial<StoredGroup> = {}): StoredGroup {
  return {
    id: 'g-test-1',
    name: 'Test Group',
    members: ['self-aegis-id', 'peer-001', 'peer-002'],
    createdAt: 1_000_000,
    avatarColor: '#00FF88',
    // Caller is the owner so the admin-only call gate (can(call)) permits the
    // call in these tests. Override adminId to exercise the blocked path.
    adminId: 'self-aegis-id',
    ...overrides,
  };
}

function renderGroupChat(group = makeGroup()) {
  return render(
    <GroupChatScreen
      group={group}
      onBack={jest.fn()}
      onGroupDetail={jest.fn()}
      onPoll={jest.fn()}
      onAttach={jest.fn()}
      onGroupCall={jest.fn()}
    />,
  );
}

describe('GroupChatScreen — voice note and group call paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPendingMediaUri = null;
    mockGroupMembers = ['self-aegis-id', 'peer-001', 'peer-002'];
  });

  // ── 1. Mic button visible when draft is empty ──────────────────────────────

  it('shows the "Record voice note" button when draft is empty and no staged image', () => {
    // The mic Pressable sets accessibilityLabel but not accessibilityRole="button",
    // so we query by label rather than role.
    const { getByLabelText } = renderGroupChat();
    expect(getByLabelText(/record voice note/i)).toBeTruthy();
  });

  // ── 2. Phone button renders in header ─────────────────────────────────────

  it('renders a "Start group call" button in the header', () => {
    const { getByLabelText } = renderGroupChat();
    expect(getByLabelText(/start group call/i)).toBeTruthy();
  });

  // ── 3. Phone button shows Alert when group has 0 other members ────────────

  it('shows an Alert and does not call startGroupCall when group has no other members', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    mockGroupMembers = ['self-aegis-id'];
    const group = makeGroup({ members: ['self-aegis-id'] });
    const { getByLabelText } = renderGroupChat(group);

    await act(async () => {
      fireEvent.press(getByLabelText(/start group call/i));
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockStartGroupCall).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  // ── 4. Phone button calls startGroupCall with valid members ───────────────

  it('calls startGroupCall when the group has valid other members', async () => {
    mockGroupMembers = ['self-aegis-id', 'peer-001', 'peer-002'];
    const group = makeGroup({ members: ['self-aegis-id', 'peer-001', 'peer-002'] });
    const { getByLabelText } = renderGroupChat(group);

    await act(async () => {
      fireEvent.press(getByLabelText(/start group call/i));
    });

    await waitFor(() => {
      expect(mockStartGroupCall).toHaveBeenCalledTimes(1);
    });

    const [calledIdentity, calledGroup, calledOtherMembers] = mockStartGroupCall.mock.calls[0] as [
      typeof mockIdentity,
      StoredGroup,
      string[],
    ];
    expect(calledIdentity.aegisId).toBe('self-aegis-id');
    expect(calledGroup.id).toBe('g-test-1');
    expect(calledOtherMembers).toEqual(expect.arrayContaining(['peer-001', 'peer-002']));
    expect(calledOtherMembers).not.toContain('self-aegis-id');
  });

  // ── 5. handleVoiceSend calls encryptAndUploadMedia and sendGroupMessage ───

  it('handleVoiceSend calls encryptAndUploadMedia and sendGroupMessage with correct args', async () => {
    const { getByLabelText } = renderGroupChat();

    // Open the voice recorder modal first
    await act(async () => {
      fireEvent.press(getByLabelText(/record voice note/i));
    });

    // Trigger the send via the mock VoiceRecorderScreen.
    // The mock renders a Pressable with accessibilityLabel="Send voice".
    await act(async () => {
      fireEvent.press(getByLabelText(/send voice/i));
    });

    await waitFor(() => {
      expect(mockEncryptAndUploadMedia).toHaveBeenCalledWith('file:///voice.m4a', 'audio/m4a');
    });

    await waitFor(() => {
      expect(mockSendGroupMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: mockIdentity,
          groupId: 'g-test-1',
          plaintext: '[audio:5s]',
          msgType: 'audio',
          mediaUri: 'blob://encrypted-uri',
          skipLocalAppend: true,
        }),
      );
    });
  });

  // ── 6. handleVoiceSend appends message with type='audio' ──────────────────

  it('handleVoiceSend appends a message with type "audio"', async () => {
    const { getByLabelText } = renderGroupChat();

    await act(async () => {
      fireEvent.press(getByLabelText(/record voice note/i));
    });

    await act(async () => {
      fireEvent.press(getByLabelText(/send voice/i));
    });

    await waitFor(() => {
      expect(mockAppendMsg).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audio',
          chatId: 'g-test-1',
          direction: 'out',
          mediaUri: 'file:///voice.m4a',
        }),
      );
    });
  });
});
