/**
 * PrivacyScreen — unit tests (B-4: critical screens without coverage)
 *
 * Verifies:
 *  1.  Renders title + identity card (displayName, aegisId)
 *  2.  Identity card routes to 'profile'
 *  3.  Nav rows route to the right onNav target
 *  4.  Data-sharing toggles persist the inverted value via preferences.set
 *  5.  requireGroupApproval toggle persists
 *  6.  Tor toggle persists and reconnects the socket
 *  7.  Theme mode picker calls setDark / setAutoMode
 *  8.  Language picker calls setLocale
 *  9.  Security-audit and PQ-status rows raise an informational alert
 * 10.  Privacy-policy and terms rows open the public legal URLs
 */

import React from 'react';

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../../components/AlertHost';
import { render, fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// ── locale hook ─────────────────────────────────────────────────────────────
const mockSetLocale = jest.fn();
jest.mock('../../i18n/useLocale', () => ({
  useLocale: () => ({ locale: 'en', setLocale: mockSetLocale }),
}));

// ── theme ───────────────────────────────────────────────────────────────────
const mockSetDark = jest.fn();
const mockSetAutoMode = jest.fn();
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa',
      textFaint: '#666', accent: '#05b875', accentInk: '#000', danger: '#e63946',
      border: '#222', borderStrong: '#333', divider: '#1a1a1a',
      radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace', fontDisplay: 'System',
      dark: true,
    },
    setDark: mockSetDark,
    autoMode: false,
    setAutoMode: mockSetAutoMode,
  }),
}));

jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../../components/TabBar', () => ({ TabBar: () => null }));

jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => {
    const React = require('react') as typeof import('react');
    const { Text } = require('react-native') as typeof import('react-native');
    return React.createElement(Text, null, title);
  },
}));

jest.mock('../../components/Section', () => {
  const React = require('react') as typeof import('react');
  const { View, Text, Pressable } = require('react-native') as typeof import('react-native');
  return {
    Section: ({ label, children }: { label?: string; children?: import('react').ReactNode }) =>
      React.createElement(View, null, label ? React.createElement(Text, null, label) : null, children),
    Row: ({ label, onPress }: { label: string; onPress?: () => void }) =>
      React.createElement(Pressable, { onPress }, React.createElement(Text, null, label)),
    Toggle: ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) =>
      React.createElement(Pressable, { onPress: () => onChange(!value) }, React.createElement(Text, null, label)),
  };
});

// ── socket client (tor toggle reconnect) ────────────────────────────────────
const mockDisconnect = jest.fn();
const mockConnect = jest.fn();
jest.mock('../../socket/client', () => ({
  disconnect: mockDisconnect,
  connect: mockConnect,
}));

// ── identity store: supports both useIdentity() and useIdentity(selector) ────
const mockIdentityState = {
  identity: { aegisId: 'AEGIS-7QX', publicKeyB64: 'pub' },
  displayName: 'Alice',
  avatarColor: '#05b875',
  avatarImage: null as string | null,
};
jest.mock('../../store/identity', () => ({
  useIdentity: (sel?: (s: typeof mockIdentityState) => unknown) =>
    sel ? sel(mockIdentityState) : mockIdentityState,
}));

// ── preferences store ───────────────────────────────────────────────────────
const mockSetPref = jest.fn();
const mockPrefs: Record<string, unknown> = {
  hydrated: true,
  hydrate: jest.fn(),
  readReceipts: true,
  typingIndicator: true,
  blockScreenshots: false,
  routeViaTor: false,
  hideCallIp: true,
  requireGroupApproval: false,
  set: mockSetPref,
};
jest.mock('../../store/preferences', () => ({
  usePreferences: (sel: (s: Record<string, unknown>) => unknown) => sel(mockPrefs),
}));

// ── security diagnostics store ──────────────────────────────────────────────
const mockSecDiag: Record<string, unknown> = {
  pqDowngradeFallbacks: 0,
  lastPqDowngradeAt: null,
  hydrate: jest.fn(),
  hydrated: true,
};
jest.mock('../../store/securityDiagnostics', () => ({
  useSecurityDiagnostics: (sel: (s: Record<string, unknown>) => unknown) => sel(mockSecDiag),
}));

import { PrivacyScreen } from '../Privacy';

function makeProps() {
  return { onTab: jest.fn(), onNav: jest.fn() };
}

describe('PrivacyScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrefs.readReceipts = true;
    mockPrefs.typingIndicator = true;
    mockPrefs.blockScreenshots = false;
    mockPrefs.routeViaTor = false;
    mockPrefs.requireGroupApproval = false;
  });

  it('renders the title and identity card', () => {
    const { getAllByText, getByText } = render(<PrivacyScreen {...makeProps()} />);
    expect(getAllByText('privacy.title').length).toBeGreaterThanOrEqual(1);
    expect(getByText('Alice')).toBeTruthy();
    expect(getByText('AEGIS-7QX')).toBeTruthy();
  });

  it('routes the identity card to the profile screen', () => {
    const props = makeProps();
    const { getByText } = render(<PrivacyScreen {...props} />);
    fireEvent.press(getByText('Alice'));
    expect(props.onNav).toHaveBeenCalledWith('profile');
  });

  it('routes nav rows to the right targets', () => {
    const props = makeProps();
    const { getByText } = render(<PrivacyScreen {...props} />);
    const cases: Array<[string, string]> = [
      ['privacy.encryptedBackup', 'backup'],
      ['privacy.disappearingMessages', 'ephemeral'],
      ['privacy.notifications', 'notifs'],
      ['privacy.yourData', 'export'],
      ['privacy.lockScreen', 'lockConfig'],
      ['privacy.linkedDevices', 'devices'],
      ['privacy.panicMode', 'panic'],
    ];
    for (const [label, target] of cases) {
      fireEvent.press(getByText(label));
      expect(props.onNav).toHaveBeenCalledWith(target);
    }
  });

  it('persists data-sharing toggles with the inverted value', () => {
    const { getByText } = render(<PrivacyScreen {...makeProps()} />);
    fireEvent.press(getByText('privacy.readReceipts'));
    expect(mockSetPref).toHaveBeenCalledWith('readReceipts', false);
    fireEvent.press(getByText('privacy.typingIndicator'));
    expect(mockSetPref).toHaveBeenCalledWith('typingIndicator', false);
    fireEvent.press(getByText('privacy.blockScreenshots'));
    expect(mockSetPref).toHaveBeenCalledWith('blockScreenshots', true);
  });

  it('persists the group-approval toggle', () => {
    const { getByText } = render(<PrivacyScreen {...makeProps()} />);
    fireEvent.press(getByText('privacy.requireGroupApproval'));
    expect(mockSetPref).toHaveBeenCalledWith('requireGroupApproval', true);
  });

  it('persists the Tor toggle and reconnects the socket', () => {
    const { getByText } = render(<PrivacyScreen {...makeProps()} />);
    fireEvent.press(getByText('privacy.torLabel'));
    expect(mockSetPref).toHaveBeenCalledWith('routeViaTor', true);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('changes theme mode via the mode picker', () => {
    const { getByText } = render(<PrivacyScreen {...makeProps()} />);
    fireEvent.press(getByText('privacy.modeLight'));
    expect(mockSetDark).toHaveBeenCalledWith(false);
    fireEvent.press(getByText('privacy.modeDark'));
    expect(mockSetDark).toHaveBeenCalledWith(true);
    fireEvent.press(getByText('privacy.modeAuto'));
    expect(mockSetAutoMode).toHaveBeenCalledWith(true);
  });

  it('changes language via the language picker', () => {
    const { getByText } = render(<PrivacyScreen {...makeProps()} />);
    fireEvent.press(getByText('privacy.languageSpanish'));
    expect(mockSetLocale).toHaveBeenCalledWith('es');
  });

  it('raises informational alerts for audit and PQ-status rows', () => {
    const alertSpy = themedAlert as jest.Mock;
    const { getByText } = render(<PrivacyScreen {...makeProps()} />);
    fireEvent.press(getByText('privacy.securityAudit'));
    expect(alertSpy).toHaveBeenCalledWith('privacy.auditAlert', 'privacy.auditAlertDesc');
    fireEvent.press(getByText('privacy.pqStatus'));
    expect(alertSpy).toHaveBeenCalledWith('privacy.pqStatusAlert', 'privacy.pqStatusAlertOk');
  });

  it('opens the public privacy-policy and terms URLs', () => {
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const { getByText } = render(<PrivacyScreen {...makeProps()} />);
    fireEvent.press(getByText('privacy.privacyPolicy'));
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/gabinotech22-cmyk/AegisLink/blob/main/docs/privacy-policy.md',
    );
    fireEvent.press(getByText('privacy.termsOfService'));
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/gabinotech22-cmyk/AegisLink/blob/main/docs/terms-of-service.md',
    );
    openSpy.mockRestore();
  });
});
