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

// Argon2id (v3 backup format) is intentionally slow, and the pure-JS compute
// runs ~15-20× slower under jest than plain Node — a single 64 MiB derivation
// can take a couple of minutes under CI runner load, and several tests here
// perform two sequential derivations (encrypt + decrypt). The v3 cost is
// version-implied (not env-tunable — see crypto/backup.ts header and the
// "no env-conditional crypto" golden rule), so the only safe lever is the
// test timeout. 300s was marginal and flaked; 600s gives comfortable headroom.
jest.setTimeout(600_000);

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
      // Long, distinctive sentinel: the leak assertion below scans the base64
      // wire form for this string. A short value like 'Anon' collides by chance
      // with random ciphertext bytes (~1/64^4 per position over ~800 chars),
      // which flaked CI. A 12+ char sentinel makes a random collision (~1/64^N)
      // effectively impossible while still proving the profile never leaks.
      displayName: 'Anon-Sentinel-DoNotLeak',
      avatarColor: '#abc',
      avatarImage: null,
      profileStatus: '',
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
  it('round-trips the full payload', async () => {
    const env = await encryptBackup(samplePayload(), PASS);
    expect(isBackupEnvelope(env)).toBe(true);
    const restored = await decryptBackup(env, PASS);
    expect(restored).toEqual(samplePayload());
    expect(restored.identity.secretKeyB64).toBe('c2VjcmV0S2V5QjY0VmVyeVNlY3JldA==');
  });

  it('throws on the wrong passphrase (MAC failure, no silent garbage)', async () => {
    const env = await encryptBackup(samplePayload(), PASS);
    await expect(decryptBackup(env, 'wrong passphrase here!!')).rejects.toThrow();
  });

  it('throws on a tampered ciphertext', async () => {
    const env = await encryptBackup(samplePayload(), PASS);
    const bytes = decodeBase64(env.ciphertext);
    bytes[0] ^= 0x01;
    const tampered = { ...env, ciphertext: encodeBase64(bytes) };
    await expect(decryptBackup(tampered, PASS)).rejects.toThrow();
  });

  it('does not leak private keys in the envelope', async () => {
    const env = await encryptBackup(samplePayload(), PASS);
    const wire = JSON.stringify(env);
    expect(wire).not.toContain('c2VjcmV0S2V5QjY0VmVyeVNlY3JldA==');
    expect(wire).not.toContain('c2lnblNlY3JldFZlcnlTZWNyZXQ=');
    expect(wire).not.toContain('Anon-Sentinel-DoNotLeak');
  });

  it('enforces minimum passphrase length on encrypt', async () => {
    await expect(encryptBackup(samplePayload(), 'short')).rejects.toThrow();
    expect(BACKUP_MIN_PASSPHRASE_LEN).toBeGreaterThanOrEqual(12);
  });

  it('uses a fresh random salt + nonce on each encryption', async () => {
    const a = await encryptBackup(samplePayload(), PASS);
    const b = await encryptBackup(samplePayload(), PASS);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('rejects an unsupported version on decrypt', async () => {
    const env = await encryptBackup(samplePayload(), PASS);
    await expect(decryptBackup({ ...env, v: 99 as typeof BACKUP_VERSION }, PASS)).rejects.toThrow();
  });

  it('rates passphrase strength sensibly', () => {
    expect(ratePassphrase('short')).toBe('too_short');
    expect(ratePassphrase('A'.repeat(20) + 'a1')).toBe('strong');
    expect(isBackupEnvelope({ foo: 'bar' })).toBe(false);
  });
});
