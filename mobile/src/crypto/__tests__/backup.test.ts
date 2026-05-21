/**
 * backup.test.ts — encrypted backup encrypt/decrypt round-trip (crypto/backup.ts).
 *
 * Covers:
 *   - round-trip restores the exact payload (incl. private keys)
 *   - wrong passphrase fails the MAC (throws, never returns garbage)
 *   - a tampered ciphertext fails the MAC
 *   - the envelope leaks no plaintext (private keys not present in wire form)
 *   - passphrase length is enforced; rating helper behaves
 *   - each encryption uses a fresh random salt + nonce (never reused)
 */

import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import {
  encryptBackup,
  decryptBackup,
  isBackupEnvelope,
  ratePassphrase,
  BACKUP_VERSION,
  BACKUP_MIN_PASSPHRASE_LEN,
  type BackupPayload,
} from '../backup';

function samplePayload(): BackupPayload {
  return {
    v: BACKUP_VERSION,
    createdAt: 1_700_000_000_000,
    identity: {
      aegisId: 'ABC-2345-6789',
      publicKeyB64: 'cHVibGljS2V5QjY0',
      secretKeyB64: 'c2VjcmV0S2V5QjY0VmVyeVNlY3JldA==',
      signingPublicKeyB64: 'c2lnblB1Yg==',
      signingSecretKeyB64: 'c2lnblNlY3JldFZlcnlTZWNyZXQ=',
      createdAt: 1_700_000_000_000,
    },
    profile: {
      activeProfile: 'personal',
      displayName: 'Anon',
      avatarColor: '#abc',
      avatarImage: null,
      profileStatus: '',
      workDisplayName: '',
      workAvatarColor: '#def',
      workAvatarImage: null,
      workProfileStatus: '',
    },
    contacts: [
      {
        aegisId: 'XYZ-1111-2222',
        publicKeyB64: 'Y29udGFjdFB1Yg==',
        name: 'Bob',
        verified: true,
        addedAt: 1_700_000_000_001,
      },
    ],
  };
}

const PASS = 'correct horse battery staple 9!';

describe('encrypted backup', () => {
  it('round-trips the full payload', () => {
    const env = encryptBackup(samplePayload(), PASS);
    expect(isBackupEnvelope(env)).toBe(true);
    const restored = decryptBackup(env, PASS);
    expect(restored).toEqual(samplePayload());
    expect(restored.identity.secretKeyB64).toBe('c2VjcmV0S2V5QjY0VmVyeVNlY3JldA==');
  });

  it('throws on the wrong passphrase (MAC failure, no silent garbage)', () => {
    const env = encryptBackup(samplePayload(), PASS);
    expect(() => decryptBackup(env, 'wrong passphrase here!!')).toThrow();
  });

  it('throws on a tampered ciphertext', () => {
    const env = encryptBackup(samplePayload(), PASS);
    const bytes = decodeBase64(env.ciphertext);
    bytes[0] ^= 0x01;
    const tampered = { ...env, ciphertext: encodeBase64(bytes) };
    expect(() => decryptBackup(tampered, PASS)).toThrow();
  });

  it('does not leak private keys in the envelope', () => {
    const env = encryptBackup(samplePayload(), PASS);
    const wire = JSON.stringify(env);
    expect(wire).not.toContain('c2VjcmV0S2V5QjY0VmVyeVNlY3JldA==');
    expect(wire).not.toContain('c2lnblNlY3JldFZlcnlTZWNyZXQ=');
    expect(wire).not.toContain('Anon');
  });

  it('enforces minimum passphrase length on encrypt', () => {
    expect(() => encryptBackup(samplePayload(), 'short')).toThrow();
    expect(BACKUP_MIN_PASSPHRASE_LEN).toBeGreaterThanOrEqual(12);
  });

  it('uses a fresh random salt + nonce on each encryption', () => {
    const a = encryptBackup(samplePayload(), PASS);
    const b = encryptBackup(samplePayload(), PASS);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('rejects an unsupported version on decrypt', () => {
    const env = encryptBackup(samplePayload(), PASS);
    expect(() => decryptBackup({ ...env, v: 99 as typeof BACKUP_VERSION }, PASS)).toThrow();
  });

  it('rates passphrase strength sensibly', () => {
    expect(ratePassphrase('short')).toBe('too_short');
    expect(ratePassphrase('A'.repeat(20) + 'a1')).toBe('strong');
    expect(isBackupEnvelope({ foo: 'bar' })).toBe(false);
  });
});
