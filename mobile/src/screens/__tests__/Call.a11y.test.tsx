/**
 * CallScreen — accessibility tests
 *
 * Verifies:
 *  1. Mute button has accessibilityState.selected coherent with muted state
 *  2. Camera button has accessibilityState.selected coherent with cameraOff state
 */
import React from 'react';
import { render } from '@testing-library/react-native';

// ── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('@noble/hashes/sha256', () => ({
  sha256: jest.fn(() => new Uint8Array(32)),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', textFaint: '#555',
      accent: '#00FF88', accentInk: '#000', danger: '#e63946',
      surface: '#111', surface2: '#222', surface3: '#333',
      border: '#333', borderStrong: '#555',
      warn: '#f59e0b',
      radius: 8, radiusS: 4,
      font: 'Inter', fontMono: 'IBMPlexMono', fontDisplay: 'Inter',
      dark: true,
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../runtime', () => ({ WEBRTC_AVAILABLE: false }));

jest.mock('../../store/call', () => ({
  useCall: (sel: (s: object) => unknown) => sel({
    status: 'in-call',
    peer: 'peer-1',
    media: 'video',
    localStream: null,
    remoteStream: null,
    muted: true,
    cameraOff: false,
    startedAt: Date.now(),
  }),
}));

jest.mock('../../store/contacts', () => ({
  useContacts: (sel: (s: object) => unknown) => sel({
    get: () => ({ name: 'Alice', verified: true }),
  }),
}));

jest.mock('../../store/identity', () => ({
  useIdentity: () => ({ identity: { aegisId: 'me-1' } }),
}));

jest.mock('../../socket/calls', () => ({
  acceptCall: jest.fn(),
  endCall: jest.fn(),
  toggleMute: jest.fn(),
  toggleCamera: jest.fn(),
}));

jest.mock('../../crypto/wordlist', () => ({
  WORDLIST_256: Array.from({ length: 256 }, (_: unknown, i: number) => `word${i}`),
}));

jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── Import after mocks ─────────────────────────────────────────────────────
import { CallScreen } from '../Call';

describe('CallScreen — accessibility', () => {
  it('mute button has accessibilityState.selected=true when muted', () => {
    const { getAllByRole } = render(<CallScreen onClose={jest.fn()} />);
    const buttons = getAllByRole('button');
    const muteBtn = buttons.find(
      (b) => {
        const label = b.props.accessibilityLabel as string | undefined;
        return label && label.toLowerCase().includes('mute');
      }
    );
    expect(muteBtn).toBeTruthy();
    expect(muteBtn!.props.accessibilityState?.selected).toBe(true);
  });

  it('camera button has accessibilityState.selected=false when camera is on', () => {
    const { getAllByRole } = render(<CallScreen onClose={jest.fn()} />);
    const buttons = getAllByRole('button');
    const cameraBtn = buttons.find(
      (b) => {
        const label = b.props.accessibilityLabel as string | undefined;
        return label && label.toLowerCase().includes('camera');
      }
    );
    expect(cameraBtn).toBeTruthy();
    // cameraOff=false → selected should be false
    expect(cameraBtn!.props.accessibilityState?.selected).toBe(false);
  });
});
