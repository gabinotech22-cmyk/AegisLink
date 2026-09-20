/**
 * BlockedContactsScreen — the list "Block" never had. Lists blocked contacts
 * only, unblocks after confirmation, shows an empty state otherwise.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa', textFaint: '#666', accent: '#05b875', accentInk: '#000',
      danger: '#e63946', border: '#222', borderStrong: '#333', divider: '#1a1a1a', radius: 12, radiusS: 8, radiusL: 20,
      font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));
jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/TopBar', () => ({ TopBar: () => null }));
jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../../components/AlertHost';

const mockSetBlocked = jest.fn().mockResolvedValue(undefined);
let mockContacts: Record<string, unknown>[] = [];
jest.mock('../../store/contacts', () => ({
  useContacts: (sel: (s: { contacts: unknown[]; setBlocked: unknown }) => unknown) => sel({ contacts: mockContacts, setBlocked: mockSetBlocked }),
}));

import { BlockedContactsScreen } from '../BlockedContacts';

describe('BlockedContactsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContacts = [
      { aegisId: 'AAA-BBBB-CCCC', name: 'Mallory', publicKeyB64: 'k', verified: false, addedAt: 1, blocked: true },
      { aegisId: 'DDD-EEEE-FFFF', name: 'Alice', publicKeyB64: 'k', verified: true, addedAt: 1, blocked: false },
    ];
  });

  it('lists only blocked contacts', () => {
    const { queryByTestId, getByText, queryByText } = render(<BlockedContactsScreen onBack={jest.fn()} />);
    expect(queryByTestId('blocked-row-AAA-BBBB-CCCC')).toBeTruthy();
    expect(queryByTestId('blocked-row-DDD-EEEE-FFFF')).toBeNull();
    expect(getByText('Mallory')).toBeTruthy();
    expect(queryByText('Alice')).toBeNull();
  });

  it('unblocks after confirmation', () => {
    const { getByTestId } = render(<BlockedContactsScreen onBack={jest.fn()} />);
    fireEvent.press(getByTestId('unblock-AAA-BBBB-CCCC'));
    const buttons = (themedAlert as jest.Mock).mock.calls.at(-1)?.[2] as { text: string; onPress?: () => void }[];
    expect(mockSetBlocked).not.toHaveBeenCalled();
    buttons.find((b) => b.text === 'contactDetail.unblock')!.onPress!();
    expect(mockSetBlocked).toHaveBeenCalledWith('AAA-BBBB-CCCC', false);
  });

  it('shows the empty state when nobody is blocked', () => {
    mockContacts = [];
    const { getByTestId } = render(<BlockedContactsScreen onBack={jest.fn()} />);
    expect(getByTestId('blocked-empty')).toBeTruthy();
  });
});
