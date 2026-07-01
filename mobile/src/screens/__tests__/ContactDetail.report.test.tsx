/**
 * ContactDetailScreen — abuse report regression tests
 *
 * Guards App Store Guideline 1.2 (UGC moderation): a user must be able to
 * REPORT an abusive contact, not only block them. Verifies:
 *   1. A "Report" row is rendered.
 *   2. Pressing it opens the report/block confirm dialog.
 *   3. Confirming blocks the contact AND opens the reporter's mail client
 *      (mailto: — nothing hits the relay, preserving zero-metadata).
 *   4. When no mail client exists, the contact is still blocked and a
 *      fallback dialog is shown (fail-safe: report intent never silently drops).
 */

import React from 'react';

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../../components/AlertHost';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// t() echoes the key, appending params so we can assert interpolation reached it.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}:${JSON.stringify(opts)}` : k,
  }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa',
      textFaint: '#666', accent: '#05b875', danger: '#e63946', warn: '#f59e0b',
      border: '#222', borderStrong: '#333', divider: '#1a1a1a',
      radius: 12, radiusS: 8, radiusL: 20, font: 'System', fontMono: 'monospace',
      fontDisplay: 'System', dark: true,
    },
  }),
}));

// Any icon → no-op component.
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));

jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => {
    const React = require('react') as typeof import('react');
    const { Text } = require('react-native') as typeof import('react-native');
    return React.createElement(Text, null, title);
  },
}));

// Minimal Section/Row: expose label as pressable text so we can target rows.
jest.mock('../../components/Section', () => {
  const React = require('react') as typeof import('react');
  const { Text, Pressable } = require('react-native') as typeof import('react-native');
  return {
    Section: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Row: ({ label, onPress }: { label: string; onPress?: () => void }) =>
      React.createElement(Pressable, { onPress }, React.createElement(Text, null, label)),
    Toggle: ({ label }: { label: string }) => React.createElement(Text, null, label),
  };
});

jest.mock('../../components/WallpaperPicker', () => ({
  WallpaperPicker: () => null,
  loadWallpaper: jest.fn().mockResolvedValue(0),
  WALLPAPER_NAMES: ['None'],
}));

jest.mock('../../crypto/fingerprint', () => ({ fingerprintHex: () => [] }));

// ── contacts store ──────────────────────────────────────────────────────────
const mockSetBlocked = jest.fn().mockResolvedValue(undefined);
const mockContact = {
  aegisId: 'AAA-BBBB-CCCC',
  name: 'Mallory',
  publicKeyB64: '',
  addedAt: Date.now(),
  blocked: false,
};
const mockContactsState = {
  contacts: [mockContact],
  muteContact: jest.fn(),
  setZeroTrust: jest.fn(),
  setBlocked: mockSetBlocked,
  removeContact: jest.fn(),
  confirmKeyChange: jest.fn(),
  markVerified: jest.fn(),
};
jest.mock('../../store/contacts', () => ({
  useContacts: (selector?: (s: unknown) => unknown) =>
    selector ? selector(mockContactsState) : mockContactsState,
}));

const mockPrefsState = { mentionsOnlyChats: [] as string[], set: jest.fn() };
jest.mock('../../store/preferences', () => ({
  usePreferences: (selector?: (s: unknown) => unknown) =>
    selector ? selector(mockPrefsState) : mockPrefsState,
}));

// Subject under test — imported AFTER mocks.
import { ContactDetailScreen } from '../ContactDetail';

type ReportButton = { text: string; onPress?: () => void | Promise<void> };

function renderScreen() {
  return render(
    <ContactDetailScreen
      contact={mockContact as never}
      onBack={jest.fn()}
      onChat={jest.fn()}
      onCall={jest.fn()}
      onEphemeral={jest.fn()}
    />
  );
}

/** Pull the report-confirm button's onPress out of the last themedAlert call. */
function reportConfirmOnPress(): () => void | Promise<void> {
  const alertSpy = themedAlert as jest.Mock;
  const buttons = alertSpy.mock.calls.at(-1)?.[2] as ReportButton[];
  const confirm = buttons.find((b) => b.text === 'contactDetail.report');
  if (!confirm?.onPress) throw new Error('report confirm button not found');
  return confirm.onPress;
}

describe('ContactDetailScreen — report abuse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetBlocked.mockResolvedValue(undefined);
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  });

  it('renders a Report row', () => {
    const { getByText } = renderScreen();
    expect(getByText('contactDetail.report')).toBeTruthy();
  });

  it('opens the report/block confirm dialog when pressed', () => {
    const { getByText } = renderScreen();
    fireEvent.press(getByText('contactDetail.report'));
    const alertSpy = themedAlert as jest.Mock;
    expect(alertSpy).toHaveBeenCalledWith(
      'contactDetail.reportTitle',
      expect.stringContaining('contactDetail.reportDesc'),
      expect.any(Array)
    );
  });

  it('blocks the contact and opens the mail client on confirm', async () => {
    const { getByText } = renderScreen();
    fireEvent.press(getByText('contactDetail.report'));
    await reportConfirmOnPress()();

    await waitFor(() => {
      expect(mockSetBlocked).toHaveBeenCalledWith('AAA-BBBB-CCCC', true);
    });
    expect(Linking.openURL).toHaveBeenCalledWith(
      expect.stringContaining('mailto:aegislink.report@gmail.com')
    );
  });

  it('still blocks and shows a fallback when no mail client exists', async () => {
    (Linking.canOpenURL as jest.Mock).mockResolvedValue(false);
    const alertSpy = themedAlert as jest.Mock;
    const { getByText } = renderScreen();
    fireEvent.press(getByText('contactDetail.report'));
    await reportConfirmOnPress()();

    await waitFor(() => {
      expect(mockSetBlocked).toHaveBeenCalledWith('AAA-BBBB-CCCC', true);
    });
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'contactDetail.reportNoMailTitle',
      expect.stringContaining('contactDetail.reportNoMailDesc')
    );
  });
});
