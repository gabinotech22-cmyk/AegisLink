/**
 * IncomingGroupCallScreen — unit tests
 *
 * Covers:
 * 1. Renders group name from groupCall store
 * 2. Shows initiator name when contact is found
 * 3. Shows first 8 chars of aegisId when contact is NOT found
 * 4. Accept button calls onAccept and SoundFX.callConnected
 * 5. Decline button calls onReject and SoundFX.callEnded
 * 6. SoundFX.callIncoming is called on mount
 * 7. SoundFX.stopAll is called on unmount
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

// ── react-native-reanimated ────────────────────────────────────────────────
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

// ── SoundFX ────────────────────────────────────────────────────────────────
const mockCallIncoming = jest.fn().mockResolvedValue(undefined);
const mockStopAll = jest.fn().mockResolvedValue(undefined);
const mockCallConnected = jest.fn().mockResolvedValue(undefined);
const mockCallEnded = jest.fn().mockResolvedValue(undefined);

jest.mock('../../hooks/useSoundFX', () => ({
  SoundFX: {
    callIncoming: (...args: unknown[]) => mockCallIncoming(...args),
    stopAll: (...args: unknown[]) => mockStopAll(...args),
    callConnected: (...args: unknown[]) => mockCallConnected(...args),
    callEnded: (...args: unknown[]) => mockCallEnded(...args),
  },
}));

// ── groupCall store ────────────────────────────────────────────────────────
import { useGroupCall } from '../../store/groupCall';

// contacts store — useContacts is a jest.fn() reconfigured per-test
jest.mock('../../store/contacts', () => ({
  useContacts: jest.fn(),
}));
import { useContacts } from '../../store/contacts';

// ── Import after all mocks ─────────────────────────────────────────────────
import { IncomingGroupCallScreen } from '../IncomingGroupCall';

describe('IncomingGroupCallScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    act(() => { useGroupCall.getState().reset(); });
    // Default: empty contacts list
    (useContacts as unknown as jest.Mock).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sel: (s: any) => unknown) => sel({ contacts: [] }),
    );
  });

  afterEach(() => {
    act(() => { useGroupCall.getState().reset(); });
  });

  // ── 1. Renders group name ──────────────────────────────────────────────────

  it('renders the group name from the groupCall store', () => {
    useGroupCall.getState().startIncoming('call-1', 'g-1', 'Operación Nexus', 'abc12345xyz');
    const { getByText } = render(
      <IncomingGroupCallScreen onAccept={jest.fn()} onReject={jest.fn()} />,
    );
    expect(getByText('Operación Nexus')).toBeTruthy();
  });

  // ── 2. Shows initiator name from contacts ──────────────────────────────────

  it('shows the contact display name when the initiator is found in contacts', () => {
    (useContacts as unknown as jest.Mock).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sel: (s: any) => unknown) =>
        sel({ contacts: [{ aegisId: 'user-alpha-001', name: 'Alice Cryptova', color: '#FF0000' }] }),
    );
    useGroupCall.getState().startIncoming('call-2', 'g-2', 'Alpha Team', 'user-alpha-001');

    const { getByText } = render(
      <IncomingGroupCallScreen onAccept={jest.fn()} onReject={jest.fn()} />,
    );
    expect(getByText(/Alice Cryptova/)).toBeTruthy();
  });

  // ── 3. Falls back to aegisId substring when contact not found ──────────────

  it('shows first 8 characters of aegisId when initiator is not in contacts', () => {
    // beforeEach already sets empty contacts
    useGroupCall.getState().startIncoming('call-3', 'g-3', 'Unknown Group', 'zz99xx88yy77aa66');

    const { getByText } = render(
      <IncomingGroupCallScreen onAccept={jest.fn()} onReject={jest.fn()} />,
    );
    // The component renders: "Iniciado por <initiatorName>"
    // initiatorName = aegisId.substring(0, 8) = "zz99xx88"
    expect(getByText(/zz99xx88/)).toBeTruthy();
  });

  // ── 4. Accept button calls onAccept and SoundFX.callConnected ─────────────

  it('pressing ACCEPT calls onAccept and SoundFX.callConnected', () => {
    useGroupCall.getState().startIncoming('call-4', 'g-4', 'Grupo Alpha', 'peer-001');
    const onAccept = jest.fn();
    const onReject = jest.fn();

    const { getByRole } = render(
      <IncomingGroupCallScreen onAccept={onAccept} onReject={onReject} />,
    );

    fireEvent.press(getByRole('button', { name: 'ACCEPT' }));

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(mockCallConnected).toHaveBeenCalledTimes(1);
    expect(mockCallEnded).not.toHaveBeenCalled();
  });

  // ── 5. Decline button calls onReject and SoundFX.callEnded ────────────────

  it('pressing DECLINE calls onReject and SoundFX.callEnded', () => {
    useGroupCall.getState().startIncoming('call-5', 'g-5', 'Grupo Beta', 'peer-002');
    const onAccept = jest.fn();
    const onReject = jest.fn();

    const { getByRole } = render(
      <IncomingGroupCallScreen onAccept={onAccept} onReject={onReject} />,
    );

    fireEvent.press(getByRole('button', { name: 'DECLINE' }));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(mockCallEnded).toHaveBeenCalledTimes(1);
    expect(mockCallConnected).not.toHaveBeenCalled();
  });

  // ── 6. SoundFX.callIncoming called on mount ────────────────────────────────

  it('calls SoundFX.callIncoming on mount', () => {
    useGroupCall.getState().startIncoming('call-6', 'g-6', 'Ring Test', 'peer-003');

    render(<IncomingGroupCallScreen onAccept={jest.fn()} onReject={jest.fn()} />);

    expect(mockCallIncoming).toHaveBeenCalledTimes(1);
  });

  // ── 7. SoundFX.stopAll called on unmount ──────────────────────────────────

  it('calls SoundFX.stopAll on unmount', () => {
    useGroupCall.getState().startIncoming('call-7', 'g-7', 'Stop Test', 'peer-004');

    const { unmount } = render(
      <IncomingGroupCallScreen onAccept={jest.fn()} onReject={jest.fn()} />,
    );

    expect(mockStopAll).not.toHaveBeenCalled();
    unmount();
    expect(mockStopAll).toHaveBeenCalledTimes(1);
  });
});
