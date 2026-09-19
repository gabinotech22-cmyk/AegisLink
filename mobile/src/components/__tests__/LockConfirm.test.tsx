/**
 * LockConfirm — federation F5b (D4): proof of the app lock before a sensitive
 * setting change. No lock (or no PIN) → confirm() is true at once, no UI.
 * Lock on → biometrics first when enabled and available; otherwise the PIN
 * modal: wrong PIN stays (error), right PIN resolves true, cancel resolves false.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, f?: string) => f ?? k }) }));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({ t: { surface: '#111', border: '#333', text: '#fff', textDim: '#aaa', danger: '#f33', radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace' } }),
}));
jest.mock('../Button', () => {
  const React = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  return { PrimaryButton: ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) =>
    React.createElement(Pressable, { onPress, disabled, testID: `btn:${label}` }, React.createElement(Text, null, label)) };
});
const mockPrefs = { appLockEnabled: true, biometricsEnabled: false };
jest.mock('../../store/preferences', () => ({ usePreferences: (sel: (s: typeof mockPrefs) => unknown) => sel(mockPrefs) }));
const mockPin = { has: true, len: 4 as 4 | 6, valid: '1234' };
jest.mock('../../lock/pin', () => ({
  hasStoredPIN: async () => mockPin.has,
  getStoredPinLength: async () => mockPin.len,
  verifyPIN: async (p: string) => p === mockPin.valid,
}));
jest.mock('../../utils/pickingGuard', () => ({ withPickingGuard: (fn: () => unknown) => fn() }));
const mockLA = { hw: true, enrolled: true, result: { success: true } as { success: boolean; error?: string } };
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: async () => mockLA.hw,
  isEnrolledAsync: async () => mockLA.enrolled,
  authenticateAsync: async () => mockLA.result,
}), { virtual: true });

import { useLockConfirm } from '../LockConfirm';

let latest: { confirm: () => Promise<boolean> } | null = null;
function Host() {
  const { confirm, element } = useLockConfirm();
  latest = { confirm };
  return <>{element}<Text>host</Text></>;
}

describe('useLockConfirm (F5b · D4)', () => {
  beforeEach(() => { mockPrefs.appLockEnabled = true; mockPrefs.biometricsEnabled = false; mockPin.has = true; mockLA.result = { success: true }; });

  it('no app lock, or no stored PIN → true immediately, no modal', async () => {
    mockPrefs.appLockEnabled = false;
    const { queryByTestId } = render(<Host />);
    await expect(latest!.confirm()).resolves.toBe(true);
    mockPrefs.appLockEnabled = true; mockPin.has = false;
    await expect(latest!.confirm()).resolves.toBe(true);
    expect(queryByTestId('lock-confirm-pin')).toBeNull();
  });

  it('biometrics enabled + available: success resolves true without the PIN modal; cancel falls back to the PIN', async () => {
    mockPrefs.biometricsEnabled = true;
    const { queryByTestId, getByTestId } = render(<Host />);
    await expect(latest!.confirm()).resolves.toBe(true);
    expect(queryByTestId('lock-confirm-pin')).toBeNull();

    mockLA.result = { success: false, error: 'user_cancel' };
    let resolved: boolean | null = null;
    act(() => { void latest!.confirm().then((v) => { resolved = v; }); });
    await waitFor(() => expect(getByTestId('lock-confirm-pin')).toBeTruthy());
    fireEvent.changeText(getByTestId('lock-confirm-pin'), '1234');
    await act(async () => { fireEvent.press(getByTestId('btn:lockConfirm.confirm')); });
    await waitFor(() => expect(resolved).toBe(true));
  });

  it('PIN modal: a wrong PIN shows an error and keeps waiting; the right one resolves true; cancel resolves false', async () => {
    const { getByTestId, queryByTestId } = render(<Host />);
    let resolved: boolean | null = null;
    act(() => { void latest!.confirm().then((v) => { resolved = v; }); });
    await waitFor(() => expect(getByTestId('lock-confirm-pin')).toBeTruthy());

    fireEvent.changeText(getByTestId('lock-confirm-pin'), '9999');
    await act(async () => { fireEvent.press(getByTestId('btn:lockConfirm.confirm')); });
    await waitFor(() => expect(getByTestId('lock-confirm-error')).toBeTruthy());
    expect(resolved).toBeNull();

    fireEvent.changeText(getByTestId('lock-confirm-pin'), '12345678'); // clamped to the PIN length
    expect(getByTestId('lock-confirm-pin').props.value).toBe('1234');
    await act(async () => { fireEvent.press(getByTestId('btn:lockConfirm.confirm')); });
    await waitFor(() => expect(resolved).toBe(true));
    expect(queryByTestId('lock-confirm-pin')).toBeNull();

    let second: boolean | null = null;
    act(() => { void latest!.confirm().then((v) => { second = v; }); });
    await waitFor(() => expect(getByTestId('lock-confirm-pin')).toBeTruthy());
    await act(async () => { fireEvent.press(getByTestId('lock-confirm-cancel')); });
    await waitFor(() => expect(second).toBe(false));
  });
});
