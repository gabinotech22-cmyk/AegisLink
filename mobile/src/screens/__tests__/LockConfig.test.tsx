/**
 * LockConfigScreen — unit tests (B-4: critical screens without coverage)
 *
 * Verifies the app-lock security flows:
 *  1.  Renders title + master toggle
 *  2.  Enabling app-lock with no stored PIN opens the PIN modal and does NOT
 *      flip the preference until a PIN is actually set
 *  3.  Setting a matching 4-digit PIN twice calls setPIN and enables app-lock
 *  4.  Deleting the PIN is confirm-gated; confirming clears it and disables lock
 *  5.  Biometrics / hide-recents toggles persist
 *  6.  Inactivity timeout selection persists
 *  7.  "Lock now (Test)" invokes onLockTest; back invokes onBack
 */

import React from 'react';

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(true),
  isEnrolledAsync: jest.fn().mockResolvedValue(true),
}), { virtual: true });
import { themedAlert } from '../../components/AlertHost';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// i18n: honour string fallback + interpolate {{count}} so timeout labels are distinct
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fb?: unknown, opts?: { count?: number }) => {
      let s = typeof fb === 'string' ? fb : k;
      if (opts && opts.count != null) s = s.replace('{{count}}', String(opts.count));
      return s;
    },
  }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', surface3: '#333', text: '#fff',
      textDim: '#aaa', textFaint: '#666', accent: '#05b875', accentInk: '#000',
      danger: '#e63946', border: '#222', borderStrong: '#333', divider: '#1a1a1a',
      radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));

jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));

jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title, left }: { title: string; left?: import('react').ReactNode }) => {
    const React = require('react') as typeof import('react');
    const { View, Text } = require('react-native') as typeof import('react-native');
    return React.createElement(View, null, left, React.createElement(Text, null, title));
  },
}));

jest.mock('../../components/Section', () => {
  const React = require('react') as typeof import('react');
  const { View, Text, Pressable } = require('react-native') as typeof import('react-native');
  return {
    Section: ({ label, children }: { label?: string; children?: import('react').ReactNode }) =>
      React.createElement(View, null, label ? React.createElement(Text, null, label) : null, children),
    Toggle: ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) =>
      React.createElement(Pressable, { onPress: () => onChange(!value) }, React.createElement(Text, null, label)),
  };
});

// ── PIN store ───────────────────────────────────────────────────────────────
const mockSetPIN = jest.fn().mockResolvedValue(undefined);
const mockClearPIN = jest.fn().mockResolvedValue(undefined);
const mockHasStoredPIN = jest.fn().mockResolvedValue(false);
jest.mock('../../lock/pin', () => ({
  setPIN: (...a: unknown[]) => mockSetPIN(...a),
  clearPIN: (...a: unknown[]) => mockClearPIN(...a),
  hasStoredPIN: () => mockHasStoredPIN(),
  verifyPinWithSalt: jest.fn().mockResolvedValue(false),
  DURESS_PIN_SALT: 'test-salt',
}));

const mockSsGet = jest.fn().mockResolvedValue(null);
jest.mock('../../utils/secureStore', () => ({
  ss: { get: (...a: unknown[]) => mockSsGet(...a), set: jest.fn(), delete: jest.fn() },
}));

// ── preferences store ───────────────────────────────────────────────────────
const mockSetPref = jest.fn();
const mockPrefs: Record<string, unknown> = {
  appLockEnabled: false,
  biometricsEnabled: false,
  lockTimeoutMin: 0,
  hideRecents: false,
  set: mockSetPref,
};
jest.mock('../../store/preferences', () => ({
  usePreferences: (sel: (s: Record<string, unknown>) => unknown) => sel(mockPrefs),
}));

import { LockConfigScreen } from '../LockConfig';

function makeProps() {
  return { onBack: jest.fn(), onLockTest: jest.fn(), onLockSettings: jest.fn() };
}

function enterPin(getByText: (t: string) => unknown, digits: string) {
  for (const d of digits) fireEvent.press(getByText(d) as never);
}

describe('LockConfigScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasStoredPIN.mockResolvedValue(false);
    mockSetPIN.mockResolvedValue(undefined);
    mockClearPIN.mockResolvedValue(undefined);
    mockPrefs.appLockEnabled = false;
    mockPrefs.biometricsEnabled = false;
    mockPrefs.lockTimeoutMin = 0;
    mockPrefs.hideRecents = false;
  });

  it('renders the title and the app-lock master toggle', async () => {
    const { getByText } = render(<LockConfigScreen {...makeProps()} />);
    await act(async () => {});
    expect(getByText('App Lock')).toBeTruthy();
    expect(getByText('App lock')).toBeTruthy();
  });

  it('enabling app-lock without a PIN opens the modal but does not enable the preference', async () => {
    const { getByText } = render(<LockConfigScreen {...makeProps()} />);
    await act(async () => {});
    fireEvent.press(getByText('App lock')); // off → on
    // PIN modal prompt appears, preference NOT yet enabled
    expect(getByText('Enter a 6-digit PIN')).toBeTruthy();
    expect(mockSetPref).not.toHaveBeenCalledWith('appLockEnabled', true);
  });

  it('setting a matching PIN twice calls setPIN and enables app-lock', async () => {
    jest.useFakeTimers();
    try {
      const { getByText } = render(<LockConfigScreen {...makeProps()} />);
      await act(async () => {});
      fireEvent.press(getByText('App lock'));

      enterPin(getByText, '123456');
      await act(async () => { jest.advanceTimersByTime(200); }); // → confirm step
      enterPin(getByText, '123456');
      await act(async () => { jest.advanceTimersByTime(200); }); // → processPin
      await act(async () => {}); // flush setPIN promise

      expect(mockSetPIN).toHaveBeenCalledWith('123456');
      expect(mockSetPref).toHaveBeenCalledWith('appLockEnabled', true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects setting a PIN that matches the decoy PIN', async () => {
    jest.useFakeTimers();
    try {
      mockSsGet.mockResolvedValue(JSON.stringify({ duressPin: true, pinHash: 'fake-hash' }));
      const { verifyPinWithSalt } = require('../../lock/pin');
      (verifyPinWithSalt as jest.Mock).mockResolvedValue(true); // simulate match

      const { getByText } = render(<LockConfigScreen {...makeProps()} />);
      await act(async () => {});
      fireEvent.press(getByText('App lock'));

      enterPin(getByText, '654321');
      await act(async () => { jest.advanceTimersByTime(200); }); // → confirm step
      enterPin(getByText, '654321');
      await act(async () => { jest.advanceTimersByTime(200); }); // → processPin
      await act(async () => {}); // flush promises

      expect(mockSetPIN).not.toHaveBeenCalled();
      expect(getByText('PIN cannot be the same as decoy PIN.')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('confirms before deleting the PIN, then clears it and disables app-lock', async () => {
    mockHasStoredPIN.mockResolvedValue(true);
    mockPrefs.appLockEnabled = true;
    const alertSpy = themedAlert as jest.Mock;
    const { findByText, getByText } = render(<LockConfigScreen {...makeProps()} />);

    const delRow = await findByText('Delete PIN');
    fireEvent.press(delRow);
    expect(alertSpy).toHaveBeenCalledWith('Delete PIN', expect.any(String), expect.any(Array));
    expect(mockClearPIN).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void | Promise<void> }>;
    const confirm = buttons.find((b) => b.style === 'destructive');
    await act(async () => { await confirm!.onPress?.(); });
    await waitFor(() => expect(mockClearPIN).toHaveBeenCalledTimes(1));
    expect(mockSetPref).toHaveBeenCalledWith('appLockEnabled', false);
    expect(getByText).toBeTruthy();
  });

  it('persists biometrics and hide-recents toggles', async () => {
    mockHasStoredPIN.mockResolvedValue(true);
    mockPrefs.appLockEnabled = true;
    const { getByText } = render(<LockConfigScreen {...makeProps()} />);
    await act(async () => {});

    fireEvent.press(getByText('Face ID / Fingerprint'));
    expect(mockSetPref).toHaveBeenCalledWith('biometricsEnabled', true);

    fireEvent.press(getByText('Hide in recents'));
    expect(mockSetPref).toHaveBeenCalledWith('hideRecents', true);
  });

  it('persists the inactivity timeout selection', async () => {
    mockHasStoredPIN.mockResolvedValue(true);
    mockPrefs.appLockEnabled = true;
    mockPrefs.lockTimeoutMin = 0;
    const { getByText } = render(<LockConfigScreen {...makeProps()} />);
    await act(async () => {});

    fireEvent.press(getByText('Inactivity timeout')); // open picker
    fireEvent.press(getByText('5 minutes'));
    expect(mockSetPref).toHaveBeenCalledWith('lockTimeoutMin', 5);
  });

  it('invokes onLockTest and onBack', async () => {
    mockHasStoredPIN.mockResolvedValue(true);
    mockPrefs.appLockEnabled = true;
    const props = makeProps();
    const { getByText, UNSAFE_getAllByProps } = render(<LockConfigScreen {...props} />);
    await act(async () => {});

    fireEvent.press(getByText('Lock now (Test) ▸'));
    expect(props.onLockTest).toHaveBeenCalledTimes(1);

    const backBtns = UNSAFE_getAllByProps({ onPress: props.onBack });
    fireEvent.press(backBtns[0]);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});

// ─── Fail-closed on the decoy-PIN guard (audit 2026-08, TEST-1) ──────────────
//
// The check that stops the real PIN being set to the DECOY PIN used to sit
// inside `catch {}`. Any throw in there — a corrupted aegis.panic.v1 blob, a
// require failure, an Argon2 error in verifyPinWithSalt — was swallowed and
// execution fell straight through to setPIN(). The result would be silent and
// severe: the PIN handed over under coercion unlocks the REAL account instead
// of the decoy, and the user is never told the guard did not run.
//
// Golden rule #6: production fails closed. If we cannot PROVE the two PINs
// differ, we refuse to store one.

describe('LockConfigScreen — decoy-PIN guard fails closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasStoredPIN.mockResolvedValue(false);
    // mockPrefs is a shared mutable object and an earlier suite leaves
    // appLockEnabled true — pressing "App lock" would then toggle it OFF
    // instead of opening the PIN modal.
    mockPrefs.appLockEnabled = false;
    mockPrefs.biometricsEnabled = false;
  });

  it('does NOT store a PIN when the decoy comparison throws', async () => {
    jest.useFakeTimers();
    try {
      // Panic state present, so the guard runs — but the verify blows up.
      mockSsGet.mockResolvedValue(JSON.stringify({ duressPin: true, pinHash: 'fake-hash' }));
      const { verifyPinWithSalt } = require('../../lock/pin');
      (verifyPinWithSalt as jest.Mock).mockRejectedValue(new Error('argon2 exploded'));

      const { getByText } = render(<LockConfigScreen {...makeProps()} />);
      await act(async () => {});
      fireEvent.press(getByText('App lock'));

      enterPin(getByText, '654321');
      await act(async () => { jest.advanceTimersByTime(200); });
      enterPin(getByText, '654321');
      await act(async () => { jest.advanceTimersByTime(200); });
      await act(async () => {});

      // The whole point: nothing stored, app-lock not silently enabled.
      expect(mockSetPIN).not.toHaveBeenCalled();
      expect(mockSetPref).not.toHaveBeenCalledWith('appLockEnabled', true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT store a PIN when the panic blob is corrupt and cannot be parsed', async () => {
    jest.useFakeTimers();
    try {
      mockSsGet.mockResolvedValue('{ this is not json');

      const { getByText } = render(<LockConfigScreen {...makeProps()} />);
      await act(async () => {});
      fireEvent.press(getByText('App lock'));

      enterPin(getByText, '654321');
      await act(async () => { jest.advanceTimersByTime(200); });
      enterPin(getByText, '654321');
      await act(async () => { jest.advanceTimersByTime(200); });
      await act(async () => {});

      expect(mockSetPIN).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
