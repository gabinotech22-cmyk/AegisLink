/**
 * Regression test for golden rule #1 — "el cifrado nunca degrada en silencio".
 *
 * decryptBody (DISPLAY path) may return a VISIBLE marker on failure, but the
 * KEY-MATERIAL path (decryptSecretOrNull, used by ratchet state + prekey
 * secrets) MUST fail closed by returning null — never the sentinel string, which
 * would otherwise be parsed/decoded into garbage key material.
 *
 * Mirrors the SecureStore/expo mock setup from outbox.db.test.ts so db/local.ts
 * loads with a deterministic at-rest key.
 */

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  SQLiteDatabase: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

const SENTINEL = '[DECRYPTION_ERROR]';

type LocalModule = typeof import('../local');

function freshLocal(): LocalModule {
  jest.resetModules();
  jest.clearAllMocks();
  const utils = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  utils.ss.get.mockResolvedValue(mockFixedKeyB64);
  return require('../local') as LocalModule;
}

describe('at-rest decryption fail-closed semantics', () => {
  it('round-trips a value through encryptBody/decryptBody/decryptSecretOrNull', async () => {
    const { encryptBody, decryptBody, decryptSecretOrNull } = freshLocal();
    const plaintext = 'ratchet-state-or-secret-key-material';
    const enc = await encryptBody(plaintext);
    expect(enc.startsWith('encv1:')).toBe(true);
    expect(await decryptBody(enc)).toBe(plaintext);
    expect(await decryptSecretOrNull(enc)).toBe(plaintext);
  });

  it('decryptSecretOrNull returns null (NOT the sentinel) on a corrupt envelope', async () => {
    const { decryptSecretOrNull } = freshLocal();
    const result = await decryptSecretOrNull('encv1:not-valid-json');
    expect(result).toBeNull();
    expect(result).not.toBe(SENTINEL);
  });

  it('decryptSecretOrNull returns null on an authentication (MAC) failure', async () => {
    // Encrypt under the real key, then tamper with the ciphertext so the
    // Poly1305 MAC check fails on open.
    const { encryptBody, decryptSecretOrNull } = freshLocal();
    const enc = await encryptBody('secret');
    const json = JSON.parse(enc.slice('encv1:'.length)) as { ct: string; n: string };
    const tamperedCt = json.ct.slice(0, -4) + (json.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const tampered = 'encv1:' + JSON.stringify({ ct: tamperedCt, n: json.n });
    const result = await decryptSecretOrNull(tampered);
    expect(result).toBeNull();
  });

  it('decryptBody (display path) still returns a VISIBLE marker on failure', async () => {
    const { decryptBody } = freshLocal();
    // Display path keeps the legacy sentinel so existing UI checks
    // (GroupPosts, scheduledMessages) keep working — it is a visible error
    // indicator, never fabricated plaintext.
    expect(await decryptBody('encv1:not-valid-json')).toBe(SENTINEL);
  });

  it('passes through non-encrypted (no encv1: prefix) values unchanged', async () => {
    const { decryptBody, decryptSecretOrNull } = freshLocal();
    expect(await decryptBody('plain')).toBe('plain');
    expect(await decryptSecretOrNull('plain')).toBe('plain');
  });
});
