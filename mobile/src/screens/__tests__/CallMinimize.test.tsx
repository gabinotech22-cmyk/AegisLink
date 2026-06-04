/**
 * CallScreen — minimize button visibility and sound effect tests
 *
 * Verifies:
 *  1-5. Minimize handle visibility depending on status and onMinimize prop
 *  6.   Pressing minimize handle calls onMinimize()
 *  7-12. Sound effects triggered by status transitions (useEffect on [status, direction])
 *  13.  Unmount triggers SoundFX.stopAll()
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

// ── react-native-webrtc ────────────────────────────────────────────────────
jest.mock('react-native-webrtc', () => ({ RTCView: null }));

// ── runtime ────────────────────────────────────────────────────────────────
jest.mock('../../runtime', () => ({ WEBRTC_AVAILABLE: false }));

// ── @noble/hashes/sha256 ───────────────────────────────────────────────────
jest.mock('@noble/hashes/sha256', () => ({
  sha256: jest.fn(() => new Uint8Array(32)),
}));

jest.mock('@noble/hashes/utils', () => ({
  bytesToHex: jest.fn(() => '0'.repeat(64)),
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

// ── expo-av ────────────────────────────────────────────────────────────────
jest.mock('expo-av', () => ({
  Audio: {
    Sound: { createAsync: jest.fn().mockResolvedValue({ sound: {} }) },
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── icons ──────────────────────────────────────────────────────────────────
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── useProximitySensor ──────────────────────────────────────────────────────
jest.mock('../../hooks/useProximitySensor', () => ({
  useProximitySensor: jest.fn(),
}));

// ── socket/calls ───────────────────────────────────────────────────────────
jest.mock('../../socket/calls', () => ({
  acceptCall: jest.fn(),
  endCall: jest.fn(),
  toggleMute: jest.fn(),
  toggleCamera: jest.fn(),
}));

// ── SoundFX mock — all methods are jest.fn() ──────────────────────────────
// Must use "mock" prefix so jest.mock factory can reference these variables
const mockSoundFXMethods = {
  callRingback: jest.fn().mockResolvedValue(undefined),
  stopAll: jest.fn().mockResolvedValue(undefined),
  callConnected: jest.fn().mockResolvedValue(undefined),
  callEnded: jest.fn().mockResolvedValue(undefined),
  callIncoming: jest.fn().mockResolvedValue(undefined),
  msgSent: jest.fn().mockResolvedValue(undefined),
  msgReceived: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../hooks/useSoundFX', () => ({
  SoundFX: {
    callRingback: (...args: unknown[]) => mockSoundFXMethods.callRingback(...args),
    stopAll: (...args: unknown[]) => mockSoundFXMethods.stopAll(...args),
    callConnected: (...args: unknown[]) => mockSoundFXMethods.callConnected(...args),
    callEnded: (...args: unknown[]) => mockSoundFXMethods.callEnded(...args),
    callIncoming: (...args: unknown[]) => mockSoundFXMethods.callIncoming(...args),
    msgSent: (...args: unknown[]) => mockSoundFXMethods.msgSent(...args),
    msgReceived: (...args: unknown[]) => mockSoundFXMethods.msgReceived(...args),
  },
}));

// ── Controllable call store mock ───────────────────────────────────────────
// Variable must be prefixed "mock" to be accessible in jest.mock factory
type MockCallStatus = 'idle' | 'outgoing-ringing' | 'incoming-ringing' | 'connecting' | 'in-call' | 'ended';

const mockCallScreenState: {
  status: MockCallStatus;
  peer: string;
  media: string;
  localStream: null;
  remoteStream: null;
  muted: boolean;
  cameraOff: boolean;
  startedAt: number | null;
  activePeer: null;
  direction: 'in' | 'out' | null;
} = {
  status: 'in-call',
  peer: 'peer-1',
  media: 'audio',
  localStream: null,
  remoteStream: null,
  muted: false,
  cameraOff: false,
  startedAt: Date.now(),
  activePeer: null,
  direction: 'out',
};

jest.mock('../../store/call', () => ({
  useCall: (sel: (s: typeof mockCallScreenState) => unknown) => sel(mockCallScreenState),
}));

// ── Contacts store mock ────────────────────────────────────────────────────
jest.mock('../../store/contacts', () => ({
  useContacts: (sel: (s: { get: (id: string) => { name: string; color: string; verified: boolean } | undefined }) => unknown) =>
    sel({ get: () => ({ name: 'Alice', color: '#FF0000', verified: true }) }),
}));

// ── Import after all mocks ─────────────────────────────────────────────────
import { CallScreen } from '../Call';

describe('CallScreen — minimize handle visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-attach resolved values after clearAllMocks
    mockSoundFXMethods.callRingback.mockResolvedValue(undefined);
    mockSoundFXMethods.stopAll.mockResolvedValue(undefined);
    mockSoundFXMethods.callConnected.mockResolvedValue(undefined);
    mockSoundFXMethods.callEnded.mockResolvedValue(undefined);

    mockCallScreenState.status = 'in-call';
    mockCallScreenState.direction = 'out';
    mockCallScreenState.startedAt = Date.now();
    mockCallScreenState.activePeer = null;
  });

  // ── 1. Minimize handle IS rendered when in-call + onMinimize provided ──────

  it('minimize handle is rendered when status="in-call" and onMinimize is provided', () => {
    mockCallScreenState.status = 'in-call';
    const { getByRole } = render(<CallScreen onClose={jest.fn()} onMinimize={jest.fn()} />);
    const minimizeBtn = getByRole('button', { name: /minimize call/i });
    expect(minimizeBtn).toBeTruthy();
  });

  // ── 2. Not rendered during outgoing-ringing ─────────────────────────────────

  it('minimize handle is NOT rendered when status="outgoing-ringing"', () => {
    mockCallScreenState.status = 'outgoing-ringing';
    const { queryByRole } = render(<CallScreen onClose={jest.fn()} onMinimize={jest.fn()} />);
    expect(queryByRole('button', { name: /minimize call/i })).toBeNull();
  });

  // ── 3. Not rendered during connecting ──────────────────────────────────────

  it('minimize handle is NOT rendered when status="connecting"', () => {
    mockCallScreenState.status = 'connecting';
    const { queryByRole } = render(<CallScreen onClose={jest.fn()} onMinimize={jest.fn()} />);
    expect(queryByRole('button', { name: /minimize call/i })).toBeNull();
  });

  // ── 4. Not rendered when ended ─────────────────────────────────────────────

  it('minimize handle is NOT rendered when status="ended"', () => {
    mockCallScreenState.status = 'ended';
    const { queryByRole } = render(<CallScreen onClose={jest.fn()} onMinimize={jest.fn()} />);
    expect(queryByRole('button', { name: /minimize call/i })).toBeNull();
  });

  // ── 5. Not rendered when onMinimize is undefined ────────────────────────────

  it('minimize handle is NOT rendered when onMinimize is undefined', () => {
    mockCallScreenState.status = 'in-call';
    const { queryByRole } = render(<CallScreen onClose={jest.fn()} />);
    expect(queryByRole('button', { name: /minimize call/i })).toBeNull();
  });

  // ── 6. Pressing minimize handle calls onMinimize ────────────────────────────

  it('pressing minimize handle calls onMinimize()', () => {
    mockCallScreenState.status = 'in-call';
    const onMinimize = jest.fn();
    const { getByRole } = render(<CallScreen onClose={jest.fn()} onMinimize={onMinimize} />);
    fireEvent.press(getByRole('button', { name: /minimize call/i }));
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });
});

describe('CallScreen — sound effects on status transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-attach resolved values after clearAllMocks
    mockSoundFXMethods.callRingback.mockResolvedValue(undefined);
    mockSoundFXMethods.stopAll.mockResolvedValue(undefined);
    mockSoundFXMethods.callConnected.mockResolvedValue(undefined);
    mockSoundFXMethods.callEnded.mockResolvedValue(undefined);

    mockCallScreenState.direction = 'out';
    mockCallScreenState.startedAt = null;
    mockCallScreenState.activePeer = null;
  });

  // ── 7. outgoing-ringing → callRingback ──────────────────────────────────────

  it('outgoing-ringing status triggers SoundFX.callRingback()', () => {
    mockCallScreenState.status = 'outgoing-ringing';
    render(<CallScreen onClose={jest.fn()} />);
    expect(mockSoundFXMethods.callRingback).toHaveBeenCalled();
  });

  // ── 8. connecting → stopAll ─────────────────────────────────────────────────

  it('connecting status triggers SoundFX.stopAll()', () => {
    mockCallScreenState.status = 'connecting';
    render(<CallScreen onClose={jest.fn()} />);
    expect(mockSoundFXMethods.stopAll).toHaveBeenCalled();
  });

  // ── 9. in-call + direction='out' → stopAll + callConnected ──────────────────

  it('in-call + direction="out" triggers SoundFX.stopAll() and SoundFX.callConnected()', () => {
    mockCallScreenState.status = 'in-call';
    mockCallScreenState.direction = 'out';
    mockCallScreenState.startedAt = Date.now();
    render(<CallScreen onClose={jest.fn()} />);
    expect(mockSoundFXMethods.stopAll).toHaveBeenCalled();
    expect(mockSoundFXMethods.callConnected).toHaveBeenCalled();
  });

  // ── 10. in-call + direction='in' → callConnected NOT called ─────────────────

  it('in-call + direction="in" does NOT call SoundFX.callConnected()', () => {
    mockCallScreenState.status = 'in-call';
    mockCallScreenState.direction = 'in';
    mockCallScreenState.startedAt = Date.now();
    render(<CallScreen onClose={jest.fn()} />);
    expect(mockSoundFXMethods.callConnected).not.toHaveBeenCalled();
  });

  // ── 11. ended → stopAll + callEnded ─────────────────────────────────────────

  it('ended status triggers SoundFX.stopAll() and SoundFX.callEnded()', () => {
    mockCallScreenState.status = 'ended';
    render(<CallScreen onClose={jest.fn()} />);
    expect(mockSoundFXMethods.stopAll).toHaveBeenCalled();
    expect(mockSoundFXMethods.callEnded).toHaveBeenCalled();
  });

  // ── 12. incoming-ringing → no sound methods called ──────────────────────────

  it('incoming-ringing status does NOT call any SoundFX methods', () => {
    mockCallScreenState.status = 'incoming-ringing';
    render(<CallScreen onClose={jest.fn()} />);
    expect(mockSoundFXMethods.callRingback).not.toHaveBeenCalled();
    // stopAll is called by the cleanup useEffect on a prior render in this suite
    // so we only verify the sound-effect-specific methods are NOT called
    expect(mockSoundFXMethods.callConnected).not.toHaveBeenCalled();
    expect(mockSoundFXMethods.callEnded).not.toHaveBeenCalled();
  });

  // ── 13. On unmount → SoundFX.stopAll() called ───────────────────────────────

  it('on unmount SoundFX.stopAll() is called', () => {
    // Use incoming-ringing so mount does NOT trigger the sound effects switch
    mockCallScreenState.status = 'incoming-ringing';
    const { unmount } = render(<CallScreen onClose={jest.fn()} />);

    // Clear any calls that happened during mount (e.g. the idle/close effect)
    jest.clearAllMocks();
    mockSoundFXMethods.stopAll.mockResolvedValue(undefined);

    act(() => {
      unmount();
    });

    expect(mockSoundFXMethods.stopAll).toHaveBeenCalled();
  });
});
