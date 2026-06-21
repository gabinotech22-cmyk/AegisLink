/**
 * BackupScreen — unit tests (B-4: critical screens without coverage)
 *
 * Verifies the encrypted-backup security flows:
 *  1.  Renders title + live DB stats
 *  2.  Recovery phrase is masked until revealed
 *  3.  "Create backup" with no identity warns; with identity opens the modal
 *  4.  confirmBackup is gated: too-short passphrase and mismatch are blocked
 *  5.  A valid passphrase encrypts and exports the backup, stamping lastAt
 *  6.  Mnemonic restore rejects an input that isn't exactly 32 words
 */

import React from 'react';

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../../components/AlertHost';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa',
      textFaint: '#666', accent: '#05b875', accentDeep: '#0a2e1e', accentInk: '#000',
      danger: '#e63946', warn: '#f59e0b', border: '#222', borderStrong: '#333',
      divider: '#1a1a1a', radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace',
      fontDisplay: 'System',
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

jest.mock('../../components/Section', () => {
  const React = require('react') as typeof import('react');
  const { View, Text } = require('react-native') as typeof import('react-native');
  return {
    Stat: ({ label, val }: { label: string; val: string }) =>
      React.createElement(View, null, React.createElement(Text, null, `${label}:${val}`)),
  };
});

jest.mock('../../components/Button', () => {
  const React = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  const Btn = ({ label, onPress }: { label: string; onPress?: () => void }) =>
    React.createElement(Pressable, { onPress }, React.createElement(Text, null, label));
  return { PrimaryButton: Btn, GhostButton: Btn };
});

// ── expo file system ────────────────────────────────────────────────────────
const mockFileWrite = jest.fn();
const mockFileCreate = jest.fn();
jest.mock('expo-file-system', () => ({
  Paths: { cache: '/cache' },
  File: class {
    uri = '/cache/backup.aegis';
    create = mockFileCreate;
    write = mockFileWrite;
    text = jest.fn().mockResolvedValue('{}');
    constructor(..._args: unknown[]) {}
  },
}));

const mockShareAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: (...a: unknown[]) => mockShareAsync(...a),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true, assets: [] }),
}));

// ── secure store ────────────────────────────────────────────────────────────
const mockSsSet = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(null),
    set: (...a: unknown[]) => mockSsSet(...a),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── crypto/backup ───────────────────────────────────────────────────────────
const mockEncryptBackup = jest.fn().mockResolvedValue({ v: 1, ct: 'cipher' });
jest.mock('../../crypto/backup', () => ({
  encryptBackup: (...a: unknown[]) => mockEncryptBackup(...a),
  decryptBackup: jest.fn(),
  ratePassphrase: () => 'strong',
  isBackupEnvelope: () => true,
  BACKUP_FILE_EXTENSION: 'aegis',
  BACKUP_MIN_PASSPHRASE_LEN: 8,
  BACKUP_VERSION: 1,
}));

// ── wordlist (256 words) + identity/db helpers ──────────────────────────────
jest.mock('../../crypto/wordlist', () => ({
  WORDLIST_256: Array.from({ length: 256 }, (_, i) => `w${i}`),
}));
jest.mock('../../crypto/identity', () => ({ identityFromStored: jest.fn() }));
jest.mock('../../db/local', () => ({ saveIdentity: jest.fn(), saveContact: jest.fn() }));

// ── stores ──────────────────────────────────────────────────────────────────
const mockIdentityValue: {
  identity: Record<string, unknown> | null;
  displayName: string;
  avatarColor: string;
  avatarImage: string | null;
  profileStatus: string;
  hydrate: jest.Mock;
} = {
  identity: {
    aegisId: 'AEGIS-7QX',
    publicKeyB64: 'pub',
    secretKey: new Uint8Array([0, 1, 2]),
    secretKeyB64: 'sec',
    signingPublicKeyB64: 'spub',
    signingSecretKeyB64: 'ssec',
    createdAt: 1_700_000_000_000,
  },
  displayName: 'Alice',
  avatarColor: '#05b875',
  avatarImage: null,
  profileStatus: '',
  hydrate: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../store/identity', () => ({
  useIdentity: () => mockIdentityValue,
}));
jest.mock('../../store/contacts', () => ({
  useContacts: () => ({ contacts: [], hydrate: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../../store/groups', () => ({ useGroups: () => ({ groups: [] }) }));
jest.mock('../../store/messages', () => ({
  useMessages: (sel: (s: { byChat: Record<string, unknown[]> }) => unknown) => sel({ byChat: {} }),
}));

import { BackupScreen } from '../Backup';

describe('BackupScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEncryptBackup.mockResolvedValue({ v: 1, ct: 'cipher' });
    mockIdentityValue.identity = {
      aegisId: 'AEGIS-7QX', publicKeyB64: 'pub', secretKey: new Uint8Array([0, 1, 2]),
      secretKeyB64: 'sec', signingPublicKeyB64: 'spub', signingSecretKeyB64: 'ssec',
      createdAt: 1_700_000_000_000,
    };
  });

  it('renders the title and live DB stats', () => {
    const { getByText } = render(<BackupScreen onBack={jest.fn()} />);
    expect(getByText('backup.title')).toBeTruthy();
    expect(getByText('0 messages')).toBeTruthy();
  });

  it('masks the recovery phrase until revealed', () => {
    const { getByText, queryByText } = render(<BackupScreen onBack={jest.fn()} />);
    // masked initially — derived mnemonic words are not shown
    expect(queryByText('w0 w1 w2')).toBeNull();
    fireEvent.press(getByText('backup.reveal'));
    expect(getByText('w0 w1 w2')).toBeTruthy();
  });

  it('warns when creating a backup with no identity', () => {
    mockIdentityValue.identity = null;
    const alertSpy = themedAlert as jest.Mock;
    const { getByText } = render(<BackupScreen onBack={jest.fn()} />);
    fireEvent.press(getByText('backup.createBtn'));
    expect(alertSpy).toHaveBeenCalledWith('backup.noIdentity', 'backup.generateFirst');
  });

  it('blocks a too-short passphrase and a mismatch', async () => {
    const alertSpy = themedAlert as jest.Mock;
    const { getByText, getByPlaceholderText } = render(<BackupScreen onBack={jest.fn()} />);
    fireEvent.press(getByText('backup.createBtn')); // opens modal

    // too short
    fireEvent.changeText(getByPlaceholderText('backup.passphraseLabel'), 'short');
    fireEvent.changeText(getByPlaceholderText('backup.confirmPass'), 'short');
    fireEvent.press(getByText('Encrypt & export'));
    expect(alertSpy).toHaveBeenCalledWith('backup.passphraseTooShort', expect.any(String));
    expect(mockEncryptBackup).not.toHaveBeenCalled();

    // long enough but mismatched
    fireEvent.changeText(getByPlaceholderText('backup.passphraseLabel'), 'longenough1');
    fireEvent.changeText(getByPlaceholderText('backup.confirmPass'), 'different123');
    fireEvent.press(getByText('Encrypt & export'));
    expect(alertSpy).toHaveBeenCalledWith('backup.passphraseMismatch', expect.any(String));
    expect(mockEncryptBackup).not.toHaveBeenCalled();
  });

  it('encrypts and exports the backup with a valid passphrase', async () => {
    const { getByText, getByPlaceholderText } = render(<BackupScreen onBack={jest.fn()} />);
    fireEvent.press(getByText('backup.createBtn'));

    fireEvent.changeText(getByPlaceholderText('backup.passphraseLabel'), 'a-strong-pass');
    fireEvent.changeText(getByPlaceholderText('backup.confirmPass'), 'a-strong-pass');
    await act(async () => {
      fireEvent.press(getByText('Encrypt & export'));
    });

    await waitFor(() => expect(mockEncryptBackup).toHaveBeenCalledTimes(1));
    expect(mockEncryptBackup).toHaveBeenCalledWith(expect.any(Object), 'a-strong-pass');
    expect(mockFileWrite).toHaveBeenCalled();
    await waitFor(() => expect(mockShareAsync).toHaveBeenCalled());
    expect(mockSsSet).toHaveBeenCalledWith('aegis.backup.lastAt', expect.any(String));
  });

  it('rejects a mnemonic that is not exactly 32 words', () => {
    const alertSpy = themedAlert as jest.Mock;
    const { getByText, getByPlaceholderText } = render(<BackupScreen onBack={jest.fn()} />);
    fireEvent.press(getByText('backup.restorePhraseBtn')); // reveal restore box
    fireEvent.changeText(getByPlaceholderText('backup.mnemonicPlaceholder'), 'w0 w1 w2');
    fireEvent.press(getByText('backup.importPhrase'));
    expect(alertSpy).toHaveBeenCalledWith('backup.invalidMnemonic', 'backup.mnemonicExactly32');
  });
});
