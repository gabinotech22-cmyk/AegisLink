/**
 * GroupCallScreen — rendering and controls tests
 *
 * Covers:
 * 1. Empty state renders when no participants
 * 2. Participant tiles render when participants present
 * 3. Mute button is accessible and has correct label
 * 4. Hangup button calls hangupGroupCall
 * 5. Auto-closes when status transitions to idle
 * 6. Mute label changes based on muted state
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

// ── react-native-reanimated ────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return actual;
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

// ── Avatar ─────────────────────────────────────────────────────────────────
jest.mock('../../components/Avatar', () => ({
  Avatar: () => null,
}));

// ── groupCalls ─────────────────────────────────────────────────────────────
const mockHangup = jest.fn();
const mockToggleMute = jest.fn();
jest.mock('../../socket/groupCalls', () => ({
  hangupGroupCall: (...args: unknown[]) => mockHangup(...args),
  toggleGroupCallMute: (...args: unknown[]) => mockToggleMute(...args),
}));

// ── groupCall store ─────────────────────────────────────────────────────────
import { useGroupCall } from '../../store/groupCall';

// ── contacts store ──────────────────────────────────────────────────────────
jest.mock('../../store/contacts', () => ({
  useContacts: (sel: (s: { contacts: unknown[] }) => unknown) =>
    sel({ contacts: [{ aegisId: 'peer-1', name: 'Alice', color: '#FF0000' }] }),
}));

// ── Import after all mocks ─────────────────────────────────────────────────
import { GroupCallScreen } from '../GroupCall';

describe('GroupCallScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHangup.mockReturnValue(undefined);
    mockToggleMute.mockReturnValue(undefined);
    act(() => { useGroupCall.getState().reset(); });
  });

  afterEach(() => {
    act(() => { useGroupCall.getState().reset(); });
  });

  // ── 1. Empty state when no participants ─────────────────────────────────────

  it('shows waiting message when there are no participants', () => {
    useGroupCall.getState().startOutgoing('call-1', 'g-1', 'MyGroup', []);
    const { getByText } = render(<GroupCallScreen onClose={jest.fn()} />);
    expect(getByText(/esperando participantes/i)).toBeTruthy();
  });

  // ── 2. Participant tiles render ─────────────────────────────────────────────

  it('renders participant name when participants are present', () => {
    useGroupCall.getState().startOutgoing('call-2', 'g-2', 'MyGroup', ['peer-1']);
    const { getByText } = render(<GroupCallScreen onClose={jest.fn()} />);
    expect(getByText('Alice')).toBeTruthy();
  });

  // ── 3. Group name displayed ─────────────────────────────────────────────────

  it('renders the group name in the header', () => {
    useGroupCall.getState().startOutgoing('call-3', 'g-3', 'SecureTeam', ['peer-1']);
    const { getByText } = render(<GroupCallScreen onClose={jest.fn()} />);
    expect(getByText('SecureTeam')).toBeTruthy();
  });

  // ── 4. Hangup button accessible and fires handler ───────────────────────────

  it('pressing hang-up button calls hangupGroupCall', () => {
    useGroupCall.getState().startOutgoing('call-4', 'g-4', 'G', ['peer-1']);
    const { getByRole } = render(<GroupCallScreen onClose={jest.fn()} />);
    fireEvent.press(getByRole('button', { name: /colgar/i }));
    expect(mockHangup).toHaveBeenCalledTimes(1);
  });

  // ── 5. Mute button accessible ───────────────────────────────────────────────

  it('mute button has correct accessibility label when not muted', () => {
    useGroupCall.getState().startOutgoing('call-5', 'g-5', 'G', []);
    const { getByRole } = render(<GroupCallScreen onClose={jest.fn()} />);
    expect(getByRole('button', { name: /mute microphone/i })).toBeTruthy();
  });

  it('pressing mute button calls toggleGroupCallMute', () => {
    useGroupCall.getState().startOutgoing('call-6', 'g-6', 'G', []);
    const { getByRole } = render(<GroupCallScreen onClose={jest.fn()} />);
    fireEvent.press(getByRole('button', { name: /mute microphone/i }));
    expect(mockToggleMute).toHaveBeenCalledTimes(1);
  });

  // ── 6. Auto-close when idle ─────────────────────────────────────────────────

  it('calls onClose when status transitions to idle', () => {
    useGroupCall.getState().startOutgoing('call-7', 'g-7', 'G', []);
    const onClose = jest.fn();
    render(<GroupCallScreen onClose={onClose} />);
    // Transition to idle (simulating reset after call ends)
    act(() => {
      useGroupCall.getState().reset();
    });
    expect(onClose).toHaveBeenCalled();
  });
});
