import { describe, test, expect } from 'vitest';
/**
 * mailbox.test.ts — blind mailbox IDs, desktop (sealed-sender Fase 4).
 *
 * Parity with mobile/src/crypto/__tests__/mailbox.test.ts. Pins the security
 * properties the live mailbox transport depends on, plus the cross-platform
 * known-answer vector that proves desktop derivation is byte-identical to mobile.
 */
import {
  MAILBOX_ID_BYTES,
  MAILBOX_EPOCH_MS,
  generateMailboxRoot,
  epochFor,
  deriveMailbox,
  currentMailbox,
  mailboxIdForSignPublicKey,
  mailboxAuthProof,
  verifyMailboxAuth,
} from '../mailbox';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('mailbox derivation', () => {
  test('is deterministic for the same root and epoch', () => {
    const root = generateMailboxRoot();
    const a = deriveMailbox(root, 20600);
    const b = deriveMailbox(root, 20600);
    expect(toHex(a.mailboxId)).toBe(toHex(b.mailboxId));
    expect(toHex(a.signPublicKey)).toBe(toHex(b.signPublicKey));
    expect(a.mailboxIdB64).toBe(b.mailboxIdB64);
  });

  test('produces a 16-byte id and a valid Ed25519 keypair', () => {
    const m = deriveMailbox(generateMailboxRoot(), 1);
    expect(m.mailboxId).toHaveLength(MAILBOX_ID_BYTES);
    expect(m.signPublicKey).toHaveLength(32);
    expect(m.signSecretKey).toHaveLength(64);
  });

  test('binds the id to the signing key: mailboxId === SHA256(signPublicKey)[0:16]', () => {
    const m = deriveMailbox(generateMailboxRoot(), 42);
    const expected = sha256(m.signPublicKey).slice(0, MAILBOX_ID_BYTES);
    expect(toHex(m.mailboxId)).toBe(toHex(expected));
    // The relay recomputes the same id from just the (proven) public key.
    expect(mailboxIdForSignPublicKey(m.signPublicKey).mailboxIdB64).toBe(m.mailboxIdB64);
  });

  test('mailboxIdForSignPublicKey is deterministic and key-specific', () => {
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    expect(mailboxIdForSignPublicKey(a.publicKey).mailboxIdB64).toBe(
      mailboxIdForSignPublicKey(a.publicKey).mailboxIdB64
    );
    expect(mailboxIdForSignPublicKey(a.publicKey).mailboxIdB64).not.toBe(
      mailboxIdForSignPublicKey(b.publicKey).mailboxIdB64
    );
  });

  test('rotates: a different epoch yields a different, unlinkable mailbox', () => {
    const root = generateMailboxRoot();
    const day1 = deriveMailbox(root, 20600);
    const day2 = deriveMailbox(root, 20601);
    expect(toHex(day1.mailboxId)).not.toBe(toHex(day2.mailboxId));
    expect(toHex(day1.signPublicKey)).not.toBe(toHex(day2.signPublicKey));
  });

  test('is unlinkable across roots: different roots never collide', () => {
    const m1 = deriveMailbox(generateMailboxRoot(), 20600);
    const m2 = deriveMailbox(generateMailboxRoot(), 20600);
    expect(toHex(m1.mailboxId)).not.toBe(toHex(m2.mailboxId));
  });

  test('epochFor buckets time by the rotation period', () => {
    expect(epochFor(0)).toBe(0);
    expect(epochFor(MAILBOX_EPOCH_MS - 1)).toBe(0);
    expect(epochFor(MAILBOX_EPOCH_MS)).toBe(1);
    expect(epochFor(MAILBOX_EPOCH_MS * 20600 + 5)).toBe(20600);
  });

  test('currentMailbox matches deriveMailbox at the current epoch', () => {
    const root = generateMailboxRoot();
    const now = MAILBOX_EPOCH_MS * 20600 + 1234;
    expect(currentMailbox(root, now).mailboxIdB64).toBe(
      deriveMailbox(root, epochFor(now)).mailboxIdB64
    );
  });

  // CROSS-PLATFORM KNOWN-ANSWER VECTOR. Mobile derives the same constant from
  // this fixed (root, epoch) in its own mailbox.test.ts. If either platform's
  // derivation drifts (hash, slice, base64, HKDF info/salt, epoch encoding), one
  // of the two asserts breaks — catching a silent mobile↔desktop delivery split
  // that random-root tests cannot. DO NOT edit one copy without the other.
  test('matches the pinned cross-platform vector (mobile↔desktop parity)', () => {
    const root = new Uint8Array(32);
    for (let i = 0; i < 32; i++) root[i] = i + 1; // 0x01..0x20
    const m = deriveMailbox(root, 20600);
    expect(m.mailboxIdB64).toBe('+S61uhsiRrHvLHcFZSv/1A==');
  });
});

describe('mailbox possession proof', () => {
  test('a valid proof verifies against the mailbox public key', () => {
    const m = deriveMailbox(generateMailboxRoot(), 20600);
    const challenge = nacl.randomBytes(32);
    const sig = mailboxAuthProof(m.signSecretKey, challenge);
    expect(verifyMailboxAuth(m.signPublicKey, challenge, sig)).toBe(true);
  });

  test('rejects a proof for a different challenge', () => {
    const m = deriveMailbox(generateMailboxRoot(), 20600);
    const sig = mailboxAuthProof(m.signSecretKey, nacl.randomBytes(32));
    expect(verifyMailboxAuth(m.signPublicKey, nacl.randomBytes(32), sig)).toBe(false);
  });

  test('rejects a proof signed by an unrelated mailbox (no impersonation)', () => {
    const challenge = nacl.randomBytes(32);
    const mine = deriveMailbox(generateMailboxRoot(), 20600);
    const attacker = deriveMailbox(generateMailboxRoot(), 20600);
    const forged = mailboxAuthProof(attacker.signSecretKey, challenge);
    expect(verifyMailboxAuth(mine.signPublicKey, challenge, forged)).toBe(false);
  });

  test('rejects malformed key / signature lengths', () => {
    const m = deriveMailbox(generateMailboxRoot(), 20600);
    const challenge = nacl.randomBytes(32);
    const sig = mailboxAuthProof(m.signSecretKey, challenge);
    expect(verifyMailboxAuth(new Uint8Array(31), challenge, sig)).toBe(false);
    expect(verifyMailboxAuth(m.signPublicKey, challenge, new Uint8Array(63))).toBe(false);
  });
});
