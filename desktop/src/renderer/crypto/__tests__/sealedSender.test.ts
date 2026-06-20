import { describe, test, expect } from 'vitest';
/**
 * sealedSender.test.ts — desktop sealed-sender v2 outer envelope (Phase 1).
 *
 * Mirrors the server Phase 0 spike tests. Verifies:
 *   - happy-path round-trip recovers payload + authenticated sender `from`
 *   - the wire carries NO sender identity (only ciphertext/nonce/epk)
 *   - a forged `from` (signed by the wrong key) is rejected
 *   - an unknown sender (no signing key resolvable) is rejected
 *   - a tampered ciphertext fails to open
 *   - a wrong recipient cannot open
 *   - a stale timestamp (outside skew window) is rejected
 */

import nacl from 'tweetnacl';

import { sealEnvelope, openEnvelope, SEALED_TS_SKEW_MS } from '../sealedSender';

const NOW = 1_750_000_000_000;

function makeActor() {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return { box, sign };
}

describe('sealed-sender v2 outer envelope (desktop)', () => {
  test('round-trips payload and authenticates the sender', () => {
    const alice = makeActor();
    const bob = makeActor();
    const wire = sealEnvelope(bob.box.publicKey, 'AAA-BBBB-CCCC', alice.sign.secretKey, 'hello bob', NOW);

    // Wire carries no identity.
    expect(Object.keys(wire).sort()).toEqual(['ciphertext', 'epk', 'nonce']);

    const opened = openEnvelope(
      wire,
      bob.box.secretKey,
      (from) => (from === 'AAA-BBBB-CCCC' ? alice.sign.publicKey : null),
      NOW,
    );
    expect(opened).not.toBeNull();
    expect(opened!.from).toBe('AAA-BBBB-CCCC');
    expect(opened!.payload).toBe('hello bob');
  });

  test('rejects a forged sender (signature by the wrong key)', () => {
    const mallory = makeActor();
    const bob = makeActor();
    // Mallory signs but claims to be Alice.
    const wire = sealEnvelope(bob.box.publicKey, 'AAA-BBBB-CCCC', mallory.sign.secretKey, 'spoofed', NOW);
    const alice = makeActor();
    const opened = openEnvelope(
      wire,
      bob.box.secretKey,
      (from) => (from === 'AAA-BBBB-CCCC' ? alice.sign.publicKey : null), // Alice's real key
      NOW,
    );
    expect(opened).toBeNull();
  });

  test('rejects an unknown sender (no signing key on file)', () => {
    const alice = makeActor();
    const bob = makeActor();
    const wire = sealEnvelope(bob.box.publicKey, 'AAA-BBBB-CCCC', alice.sign.secretKey, 'hi', NOW);
    const opened = openEnvelope(wire, bob.box.secretKey, () => null, NOW);
    expect(opened).toBeNull();
  });

  test('rejects a tampered ciphertext', () => {
    const alice = makeActor();
    const bob = makeActor();
    const wire = sealEnvelope(bob.box.publicKey, 'AAA-BBBB-CCCC', alice.sign.secretKey, 'hi', NOW);
    const tampered = { ...wire, ciphertext: wire.ciphertext.slice(0, -2) + (wire.ciphertext.endsWith('AA') ? 'BB' : 'AA') };
    const opened = openEnvelope(tampered, bob.box.secretKey, () => alice.sign.publicKey, NOW);
    expect(opened).toBeNull();
  });

  test('a wrong recipient cannot open', () => {
    const alice = makeActor();
    const bob = makeActor();
    const eve = makeActor();
    const wire = sealEnvelope(bob.box.publicKey, 'AAA-BBBB-CCCC', alice.sign.secretKey, 'hi', NOW);
    const opened = openEnvelope(wire, eve.box.secretKey, () => alice.sign.publicKey, NOW);
    expect(opened).toBeNull();
  });

  test('rejects a stale timestamp outside the skew window', () => {
    const alice = makeActor();
    const bob = makeActor();
    const wire = sealEnvelope(bob.box.publicKey, 'AAA-BBBB-CCCC', alice.sign.secretKey, 'hi', NOW);
    const opened = openEnvelope(wire, bob.box.secretKey, () => alice.sign.publicKey, NOW + SEALED_TS_SKEW_MS + 1);
    expect(opened).toBeNull();
  });
});
