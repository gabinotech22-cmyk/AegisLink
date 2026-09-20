/**
 * ContactDetailScreen — nickname row regression tests.
 *
 * Add Contact offered a "nickname (optional)" that then appeared nowhere: it
 * could not be seen, changed or removed. Verifies:
 *   1. The nickname row shows the current nickname (or "none").
 *   2. Tapping it opens the editor; saving calls setNickname with the new text.
 *   3. "Remove nickname" calls setNickname(null).
 *   4. With a nickname set, the name the contact announces is shown under it.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k}:${JSON.stringify(opts)}` : k),
  }),
}));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa',
      textFaint: '#666', accent: '#05b875', accentInk: '#000', danger: '#e63946', warn: '#f59e0b',
      border: '#222', borderStrong: '#333', divider: '#1a1a1a',
      radius: 12, radiusS: 8, radiusL: 20, font: 'System', fontMono: 'monospace',
      fontDisplay: 'System', dark: true,
    },
  }),
}));
jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../../components/TopBar', () => ({ TopBar: () => null }));
jest.mock('../../components/Section', () => {
  const React = require('react') as typeof import('react');
  const { Text, Pressable } = require('react-native') as typeof import('react-native');
  return {
    Section: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Row: ({ label, sub, onPress, testID }: { label: string; sub?: string; onPress?: () => void; testID?: string }) =>
      React.createElement(Pressable, { onPress, testID }, React.createElement(Text, null, label), sub ? React.createElement(Text, null, sub) : null),
    Toggle: ({ label }: { label: string }) => React.createElement(Text, null, label),
  };
});
jest.mock('../../components/WallpaperPicker', () => ({
  WallpaperPicker: () => null,
  loadWallpaper: jest.fn().mockResolvedValue(0),
  WALLPAPER_NAMES: ['None'],
}));
jest.mock('../../crypto/fingerprint', () => ({ fingerprintHex: () => [] }));

const mockSetNickname = jest.fn().mockResolvedValue(undefined);
let mockContact = {
  aegisId: 'AAA-BBBB-CCCC',
  name: 'Mamá',
  nickname: 'Mamá',
  profileName: 'Carmen García',
  publicKeyB64: '',
  addedAt: Date.now(),
};
const state = () => ({
  contacts: [mockContact],
  muteContact: jest.fn(),
  setZeroTrust: jest.fn(),
  setBlocked: jest.fn(),
  removeContact: jest.fn(),
  confirmKeyChange: jest.fn(),
  markVerified: jest.fn(),
  setNickname: mockSetNickname,
});
jest.mock('../../store/contacts', () => ({
  useContacts: (selector?: (s: unknown) => unknown) => (selector ? selector(state()) : state()),
}));
const mockPrefsState = { mentionsOnlyChats: [] as string[], set: jest.fn() };
jest.mock('../../store/preferences', () => ({
  usePreferences: (selector?: (s: unknown) => unknown) => (selector ? selector(mockPrefsState) : mockPrefsState),
}));

import { ContactDetailScreen } from '../ContactDetail';

function renderScreen() {
  return render(
    <ContactDetailScreen contact={mockContact as never} onBack={jest.fn()} onChat={jest.fn()} onCall={jest.fn()} onEphemeral={jest.fn()} />,
  );
}

describe('ContactDetailScreen — nickname', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContact = { ...mockContact, name: 'Mamá', nickname: 'Mamá', profileName: 'Carmen García' };
  });

  it('shows the nickname on its row and the announced name under the header', () => {
    const { getByTestId, getAllByText } = renderScreen();
    expect(getByTestId('contact-nickname-row')).toBeTruthy();
    // header + row
    expect(getAllByText('Mamá').length).toBe(2);
    expect(getByTestId('contact-profile-name').props.children.join('')).toBe('~Carmen García');
  });

  it('shows "none" and no announced-name line when there is no nickname', () => {
    mockContact = { ...mockContact, name: 'Carmen García', nickname: null as unknown as string };
    const { getByText, queryByTestId } = renderScreen();
    expect(getByText('contactDetail.nicknameNone')).toBeTruthy();
    expect(queryByTestId('contact-profile-name')).toBeNull();
  });

  it('saves an edited nickname', () => {
    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('contact-nickname-row'));
    fireEvent.changeText(getByTestId('nickname-input'), '  Jefa ');
    fireEvent.press(getByTestId('nickname-save'));
    expect(mockSetNickname).toHaveBeenCalledWith('AAA-BBBB-CCCC', 'Jefa');
  });

  it('removes the nickname', () => {
    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('contact-nickname-row'));
    fireEvent.press(getByTestId('nickname-clear'));
    expect(mockSetNickname).toHaveBeenCalledWith('AAA-BBBB-CCCC', null);
  });
});
