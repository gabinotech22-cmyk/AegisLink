/**
 * LockScreen — PIN-first unlock (regression, iOS TestFlight build 14).
 *
 * On iPhone 8 / Touch ID the old flow auto-launched the system biometric
 * prompt on mount. That prompt is a modal system alert: it covers the
 * "use PIN" button under it, so with a failing sensor the user was trapped
 * with no way to type the PIN — and the duress (decoy) PIN lives on this
 * screen, so it MUST always be typeable. It also allowed the device-passcode
 * fallback, which unlocks the app while bypassing validatePin() (and with it
 * the duress path) entirely.
 *
 * New contract:
 *  1. With a stored PIN, the PIN pad is ALWAYS the initial view — biometrics
 *     never auto-launch.
 *  2. Biometrics run only from the explicit button, and always with
 *     disableDeviceFallback: true.
 *  3. The biometrics button is hidden when the preference is off.
 *  4. Bio-only setups (no stored PIN) keep the biometric view + auto-launch.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockAuthenticateAsync = jest.fn();
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(true),
  isEnrolledAsync: jest.fn().mockResolvedValue(true),
  supportedAuthenticationTypesAsync: jest.fn().mockResolvedValue([1]),
  authenticateAsync: (...a: unknown[]) => mockAuthenticateAsync(...a),
}), { virtual: true });

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
  }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      dark: true, bg: '#000', surface: '#111', surface2: '#222', surface3: '#333', text: '#fff',
      textDim: '#aaa', textFaint: '#666', accent: '#05b875', accentInk: '#000',
      danger: '#e63946', border: '#222', borderStrong: '#333', divider: '#1a1a1a',
      radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));

jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/AegisMark', () => ({ AegisMark: () => null }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../../utils/secureStore', () => ({ ss: { get: jest.fn().mockResolvedValue(null) } }));
jest.mock('../../db/local', () => ({ wipeDatabase: jest.fn() }));
jest.mock('../../hooks/usePanicGesture', () => ({
  usePanicGesture: () => ({ registerTap: jest.fn(), registerLongPress: jest.fn() }),
}));
jest.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ reset: jest.fn(), hydrate: jest.fn() }) },
}));
jest.mock('../../store/contacts', () => ({
  useContacts: { getState: () => ({ hydrate: jest.fn() }) },
}));
jest.mock('../../store/messages', () => ({
  useMessages: {
    setState: jest.fn(),
    getState: () => ({ loadAllUnreads: jest.fn(), loadAllEphemeralTimers: jest.fn() }),
  },
}));

const mockHasStoredPIN = jest.fn();
jest.mock('../../lock/pin', () => ({
  verifyPIN: jest.fn().mockResolvedValue(false),
  hasStoredPIN: () => mockHasStoredPIN(),
  verifyPinWithSalt: jest.fn().mockResolvedValue(false),
  DURESS_PIN_SALT: 'duress-salt',
}));

const mockPrefsState = { biometricsEnabled: true, duressActive: false };
jest.mock('../../store/preferences', () => {
  const hook = (sel: (s: typeof mockPrefsState) => unknown) => sel(mockPrefsState);
  return {
    usePreferences: Object.assign(hook, {
      setState: (p: Partial<typeof mockPrefsState>) => Object.assign(mockPrefsState, p),
      getState: () => mockPrefsState,
    }),
  };
});

import { LockScreen } from '../Lock';

describe('LockScreen — PIN-first', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasStoredPIN.mockResolvedValue(true);
    mockPrefsState.biometricsEnabled = true;
    mockPrefsState.duressActive = false;
    // Cancelled prompt: keeps the flow on-screen without unlocking.
    mockAuthenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });
  });

  it('shows the PIN pad first and never auto-launches the biometric prompt', async () => {
    const { getByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.enterPin'));
    getByText('1'); // numpad is on screen
    expect(mockAuthenticateAsync).not.toHaveBeenCalled();
  });

  it('runs biometrics only from the button, with disableDeviceFallback: true', async () => {
    const { getByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.useBiometrics'));

    fireEvent.press(getByText('lock.useBiometrics'));
    await waitFor(() => expect(mockAuthenticateAsync).toHaveBeenCalledTimes(1));
    // Device passcode must never unlock the app: it would bypass the app PIN
    // and with it the duress/decoy path.
    expect(mockAuthenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ disableDeviceFallback: true }),
    );

    // Cancelling returns to the PIN pad.
    await waitFor(() => getByText('lock.enterPin'));
  });

  it('hides the biometrics button when the preference is off', async () => {
    mockPrefsState.biometricsEnabled = false;
    const { getByText, queryByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.enterPin'));
    expect(queryByText('lock.useBiometrics')).toBeNull();
  });

  it('keeps the biometric view + auto-launch for bio-only setups (no stored PIN)', async () => {
    mockHasStoredPIN.mockResolvedValue(false);
    render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => expect(mockAuthenticateAsync).toHaveBeenCalledTimes(1));
  });
});
