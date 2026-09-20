/**
 * db:search-messages — what a hit may match and show. Parity with mobile
 * db/messages.ts searchableText: typed text as is, a file attachment by its
 * NAME only, every other wire tag (media reference with the blob key, poll,
 * call marker…) → null, so a search can never print a blob key.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('../secureStorage', () => ({ readKeystore: () => ({}), writeKeystore: () => {} }));
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { isPackaged: false, getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));

import { searchableText, SEARCH_RESULT_LIMIT, SEARCH_SCAN_LIMIT } from '../database';

describe('searchableText', () => {
  it('returns typed text, trimmed', () => {
    expect(searchableText('  nos vemos en la plaza ')).toBe('nos vemos en la plaza');
    expect(searchableText('   ')).toBeNull();
  });

  it('exposes only the file name of a file attachment', () => {
    expect(searchableText('[file:plaza-plano.pdf:blob:id:KEY:nonce:token]')).toBe('plaza-plano.pdf');
    expect(searchableText('[file::blob:id:KEY]')).toBeNull();
  });

  it('never matches media / poll / call / view-once wire tags', () => {
    for (const body of [
      '[image:blob:id:KEY:nonce:token]caption',
      '[video:blob:id:KEY:nonce:token]',
      '[audio:5s:blob:id:KEY:nonce:token]',
      '[multi:...]',
      '[poll:{"q":"plaza?"}]',
      '[call:missed]',
      '[viewonce]',
      '[gif:https://x]',
      '[sticker:1]',
      '[location:1,2]',
      '[join_request:x]',
    ]) {
      expect(searchableText(body)).toBeNull();
    }
  });

  it('has sane caps', () => {
    expect(SEARCH_RESULT_LIMIT).toBeGreaterThan(0);
    expect(SEARCH_SCAN_LIMIT).toBeGreaterThan(SEARCH_RESULT_LIMIT);
  });
});
