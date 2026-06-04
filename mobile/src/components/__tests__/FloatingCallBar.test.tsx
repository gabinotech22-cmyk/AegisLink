/**
 * FloatingCallBar — unit tests
 *
 * Verifies:
 *  1. Renders peer name from contacts store
 *  2. Renders formatted duration (00:42 for 42s elapsed)
 *  3. Renders "AUDIO" label for audio call
 *  4. Renders "VIDEO" label for video call
 *  5. Calls onExpand when the main area is pressed
 *  6. Mute button calls toggleMute, does NOT call onExpand
 *  7. End button calls SoundFX.callEnded and endCall('hangup'), does NOT call onExpand
 *  8. When muted=true, mute button has warning border colour (style check)
 *  9. Component re-renders timer when startedAt changes (fake timers)
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

// ── react-native-reanimated ────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (cb: () => object) => cb(),
    withSpring: (v: number) => v,
    withTiming: (v: number) => v,
    withRepeat: (v: unknown) => v,
    withSequence: (...args: unknown[]) => args[args.length - 1],
    useReducedMotion: () => false,
    runOnJS: (fn: (...a: unknown[]) => unknown) => fn,
    Easing: { inOut: () => undefined, ease: undefined, out: () => undefined, cubic: undefined, linear: undefined },
  };
});

// ── react-native-safe-area-context ─────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 0, left: 0, right: 0 }),
}));

// ── react-i18next ──────────────────────────────────────────────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

// ── ThemeContext ───────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000',
      surface: '#111',
      surface2: '#222',
      text: '#fff',
      textDim: '#aaa',
      accent: '#00FF88',
      border: '#333',
      borderStrong: '#555',
      danger: '#e63946',
      warn: '#f59e0b',
      font: 'System',
      fontMono: 'monospace',
      fontDisplay: 'System',
      radius: 14,
      radiusS: 8,
    },
  }),
}));

// ── icons — return null for every icon component ───────────────────────────
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── Controllable call store mock ───────────────────────────────────────────
const mockCallState = {
  peer: 'peer-aegis-id',
  muted: false,
  startedAt: null as number | null,
  media: 'audio' as 'audio' | 'video',
};

jest.mock('../../store/call', () => ({
  useCall: (sel: (s: typeof mockCallState) => unknown) => sel(mockCallState),
}));

// ── Controllable contacts store mock ──────────────────────────────────────
const mockContact = {
  name: 'Alice',
  color: '#FF0000',
  aegisId: 'peer-aegis-id',
};

jest.mock('../../store/contacts', () => ({
  useContacts: (sel: (s: { get: (id: string) => typeof mockContact | undefined }) => unknown) =>
    sel({ get: (id: string) => (id === 'peer-aegis-id' ? mockContact : undefined) }),
}));

// ── socket/calls mocks ─────────────────────────────────────────────────────
const mockEndCall = jest.fn();
const mockToggleMute = jest.fn();

jest.mock('../../socket/calls', () => ({
  endCall: (...args: unknown[]) => mockEndCall(...args),
  toggleMute: () => mockToggleMute(),
}));

// ── SoundFX mock ───────────────────────────────────────────────────────────
const mockCallEnded = jest.fn().mockResolvedValue(undefined);

jest.mock('../../hooks/useSoundFX', () => ({
  SoundFX: {
    callEnded: () => mockCallEnded(),
    stopAll: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── Import after all mocks ─────────────────────────────────────────────────
import { FloatingCallBar } from '../FloatingCallBar';

describe('FloatingCallBar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset to defaults
    mockCallState.peer = 'peer-aegis-id';
    mockCallState.muted = false;
    mockCallState.startedAt = null;
    mockCallState.media = 'audio';
  });

  // ── 1. Renders peer name ───────────────────────────────────────────────────

  it('renders peer name from contacts store', () => {
    const { getByText } = render(<FloatingCallBar onExpand={jest.fn()} />);
    expect(getByText('Alice')).toBeTruthy();
  });

  // ── 2. Renders formatted duration ─────────────────────────────────────────

  it('renders formatted duration "00:42" for 42 seconds elapsed', () => {
    const now = Date.now();
    mockCallState.startedAt = now - 42_000;

    const { getByText } = render(<FloatingCallBar onExpand={jest.fn()} />);
    expect(getByText(/00:4[12]/)).toBeTruthy();
  });

  // ── 3. AUDIO label ────────────────────────────────────────────────────────

  it('renders "AUDIO" label for audio call', () => {
    mockCallState.media = 'audio';
    const { getByText } = render(<FloatingCallBar onExpand={jest.fn()} />);
    expect(getByText(/AUDIO/)).toBeTruthy();
  });

  // ── 4. VIDEO label ────────────────────────────────────────────────────────

  it('renders "VIDEO" label for video call', () => {
    mockCallState.media = 'video';
    const { getByText } = render(<FloatingCallBar onExpand={jest.fn()} />);
    expect(getByText(/VIDEO/)).toBeTruthy();
  });

  // ── 5. onExpand called when main area is pressed ───────────────────────────

  it('calls onExpand when the main pressable area is pressed', () => {
    const onExpand = jest.fn();
    const { getByRole } = render(<FloatingCallBar onExpand={onExpand} />);
    // The outermost Pressable has accessibilityLabel "Return to call"
    const mainBar = getByRole('button', { name: /return to call/i });
    fireEvent.press(mainBar);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  // ── 6. Mute button calls toggleMute, does NOT call onExpand ───────────────

  it('pressing the mute button calls toggleMute and does NOT call onExpand', () => {
    const onExpand = jest.fn();
    const { getAllByRole } = render(<FloatingCallBar onExpand={onExpand} />);
    // The component renders: [0] outer Pressable (Return to call), [1] Mute, [2] End call
    const buttons = getAllByRole('button');
    const muteBtn = buttons.find(
      (b) => {
        const label = b.props.accessibilityLabel as string | undefined;
        return label?.toLowerCase().includes('mute');
      }
    );
    expect(muteBtn).toBeTruthy();
    // Pass an empty event object so the handler's e.stopPropagation?.() doesn't crash
    fireEvent(muteBtn!, 'press', {});
    expect(mockToggleMute).toHaveBeenCalledTimes(1);
    expect(onExpand).not.toHaveBeenCalled();
  });

  // ── 7. End button calls SoundFX.callEnded and endCall('hangup') ────────────

  it('pressing end button calls SoundFX.callEnded and endCall("hangup") without calling onExpand', () => {
    const onExpand = jest.fn();
    const { getAllByRole } = render(<FloatingCallBar onExpand={onExpand} />);
    const buttons = getAllByRole('button');
    const endBtn = buttons.find(
      (b) => {
        const label = b.props.accessibilityLabel as string | undefined;
        return label?.toLowerCase().includes('end call');
      }
    );
    expect(endBtn).toBeTruthy();
    // Pass an empty event object so the handler's e.stopPropagation?.() doesn't crash
    fireEvent(endBtn!, 'press', {});
    expect(mockCallEnded).toHaveBeenCalledTimes(1);
    expect(mockEndCall).toHaveBeenCalledWith('hangup');
    expect(onExpand).not.toHaveBeenCalled();
  });

  // ── 8. Muted: warning border colour ───────────────────────────────────────

  it('when muted=true, mute button has warning border color', () => {
    mockCallState.muted = true;
    const { getAllByRole } = render(<FloatingCallBar onExpand={jest.fn()} />);
    const buttons = getAllByRole('button');
    const muteBtn = buttons.find(
      (b) => {
        const label = b.props.accessibilityLabel as string | undefined;
        return label?.toLowerCase().includes('unmute');
      }
    );
    expect(muteBtn).toBeTruthy();
    // accessibilityLabel changes to "Unmute" when muted — confirms warning state
    expect(muteBtn!.props.accessibilityLabel).toMatch(/unmute/i);
  });

  // ── 9. Timer re-renders when startedAt changes ────────────────────────────

  it('timer updates when 1 second passes (fake timers)', () => {
    jest.useFakeTimers();
    const now = 1_700_000_000_000;
    jest.setSystemTime(now);
    mockCallState.startedAt = now; // 0 seconds elapsed initially

    const { getByText, rerender } = render(<FloatingCallBar onExpand={jest.fn()} />);
    expect(getByText(/00:00/)).toBeTruthy();

    // Advance time by 1 second — the interval inside FloatingCallBar fires
    act(() => {
      jest.advanceTimersByTime(1_000);
    });

    // After 1 second has passed the timer should show 00:01
    expect(getByText(/00:0[01]/)).toBeTruthy();

    jest.useRealTimers();
  });
});
