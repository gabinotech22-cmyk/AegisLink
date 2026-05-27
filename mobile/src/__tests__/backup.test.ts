/**
 * Unit tests — Section 10: Encrypted Backup
 *
 * Tests cover:
 *   1. encryptBackup / decryptBackup round-trip (v3 / Argon2id)
 *   2. Wrong passphrase → throws
 *   3. Corrupted ciphertext → throws
 *   4. ratePassphrase strength ladder
 *   5. isBackupEnvelope type-guard (accepts v1, v2, v3; rejects others)
 *   6. backupFileName format
 *   7. Backward compatibility: decryptBackup reads v1 (PBKDF2 100k) and v2
 *      (PBKDF2 600k) envelopes synthesised in-test.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeUTF8 } from 'tweetnacl-util';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

// Argon2id m=64 MiB, t=3 is intentionally slow (H-3 mitigation). A single
// derivation takes ~1–2 s in pure JS, and several tests perform multiple
// round-trips. Raise the per-test timeout to keep CI green.
jest.setTimeout(60_000);

import {
  encryptBackup,
  decryptBackup,
  ratePassphrase,
  isBackupEnvelope,
  BACKUP_FILE_EXTENSION,
  BACKUP_MIN_PASSPHRASE_LEN,
  BACKUP_PBKDF2_ITERATIONS_V1,
  BACKUP_PBKDF2_ITERATIONS_V2,
  BACKUP_KEY_BYTES,
  BACKUP_SALT_BYTES,
  type BackupPayload,
  type BackupEnvelope,
  type PassphraseStrength,
} from '../crypto/backup';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<BackupPayload> = {}): BackupPayload {
  return {
    v: 3,
    createdAt: 1_700_000_000_000,
    identity: {
      aegisId: 'ABC-DEFG-HIJK',
      publicKeyB64: 'cHVibGljS2V5Qjk0', // dummy base64
      secretKeyB64: 'c2VjcmV0S2V5Qjk0',
      signingPublicKeyB64: 'c2lnbmluZ1B1YkI5NA==',
      signingSecretKeyB64: 'c2lnbmluZ1NlY0I5NA==',
      createdAt: 1_700_000_000_000,
    },
    profile: {
      displayName: 'alice',
      avatarColor: '#05b875',
      avatarImage: null,
      profileStatus: '',
    },
    contacts: [
      {
        aegisId: 'BOB-AEGIS-ID0',
        publicKeyB64: 'Ym9iUHVibGljS2V5',
        name: 'Bob',
        verified: true,
        addedAt: 1_700_000_001_000,
      },
    ],
    ...overrides,
  };
}

const STRONG_PASSPHRASE = 'Tr0ub4dor&3-correct-horse-battery-staple';
const SHORT_PASSPHRASE = 'short';

/**
 * Synthesise a legacy v1/v2 envelope using PBKDF2 directly so we can verify
 * that decryptBackup still accepts older formats produced by previous app
 * versions. We bypass encryptBackup intentionally (it always writes v3 today).
 */
function makeLegacyPbkdf2Envelope(
  payload: BackupPayload,
  passphrase: string,
  version: 1 | 2,
): BackupEnvelope {
  const iterations = version === 1 ? BACKUP_PBKDF2_ITERATIONS_V1 : BACKUP_PBKDF2_ITERATIONS_V2;
  const salt = nacl.randomBytes(BACKUP_SALT_BYTES);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const key = pbkdf2(sha256, decodeUTF8(passphrase), salt, {
    c: iterations,
    dkLen: BACKUP_KEY_BYTES,
  });
  const plaintext = decodeUTF8(JSON.stringify(payload));
  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  key.fill(0);
  return {
    v: version,
    salt: encodeBase64(salt),
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('encryptBackup / decryptBackup', () => {
  it('round-trips correctly with a valid passphrase', () => {
    const payload = makePayload();
    const envelope = encryptBackup(payload, STRONG_PASSPHRASE);

    expect(envelope.v).toBe(3);
    expect(typeof envelope.salt).toBe('string');
    expect(typeof envelope.nonce).toBe('string');
    expect(typeof envelope.ciphertext).toBe('string');

    const restored = decryptBackup(envelope, STRONG_PASSPHRASE);
    expect(restored.identity.aegisId).toBe(payload.identity.aegisId);
    expect(restored.contacts).toHaveLength(1);
    expect(restored.contacts[0].name).toBe('Bob');
    expect(restored.profile.displayName).toBe('alice');
  });

  it('preserves all contacts in payload', () => {
    const payload = makePayload({
      contacts: [
        { aegisId: 'AAAA', publicKeyB64: 'AAAA', name: 'Alice', verified: false, addedAt: 1 },
        { aegisId: 'BBBB', publicKeyB64: 'BBBB', name: 'Bob', verified: true, addedAt: 2 },
        { aegisId: 'CCCC', publicKeyB64: 'CCCC', name: 'Carol', verified: false, addedAt: 3 },
      ],
    });
    const envelope = encryptBackup(payload, STRONG_PASSPHRASE);
    const restored = decryptBackup(envelope, STRONG_PASSPHRASE);
    expect(restored.contacts).toHaveLength(3);
    expect(restored.contacts.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('throws on wrong passphrase (MAC mismatch)', () => {
    const envelope = encryptBackup(makePayload(), STRONG_PASSPHRASE);
    expect(() => decryptBackup(envelope, 'WrongPassphrase123!')).toThrow(
      /passphrase|corrupted/i,
    );
  });

  it('throws on corrupted ciphertext', () => {
    const envelope = encryptBackup(makePayload(), STRONG_PASSPHRASE);
    const corrupted = {
      ...envelope,
      ciphertext: envelope.ciphertext.slice(0, -4) + 'AAAA',
    };
    expect(() => decryptBackup(corrupted, STRONG_PASSPHRASE)).toThrow(
      /passphrase|corrupted/i,
    );
  });

  it('throws when passphrase is too short (< BACKUP_MIN_PASSPHRASE_LEN)', () => {
    expect(() => encryptBackup(makePayload(), SHORT_PASSPHRASE)).toThrow(
      /passphrase must be at least/i,
    );
  });

  it('throws on unsupported backup version', () => {
    const envelope = encryptBackup(makePayload(), STRONG_PASSPHRASE);
    const badVersion = { ...envelope, v: 99 as unknown as 1 };
    expect(() => decryptBackup(badVersion, STRONG_PASSPHRASE)).toThrow(
      /unsupported backup version/i,
    );
  });

  it('produces different salts on each call (non-deterministic)', () => {
    const payload = makePayload();
    const e1 = encryptBackup(payload, STRONG_PASSPHRASE);
    const e2 = encryptBackup(payload, STRONG_PASSPHRASE);
    expect(e1.salt).not.toBe(e2.salt);
    expect(e1.nonce).not.toBe(e2.nonce);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });
});

// ─── Backward compatibility (H-3 / Argon2id migration) ────────────────────────

describe('decryptBackup — legacy compatibility', () => {
  it('decrypts a legacy v1 envelope (PBKDF2 100k)', () => {
    const payload = makePayload({ v: 1 });
    const envelope = makeLegacyPbkdf2Envelope(payload, STRONG_PASSPHRASE, 1);
    expect(envelope.v).toBe(1);

    const restored = decryptBackup(envelope, STRONG_PASSPHRASE);
    expect(restored.v).toBe(1);
    expect(restored.identity.aegisId).toBe(payload.identity.aegisId);
    expect(restored.contacts[0].name).toBe('Bob');
  });

  it('decrypts a legacy v2 envelope (PBKDF2 600k)', () => {
    const payload = makePayload({ v: 2 });
    const envelope = makeLegacyPbkdf2Envelope(payload, STRONG_PASSPHRASE, 2);
    expect(envelope.v).toBe(2);

    const restored = decryptBackup(envelope, STRONG_PASSPHRASE);
    expect(restored.v).toBe(2);
    expect(restored.identity.aegisId).toBe(payload.identity.aegisId);
    expect(restored.contacts[0].name).toBe('Bob');
  });

  it('rejects a legacy v2 envelope with the wrong passphrase', () => {
    const envelope = makeLegacyPbkdf2Envelope(makePayload({ v: 2 }), STRONG_PASSPHRASE, 2);
    expect(() => decryptBackup(envelope, 'WrongPassphrase123!')).toThrow(
      /passphrase|corrupted/i,
    );
  });
});

// ─── ratePassphrase ───────────────────────────────────────────────────────────

describe('ratePassphrase', () => {
  const cases: Array<[string, PassphraseStrength]> = [
    ['short', 'too_short'],
    ['shortpassword', 'weak'],          // 13 chars, lowercase only
    ['correct-horse-battery', 'fair'],  // 21 chars, 2 classes (lower + symbol)
    ['Tr0ub4dor&3!CorrectHorse', 'strong'], // 24 chars, all 4 classes
    ['A'.repeat(BACKUP_MIN_PASSPHRASE_LEN - 1), 'too_short'],
    ['A'.repeat(BACKUP_MIN_PASSPHRASE_LEN), 'weak'], // exactly min length, upper only
  ];

  it.each(cases)('rates "%s" as %s', (pw, expected) => {
    expect(ratePassphrase(pw)).toBe(expected);
  });
});

// ─── isBackupEnvelope ─────────────────────────────────────────────────────────

describe('isBackupEnvelope', () => {
  it('accepts a valid v3 envelope (current format)', () => {
    const envelope = encryptBackup(makePayload(), STRONG_PASSPHRASE);
    expect(isBackupEnvelope(envelope)).toBe(true);
  });

  it('accepts a legacy v1 envelope', () => {
    expect(isBackupEnvelope({ v: 1, salt: 'a', nonce: 'b', ciphertext: 'c' })).toBe(true);
  });

  it('accepts a legacy v2 envelope', () => {
    expect(isBackupEnvelope({ v: 2, salt: 'a', nonce: 'b', ciphertext: 'c' })).toBe(true);
  });

  it('rejects null', () => {
    expect(isBackupEnvelope(null)).toBe(false);
  });

  it('rejects unsupported versions', () => {
    expect(isBackupEnvelope({ v: 99, salt: 'a', nonce: 'b', ciphertext: 'c' })).toBe(false);
    expect(isBackupEnvelope({ v: 0, salt: 'a', nonce: 'b', ciphertext: 'c' })).toBe(false);
    expect(isBackupEnvelope({ v: 4, salt: 'a', nonce: 'b', ciphertext: 'c' })).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(isBackupEnvelope({ v: 3, salt: 'a', nonce: 'b' })).toBe(false);
    expect(isBackupEnvelope({ v: 3, salt: 'a', ciphertext: 'c' })).toBe(false);
  });

  it('rejects non-string fields', () => {
    expect(isBackupEnvelope({ v: 3, salt: 42, nonce: 'b', ciphertext: 'c' })).toBe(false);
  });
});

// ─── File extension constant ──────────────────────────────────────────────────

describe('BACKUP_FILE_EXTENSION', () => {
  it('is aegisbak', () => {
    expect(BACKUP_FILE_EXTENSION).toBe('aegisbak');
  });
});
