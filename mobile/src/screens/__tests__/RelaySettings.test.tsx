/**
 * RelaySettings — federation F5b (docs/FEDERATION-DESIGN.md D4).
 *
 * The screen is a thin driver over net/relayMigration; what it must guarantee:
 *   - shows the current home (official / own onion / grace window);
 *   - a switch is only offered after a successful "Verify" of a VALID onion —
 *     an invalid one is rejected locally, a failed verify shows the reason;
 *   - the consequences are shown and confirmed before migrateHomeRelay runs;
 *   - "back to the official relay" migrates to null; results/errors surface;
 *   - the user is told HOW to run a relay, with a link to the public guide.
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown> | string) => {
      const vars = typeof opts === 'object' && opts ? opts : {};
      return `${k}${Object.keys(vars).length ? ':' + JSON.stringify(vars) : ''}`;
    },
    i18n: { language: 'en' },
  }),
}));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', border: '#333', text: '#fff', textDim: '#aaa', textFaint: '#888',
      accent: '#05b875', accentInk: '#000', danger: '#f33', warn: '#fa0', radius: 12, radiusS: 8,
      font: 'System', fontMono: 'monospace', fontDisplay: 'System',
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
jest.mock('../../components/Button', () => {
  const React = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  return {
    PrimaryButton: ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) =>
      React.createElement(Pressable, { onPress, disabled, accessibilityState: { disabled: !!disabled }, testID: `btn:${label}` }, React.createElement(Text, null, label)),
  };
});
jest.mock('../../store/identity', () => ({
  useIdentity: (sel: (s: { identity: { aegisId: string } }) => unknown) => sel({ identity: { aegisId: 'ME' } }),
}));

// App-lock confirmation (D4): resolves true unless a test flips it.
const mockLockConfirm = { ok: true };
jest.mock('../../components/LockConfirm', () => ({
  useLockConfirm: () => ({ confirm: async () => mockLockConfirm.ok, element: null }),
}));

const mockHome = { official: true, onion: null as string | null, since: 0, previous: null as { onion: string | null; until: number } | null };
const mockVerify = jest.fn();
const mockMigrate = jest.fn();
jest.mock('../../net/relayMigration', () => ({
  describeHome: () => ({ ...mockHome }),
  verifyRelay: (...a: unknown[]) => mockVerify(...a),
  migrateHomeRelay: (...a: unknown[]) => mockMigrate(...a),
}));

import { RelaySettingsScreen, SELFHOST_GUIDE_URL } from '../RelaySettings';

const MINE = 'm'.repeat(56) + '.onion';

describe('RelaySettingsScreen (F5b)', () => {
  beforeEach(() => {
    mockHome.official = true; mockHome.onion = null; mockHome.since = 0; mockHome.previous = null;
    mockVerify.mockReset(); mockMigrate.mockReset();
    mockLockConfirm.ok = true;
  });

  it('with the app lock on, a refused PIN/biometric confirmation cancels the change (D4)', async () => {
    mockHome.official = false; mockHome.onion = MINE;
    mockLockConfirm.ok = false;
    const { getByTestId, queryByTestId } = render(<RelaySettingsScreen onBack={jest.fn()} />);
    fireEvent.press(getByTestId('relay-back-official'));
    await act(async () => { fireEvent.press(getByTestId('btn:relaySettings.confirmCta')); });
    expect(mockMigrate).not.toHaveBeenCalled();
    expect(queryByTestId('relay-consequences')).toBeNull(); // back to idle
  });

  it('explains how to run a relay and opens the public self-hosting guide', () => {
    const { Linking } = require('react-native') as typeof import('react-native');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const { getByTestId, getByText } = render(<RelaySettingsScreen onBack={jest.fn()} />);
    expect(getByTestId('relay-howto')).toBeTruthy();
    for (const k of ['howToTitle', 'howTo1', 'howTo2', 'howTo3']) expect(getByText(`relaySettings.${k}`)).toBeTruthy();
    fireEvent.press(getByTestId('relay-guide-link'));
    expect(open).toHaveBeenCalledWith(SELFHOST_GUIDE_URL);
    expect(SELFHOST_GUIDE_URL).toBe('https://aegis-link.it/selfhost.html');
    open.mockRestore();
  });

  it('shows the official relay by default and no "back to official" action', () => {
    const { getByTestId, queryByTestId } = render(<RelaySettingsScreen onBack={jest.fn()} />);
    expect(getByTestId('relay-current-label').props.children).toBe('relaySettings.officialRelay');
    expect(queryByTestId('relay-current-onion')).toBeNull();
    expect(queryByTestId('relay-back-official')).toBeNull();
    expect(queryByTestId('relay-verify-ok')).toBeNull();
  });

  it('shows a self-hosted home with its onion, the grace window, and the way back', () => {
    mockHome.official = false; mockHome.onion = MINE; mockHome.since = 1_800_000_000_000;
    mockHome.previous = { onion: null, until: 1_800_600_000_000 };
    const { getByTestId } = render(<RelaySettingsScreen onBack={jest.fn()} />);
    expect(getByTestId('relay-current-label').props.children).toBe('relaySettings.ownRelay');
    expect(getByTestId('relay-current-onion').props.children).toBe(MINE);
    expect(String(getByTestId('relay-previous').props.children)).toContain('relaySettings.previousUntil');
    expect(getByTestId('relay-back-official')).toBeTruthy();
  });

  it('rejects an invalid onion locally (no network), surfaces a failed verify, and only a verified relay can be switched to', async () => {
    const { getByTestId, queryByTestId } = render(<RelaySettingsScreen onBack={jest.fn()} />);
    fireEvent.changeText(getByTestId('relay-onion-input'), 'not-an-onion');
    fireEvent.press(getByTestId('btn:relaySettings.verify'));
    expect(getByTestId('relay-verify-error').props.children).toBe('relaySettings.errors.invalid_onion');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(queryByTestId('relay-verify-ok')).toBeNull();

    mockVerify.mockResolvedValueOnce({ ok: false, error: 'not_a_relay' });
    fireEvent.changeText(getByTestId('relay-onion-input'), MINE.toUpperCase() + '  ');
    fireEvent.press(getByTestId('btn:relaySettings.verify'));
    await waitFor(() => expect(getByTestId('relay-verify-error').props.children).toBe('relaySettings.errors.not_a_relay'));
    expect(mockVerify).toHaveBeenCalledWith({ onion: MINE }); // trimmed + lower-cased
    expect(queryByTestId('relay-verify-ok')).toBeNull();

    mockVerify.mockResolvedValueOnce({ ok: true, info: { name: 'mine', version: '1.2', features: ['mailbox', 'prekeys'] } });
    fireEvent.press(getByTestId('btn:relaySettings.verify'));
    await waitFor(() => expect(getByTestId('relay-verify-ok')).toBeTruthy());
    expect(mockMigrate).not.toHaveBeenCalled();
  });

  it('switching shows the consequences, migrates only on confirm, and reflects the new home', async () => {
    const { getByTestId, queryByTestId } = render(<RelaySettingsScreen onBack={jest.fn()} />);
    mockVerify.mockResolvedValueOnce({ ok: true, info: { features: ['mailbox', 'prekeys'] } });
    fireEvent.changeText(getByTestId('relay-onion-input'), MINE);
    fireEvent.press(getByTestId('btn:relaySettings.verify'));
    await waitFor(() => expect(getByTestId('relay-verify-ok')).toBeTruthy());

    fireEvent.press(getByTestId(`btn:relaySettings.switchCta:{"relay":"${'m'.repeat(6)}…${'m'.repeat(6)}.onion"}`));
    expect(getByTestId('relay-consequences').props.children).toBe('relaySettings.consequences');
    expect(mockMigrate).not.toHaveBeenCalled();

    // Cancel first: nothing happens.
    fireEvent.press(getByTestId('relay-confirm-cancel'));
    expect(mockMigrate).not.toHaveBeenCalled();
    expect(queryByTestId('relay-consequences')).toBeNull();

    // Confirm: migrate to the verified relay; the screen shows the new home.
    fireEvent.press(getByTestId(`btn:relaySettings.switchCta:{"relay":"${'m'.repeat(6)}…${'m'.repeat(6)}.onion"}`));
    mockMigrate.mockImplementationOnce(async () => { mockHome.official = false; mockHome.onion = MINE; return { ok: true }; });
    await act(async () => { fireEvent.press(getByTestId('btn:relaySettings.confirmCta')); });
    await waitFor(() => expect(getByTestId('relay-migrate-done')).toBeTruthy());
    expect(mockMigrate).toHaveBeenCalledWith({ onion: MINE }, { aegisId: 'ME' });
    expect(getByTestId('relay-current-label').props.children).toBe('relaySettings.ownRelay');
    expect(getByTestId('relay-back-official')).toBeTruthy();
  });

  it('"back to the official relay" migrates to null and surfaces a coded error', async () => {
    mockHome.official = false; mockHome.onion = MINE;
    const { getByTestId } = render(<RelaySettingsScreen onBack={jest.fn()} />);
    fireEvent.press(getByTestId('relay-back-official'));
    mockMigrate.mockResolvedValueOnce({ ok: false, error: 'register_failed', detail: 'HTTP 429' });
    await act(async () => { fireEvent.press(getByTestId('btn:relaySettings.confirmCta')); });
    await waitFor(() => expect(getByTestId('relay-migrate-error')).toBeTruthy());
    expect(mockMigrate).toHaveBeenCalledWith(null, { aegisId: 'ME' });
    expect(String(getByTestId('relay-migrate-error').props.children.join(''))).toContain('relaySettings.errors.register_failed');
    expect(getByTestId('relay-current-label').props.children).toBe('relaySettings.ownRelay'); // unchanged
  });
});
