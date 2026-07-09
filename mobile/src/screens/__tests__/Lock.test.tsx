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

const mockSecureStore = new Map<string, string>();
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn(async (k: string) => mockSecureStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { mockSecureStore.set(k, v); }),
    delete: jest.fn(async (k: string) => { mockSecureStore.delete(k); }),
  },
}));

const mockWipeDatabase = jest.fn();
jest.mock('../../db/local', () => ({ wipeDatabase: (...a: unknown[]) => mockWipeDatabase(...a) }));

const mockWithPickingGuard = jest.fn((fn: () => Promise<unknown>) => fn());
jest.mock('../../utils/pickingGuard', () => ({
  withPickingGuard: (fn: () => Promise<unknown>) => mockWithPickingGuard(fn),
}));
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
const mockVerifyPIN = jest.fn();
const mockVerifyPinWithSalt = jest.fn();
const mockGetStoredPinLength = jest.fn();
const mockSetStoredPinLength = jest.fn();
jest.mock('../../lock/pin', () => ({
  verifyPIN: (...a: unknown[]) => mockVerifyPIN(...a),
  hasStoredPIN: () => mockHasStoredPIN(),
  verifyPinWithSalt: (...a: unknown[]) => mockVerifyPinWithSalt(...a),
  DURESS_PIN_SALT: 'duress-salt',
  getStoredPinLength: () => mockGetStoredPinLength(),
  setStoredPinLength: (...a: unknown[]) => mockSetStoredPinLength(...a),
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
    mockSecureStore.clear();
    mockHasStoredPIN.mockResolvedValue(true);
    mockVerifyPIN.mockResolvedValue(false);
    mockVerifyPinWithSalt.mockResolvedValue(false);
    mockGetStoredPinLength.mockResolvedValue(6);
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

/**
 * Attempt counting, progressive cooldown and PIN-length gating (lock
 * hardening, PR #288). Attempts persist under aegis.lock.attempts.v1 so a
 * relaunch can't reset the counter; biometric failures stay entirely outside
 * the PIN attempt/auto-wipe path (owner decision, roadmap §5).
 */
const ATTEMPTS_KEY = 'aegis.lock.attempts.v1';

describe('LockScreen — attempts, cooldown & PIN length', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSecureStore.clear();
    mockHasStoredPIN.mockResolvedValue(true);
    mockVerifyPIN.mockResolvedValue(false);
    mockVerifyPinWithSalt.mockResolvedValue(false);
    mockGetStoredPinLength.mockResolvedValue(6);
    mockPrefsState.biometricsEnabled = true;
    mockPrefsState.duressActive = false;
    mockAuthenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });
  });

  it('counts a wrong 4-digit entry as an attempt immediately on a 4-digit install', async () => {
    mockGetStoredPinLength.mockResolvedValue(4);
    const { getByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.enterPin'));

    for (const d of ['9', '9', '9', '9']) fireEvent.press(getByText(d));

    await waitFor(() => expect(mockVerifyPIN).toHaveBeenCalledWith('9999'));
    await waitFor(() => getByText('lock.pinError_plural')); // "N attempts left"
    expect(JSON.parse(mockSecureStore.get(ATTEMPTS_KEY)!)).toEqual({
      count: 1,
      lockedUntilMs: null,
    });
  });

  it('never validates at 4 digits on a 6-digit install (no silent probe)', async () => {
    const { getByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.enterPin'));

    for (const d of ['1', '2', '3', '4']) fireEvent.press(getByText(d));
    // Give the (10 ms) four-digit checkpoint time to run.
    await new Promise((r) => setTimeout(r, 80));

    expect(mockVerifyPIN).not.toHaveBeenCalled();
    expect(mockSecureStore.has(ATTEMPTS_KEY)).toBe(false); // counter untouched
  });

  it('blocks the numpad during a persisted cooldown', async () => {
    mockSecureStore.set(
      ATTEMPTS_KEY,
      JSON.stringify({ count: 5, lockedUntilMs: Date.now() + 60_000 }),
    );
    const { getByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.cooldownWait'));

    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.press(getByText(d));
    await new Promise((r) => setTimeout(r, 250)); // past the 180 ms validate delay

    expect(mockVerifyPIN).not.toHaveBeenCalled();
  });

  it('accepts input again once the persisted cooldown has expired', async () => {
    mockSecureStore.set(
      ATTEMPTS_KEY,
      JSON.stringify({ count: 5, lockedUntilMs: Date.now() - 1_000 }),
    );
    mockVerifyPIN.mockResolvedValue(true);
    const onUnlock = jest.fn();
    const { getByText, queryByText } = render(
      <LockScreen onUnlock={onUnlock} onPanic={jest.fn()} />,
    );
    await waitFor(() => getByText('lock.enterPin'));
    expect(queryByText('lock.cooldownWait')).toBeNull(); // expired lock not re-shown

    for (const d of ['1', '1', '1', '1', '1', '1']) fireEvent.press(getByText(d));

    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1));
    // Successful unlock resets the persisted counter.
    expect(JSON.parse(mockSecureStore.get(ATTEMPTS_KEY)!)).toEqual({
      count: 0,
      lockedUntilMs: null,
    });
  });

  it('a biometric failure never touches the PIN attempt counter or the wipe path', async () => {
    mockAuthenticateAsync.mockResolvedValue({ success: false, error: 'lockout' });
    const { getByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.useBiometrics'));

    fireEvent.press(getByText('lock.useBiometrics'));
    await waitFor(() => expect(mockAuthenticateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => getByText('lock.bioFailed'));

    expect(mockSecureStore.has(ATTEMPTS_KEY)).toBe(false);
    expect(mockWipeDatabase).not.toHaveBeenCalled();
  });

  it('ignores further input while a counted validation is in flight (no double-count)', async () => {
    mockGetStoredPinLength.mockResolvedValue(4);
    let resolveVerify: (v: boolean) => void = () => {};
    mockVerifyPIN.mockImplementation(
      () => new Promise<boolean>((r) => { resolveVerify = r; }),
    );
    const { getByText } = render(<LockScreen onUnlock={jest.fn()} onPanic={jest.fn()} />);
    await waitFor(() => getByText('lock.enterPin'));

    for (const d of ['9', '9', '9', '9']) fireEvent.press(getByText(d));
    await waitFor(() => expect(mockVerifyPIN).toHaveBeenCalledTimes(1));

    // Verify still pending — digits and deletes must be swallowed, otherwise
    // a delete+retype schedules a second overlapping (double-counted) attempt.
    fireEvent.press(getByText('⌫'));
    fireEvent.press(getByText('9'));
    fireEvent.press(getByText('9'));

    resolveVerify(false);
    await waitFor(() => getByText('lock.pinError_plural'));

    expect(mockVerifyPIN).toHaveBeenCalledTimes(1); // exactly one counted attempt
    expect(JSON.parse(mockSecureStore.get(ATTEMPTS_KEY)!)).toEqual({
      count: 1,
      lockedUntilMs: null,
    });
  });
});
