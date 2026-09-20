/**
 * SearchScreen — message hits come from the DB, not the in-memory store.
 *
 * The screen used to scan `useMessages().byChat`, which only holds the chats
 * opened this session (and after the loadedChats fix, nothing else), showed
 * deleted bodies and printed wire tags. Verifies:
 *   1. Typing a query calls searchMessages (debounced) with that query.
 *   2. Hits render with the chat's name and the message text.
 *   3. A `[file:` hit renders as a file with its name, never the blob part.
 *   4. Clearing the query clears the hits without another DB call.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa', textFaint: '#666',
      accent: '#05b875', accentInk: '#000', danger: '#e63946', warn: '#f59e0b', border: '#222', borderStrong: '#333',
      divider: '#1a1a1a', radius: 12, radiusS: 8, radiusL: 20, font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));
jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../../utils/secureStore', () => ({ ss: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) } }));

const contacts = [{ aegisId: 'AAA-BBBB-CCCC', name: 'Carmen', publicKeyB64: 'k', verified: true, addedAt: 1 }];
jest.mock('../../store/contacts', () => ({ useContacts: () => ({ contacts }) }));
jest.mock('../../store/groups', () => ({ useGroups: () => ({ groups: [] }) }));

const mockSearch = jest.fn();
jest.mock('../../db/messages', () => ({
  searchMessages: (...a: unknown[]) => mockSearch(...a),
  searchableText: jest.requireActual('../../db/messages').searchableText,
}));

import { SearchScreen } from '../Search';

describe('SearchScreen — DB-backed message search', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSearch.mockReset();
    mockSearch.mockResolvedValue([
      { id: 'm1', chatId: 'AAA-BBBB-CCCC', direction: 'in', body: 'nos vemos en la plaza', createdAt: Date.now() },
      { id: 'm2', chatId: 'AAA-BBBB-CCCC', direction: 'out', body: '[file:plaza-plano.pdf:blob:id:KEY:nonce:token]', createdAt: Date.now() },
    ]);
  });
  afterEach(() => jest.useRealTimers());

  it('queries the DB (debounced) and renders text and file hits without wire parts', async () => {
    const { getByPlaceholderText, getByText, queryByText } = render(<SearchScreen onBack={jest.fn()} />);
    fireEvent.changeText(getByPlaceholderText('search.placeholder'), 'plaza');
    expect(mockSearch).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockSearch).toHaveBeenCalledWith('plaza');
    expect(getByText('nos vemos en la plaza')).toBeTruthy();
    expect(getByText('plaza-plano.pdf')).toBeTruthy();
    expect(queryByText(/KEY:nonce/)).toBeNull();

    fireEvent.changeText(getByPlaceholderText('search.placeholder'), '');
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(queryByText('nos vemos en la plaza')).toBeNull();
  });
});
