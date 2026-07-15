/**
 * IncomingCallScreen — auto-accept/decline from a notification action.
 *
 * Field bug: pressing "Contestar" on the incoming-call notification only opened
 * the full-screen ring UI; the call never connected until the user pressed the
 * on-screen Accept button too. Root cause: acceptCall() (mic + foreground
 * microphone service) was being run straight from the notification handler while
 * the app was still in the background, where it connects unreliably.
 *
 * Fix: the notification handler only records a `pendingAction` intent;
 * IncomingCallScreen — which mounts only once the app is foregrounded — consumes
 * it and fires onAccept/onReject there, exactly where the manual button works.
 * These tests lock in that consumption.
 */
import React from 'react';
import { render } from '@testing-library/react-native';

// ── reanimated (worklet APIs stubbed to plain values) ──────────────────────
jest.mock('react-native-reanimated', () => {
  const View = 'Animated.View';
  return {
    __esModule: true,
    default: { View },
    View,
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withRepeat: (v: unknown) => v,
    withSequence: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    useReducedMotion: () => true,
    Easing: { inOut: () => (x: number) => x, ease: (x: number) => x },
  };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({ t: {
    bg: '#000', text: '#fff', textDim: '#aaa', accent: '#0f8', accentInk: '#000',
    danger: '#e33', surface: '#111', surface2: '#222', surface3: '#333',
    border: '#333', radius: 8, radiusL: 12, font: 'F', fontMono: 'M', fontDisplay: 'D',
  } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));

jest.mock('../../hooks/useSoundFX', () => ({
  SoundFX: { callIncoming: jest.fn(), callConnected: jest.fn(), callEnded: jest.fn(), stopAll: jest.fn() },
}));

const mockDismiss = jest.fn();
jest.mock('../../notifications/push', () => ({ dismissIncomingCallNotification: (...a: unknown[]) => mockDismiss(...a) }));

jest.mock('../../socket/client', () => ({ sendMessage: jest.fn() }));
jest.mock('tweetnacl-util', () => ({ decodeBase64: () => new Uint8Array(32) }));

jest.mock('../../store/contacts', () => ({
  useContacts: (sel: (s: object) => unknown) => sel({ get: () => ({ name: 'Alice', publicKeyB64: 'pk', aegisId: 'caller-1' }) }),
}));
jest.mock('../../store/identity', () => ({
  useIdentity: () => ({ identity: { aegisId: 'me' } }),
}));

// Mutable call state so each test can pick the pendingAction it exercises.
const mockSetPendingAction = jest.fn();
let mockCallState: Record<string, unknown> = {};
jest.mock('../../store/call', () => {
  const useCall = (sel: (s: object) => unknown) => sel(mockCallState);
  (useCall as unknown as { getState: () => object }).getState = () => ({
    ...mockCallState,
    setPendingAction: mockSetPendingAction,
  });
  return { useCall };
});

import { IncomingCallScreen } from '../IncomingCall';

function baseState(pendingAction: 'accept' | 'decline' | null) {
  return { peer: 'caller-1', callId: 'call-1', pendingAction, media: 'audio' as const };
}

describe('IncomingCallScreen — pendingAction consumption', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto-accepts on mount when pendingAction is "accept" (foreground → mic-safe)', () => {
    mockCallState = baseState('accept');
    const onAccept = jest.fn();
    const onReject = jest.fn();

    render(<IncomingCallScreen onAccept={onAccept} onReject={onReject} />);

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    // one-shot: cleared before acting so a re-render cannot double-fire.
    expect(mockSetPendingAction).toHaveBeenCalledWith(null);
  });

  it('auto-declines on mount when pendingAction is "decline"', () => {
    mockCallState = baseState('decline');
    const onAccept = jest.fn();
    const onReject = jest.fn();

    render(<IncomingCallScreen onAccept={onAccept} onReject={onReject} />);

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(mockSetPendingAction).toHaveBeenCalledWith(null);
  });

  it('does nothing automatically when there is no pendingAction (manual ring)', () => {
    mockCallState = baseState(null);
    const onAccept = jest.fn();
    const onReject = jest.fn();

    render(<IncomingCallScreen onAccept={onAccept} onReject={onReject} />);

    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });
});
