/**
 * Blind mailbox IDs — sealed-sender Fase 4 spike (off the live path).
 * Pins the security properties the live wiring will later depend on.
 */
import {
  MAILBOX_ID_BYTES,
  MAILBOX_EPOCH_MS,
  generateMailboxRoot,
  epochFor,
  deriveMailbox,
  currentMailbox,
  mailboxAuthProof,
  verifyMailboxAuth,
} from '../mailbox';
import nacl from 'tweetnacl';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('mailbox derivation', () => {
  it('is deterministic for the same root and epoch', () => {
    const root = generateMailboxRoot();
    const a = deriveMailbox(root, 20600);
    const b = deriveMailbox(root, 20600);
    expect(toHex(a.mailboxId)).toBe(toHex(b.mailboxId));
    expect(toHex(a.signPublicKey)).toBe(toHex(b.signPublicKey));
    expect(a.mailboxIdB64).toBe(b.mailboxIdB64);
  });

  it('produces a 16-byte id and a valid Ed25519 keypair', () => {
    const m = deriveMailbox(generateMailboxRoot(), 1);
    expect(m.mailboxId).toHaveLength(MAILBOX_ID_BYTES);
    expect(m.signPublicKey).toHaveLength(32);
    expect(m.signSecretKey).toHaveLength(64);
  });

  it('rotates: a different epoch yields a different, unlinkable mailbox', () => {
    const root = generateMailboxRoot();
    const day1 = deriveMailbox(root, 20600);
    const day2 = deriveMailbox(root, 20601);
    expect(toHex(day1.mailboxId)).not.toBe(toHex(day2.mailboxId));
    expect(toHex(day1.signPublicKey)).not.toBe(toHex(day2.signPublicKey));
  });

  it('is unlinkable across roots: different roots never collide', () => {
    const m1 = deriveMailbox(generateMailboxRoot(), 20600);
    const m2 = deriveMailbox(generateMailboxRoot(), 20600);
    expect(toHex(m1.mailboxId)).not.toBe(toHex(m2.mailboxId));
  });

  it('epochFor buckets time by the rotation period', () => {
    expect(epochFor(0)).toBe(0);
    expect(epochFor(MAILBOX_EPOCH_MS - 1)).toBe(0);
    expect(epochFor(MAILBOX_EPOCH_MS)).toBe(1);
    expect(epochFor(MAILBOX_EPOCH_MS * 20600 + 5)).toBe(20600);
  });

  it('currentMailbox matches deriveMailbox at the current epoch', () => {
    const root = generateMailboxRoot();
    const now = MAILBOX_EPOCH_MS * 20600 + 1234;
    expect(currentMailbox(root, now).mailboxIdB64).toBe(
      deriveMailbox(root, epochFor(now)).mailboxIdB64
    );
  });
});

describe('mailbox possession proof', () => {
  it('a valid proof verifies against the mailbox public key', () => {
    const m = deriveMailbox(generateMailboxRoot(), 20600);
    const challenge = nacl.randomBytes(32);
    const sig = mailboxAuthProof(m.signSecretKey, challenge);
    expect(verifyMailboxAuth(m.signPublicKey, challenge, sig)).toBe(true);
  });

  it('rejects a proof for a different challenge', () => {
    const m = deriveMailbox(generateMailboxRoot(), 20600);
    const sig = mailboxAuthProof(m.signSecretKey, nacl.randomBytes(32));
    expect(verifyMailboxAuth(m.signPublicKey, nacl.randomBytes(32), sig)).toBe(false);
  });

  it('rejects a proof signed by an unrelated mailbox (no impersonation)', () => {
    const challenge = nacl.randomBytes(32);
    const mine = deriveMailbox(generateMailboxRoot(), 20600);
    const attacker = deriveMailbox(generateMailboxRoot(), 20600);
    const forged = mailboxAuthProof(attacker.signSecretKey, challenge);
    expect(verifyMailboxAuth(mine.signPublicKey, challenge, forged)).toBe(false);
  });

  it('rejects malformed key / signature lengths', () => {
    const m = deriveMailbox(generateMailboxRoot(), 20600);
    const challenge = nacl.randomBytes(32);
    const sig = mailboxAuthProof(m.signSecretKey, challenge);
    expect(verifyMailboxAuth(new Uint8Array(31), challenge, sig)).toBe(false);
    expect(verifyMailboxAuth(m.signPublicKey, challenge, new Uint8Array(63))).toBe(false);
  });
});
