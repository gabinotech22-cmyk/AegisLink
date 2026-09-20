/**
 * DataExportScreen — the plaintext export file's lifecycle.
 *
 * It used to be written to documentDirectory and never removed: a clear copy
 * of the whole history sitting next to the encrypted DB forever. Verifies the
 * file goes to the cache directory, is shared, and is deleted afterwards —
 * also when sharing fails.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockWrite = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockShare = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///docs/',
  writeAsStringAsync: (...a: unknown[]) => mockWrite(...a),
  deleteAsync: (...a: unknown[]) => mockDelete(...a),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn().mockResolvedValue(true), shareAsync: (...a: unknown[]) => mockShare(...a) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: string) => (typeof d === 'string' ? d : k) }) }));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa', textFaint: '#666', accent: '#05b875', accentInk: '#000',
      danger: '#e63946', warn: '#f59e0b', border: '#222', borderStrong: '#333', divider: '#1a1a1a', radius: 12, radiusS: 8, radiusL: 20,
      font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));
jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/TopBar', () => ({ TopBar: () => null }));
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
jest.mock('../../components/Section', () => {
  const React = require('react') as typeof import('react');
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    Section: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Toggle: ({ label }: { label: string }) => React.createElement(Text, null, label),
  };
});
jest.mock('../../components/Button', () => {
  const React = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  return { PrimaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => React.createElement(Pressable, { onPress }, React.createElement(Text, null, label)) };
});
jest.mock('../../store/identity', () => ({ useIdentity: () => ({ identity: { aegisId: 'ME' }, reset: jest.fn() }) }));
jest.mock('../../store/contacts', () => ({ useContacts: () => ({ contacts: [{ aegisId: 'AAA-BBBB-CCCC', name: 'Carmen', verified: true }] }) }));
jest.mock('../../store/groups', () => ({ useGroups: (sel: (s: { groups: unknown[] }) => unknown) => sel({ groups: [] }) }));
jest.mock('../../store/preferences', () => ({ usePreferences: (sel: (s: Record<string, boolean>) => unknown) => sel({ readReceipts: true, typingIndicator: true, blockScreenshots: false }) }));
jest.mock('../../db/local', () => ({
  loadMessagesByChat: jest.fn().mockResolvedValue([{ id: 'm1', direction: 'in', body: 'hola', createdAt: 1 }]),
}));

import { DataExportScreen } from '../DataExport';

describe('DataExportScreen — file lifecycle', () => {
  beforeEach(() => { mockWrite.mockClear(); mockDelete.mockClear(); mockShare.mockClear(); });

  it('writes to the cache dir, shares, then deletes the file', async () => {
    const { getByText } = render(<DataExportScreen onBack={jest.fn()} />);
    fireEvent.press(getByText('Generate file'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalled());
    const uri = mockWrite.mock.calls[0][0] as string;
    expect(uri.startsWith('file:///cache/')).toBe(true);
    expect(mockShare).toHaveBeenCalledWith(uri, expect.objectContaining({ mimeType: 'application/json' }));
    expect(mockDelete).toHaveBeenCalledWith(uri, { idempotent: true });
    expect(mockWrite.mock.calls[0][1]).toContain('hola');
  });

  it('deletes the file even when sharing throws', async () => {
    mockShare.mockRejectedValueOnce(new Error('cancelled'));
    const { getByText } = render(<DataExportScreen onBack={jest.fn()} />);
    fireEvent.press(getByText('Generate file'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalled());
  });
});
