/**
 * DevicesScreen — unit tests (B-4: critical screens without coverage)
 *
 * Verifies:
 *  1.  Renders title + the current "THIS DEVICE" row
 *  2.  Empty state when the relay returns no linked devices
 *  3.  Renders linked devices returned by the relay
 *  4.  Revoke is confirm-gated; confirming emits device:revoke and drops the row
 *  5.  Back button invokes onBack()
 */

import React from 'react';

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../../components/AlertHost';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa',
      textFaint: '#666', accent: '#05b875', accentInk: '#000', danger: '#e63946',
      border: '#222', borderStrong: '#333', divider: '#1a1a1a',
      radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));

jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));

jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title, left, right }: { title: string; left?: import('react').ReactNode; right?: import('react').ReactNode }) => {
    const React = require('react') as typeof import('react');
    const { View, Text } = require('react-native') as typeof import('react-native');
    return React.createElement(View, null, left, right, React.createElement(Text, null, title));
  },
}));

jest.mock('../../components/Button', () => {
  const React = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  return {
    PrimaryButton: ({ label, onPress }: { label: string; onPress?: () => void }) =>
      React.createElement(Pressable, { onPress }, React.createElement(Text, null, label)),
  };
});

// ── camera ──────────────────────────────────────────────────────────────────
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, jest.fn().mockResolvedValue({ granted: true })],
}));

// ── secure store (offline device cache) ─────────────────────────────────────
// NOTE: inline jest.fn()s — ESM `import`s hoist above module-level consts, so a
// factory that eagerly reads outer `mock*` vars would capture `undefined`.
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) },
}));

// ── web3 revocation (best-effort) ───────────────────────────────────────────
jest.mock('../../web3/deviceRevocation/RevokeDevice', () => ({
  buildRevocationPayload: jest.fn().mockResolvedValue({ did: 'did:aegis:x' }),
}));

jest.mock('../../config', () => ({ SERVER_URL: 'http://relay.test' }));

// ── socket ──────────────────────────────────────────────────────────────────
let mockDeviceList: Array<{ id: string; name: string; platform: string; linkedAt: number }> = [];
let mockSocket: { emit: jest.Mock } | null = null;
const mockEmit = jest.fn((event: string, a?: unknown, b?: unknown) => {
  if (event === 'device:list') (a as (r: unknown) => void)({ ok: true, devices: mockDeviceList });
  if (event === 'device:revoke') (b as (r: unknown) => void)({ ok: true });
});
jest.mock('../../socket/client', () => ({ getSocket: () => mockSocket }));

// ── identity store (selector) ───────────────────────────────────────────────
const mockIdentityState = {
  identity: { aegisId: 'AEGIS-7QX', signingPublicKeyB64: 'sign-pub' },
};
jest.mock('../../store/identity', () => ({
  useIdentity: (sel: (s: typeof mockIdentityState) => unknown) => sel(mockIdentityState),
}));

import { DevicesScreen } from '../Devices';

describe('DevicesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeviceList = [];
    mockSocket = { emit: mockEmit };
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it('renders the title and the current-device row', () => {
    const { getByText } = render(<DevicesScreen onBack={jest.fn()} />);
    expect(getByText('Devices')).toBeTruthy();
    expect(getByText('THIS DEVICE')).toBeTruthy();
  });

  it('shows the empty state when there are no linked devices', async () => {
    mockDeviceList = [];
    const { findByText } = render(<DevicesScreen onBack={jest.fn()} />);
    expect(await findByText('No linked devices')).toBeTruthy();
  });

  it('renders linked devices returned by the relay', async () => {
    mockDeviceList = [{ id: 'd1', name: 'MacBook Pro', platform: 'desktop', linkedAt: 1_700_000_000_000 }];
    const { findByText } = render(<DevicesScreen onBack={jest.fn()} />);
    expect(await findByText('MacBook Pro')).toBeTruthy();
  });

  it('confirms before revoking, then emits device:revoke and drops the row', async () => {
    mockDeviceList = [{ id: 'd1', name: 'MacBook Pro', platform: 'desktop', linkedAt: 1_700_000_000_000 }];
    const alertSpy = themedAlert as jest.Mock;
    const { findByText, getByText, queryByText } = render(<DevicesScreen onBack={jest.fn()} />);
    await findByText('MacBook Pro');

    fireEvent.press(getByText('Revoke'));
    expect(alertSpy).toHaveBeenCalledWith(
      'Revoke device',
      expect.any(String),
      expect.any(Array),
    );
    // no revoke emitted yet — only the list fetch
    expect(mockEmit).not.toHaveBeenCalledWith('device:revoke', expect.anything(), expect.anything());

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>;
    const confirm = buttons.find((b) => b.style === 'destructive');
    confirm?.onPress?.();

    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('device:revoke', { deviceId: 'd1' }, expect.any(Function));
    });
    await waitFor(() => expect(queryByText('MacBook Pro')).toBeNull());
  });

  it('calls onBack() when the back button is pressed', () => {
    const onBack = jest.fn();
    const { UNSAFE_getAllByProps } = render(<DevicesScreen onBack={onBack} />);
    const backBtns = UNSAFE_getAllByProps({ onPress: onBack });
    expect(backBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.press(backBtns[0]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
