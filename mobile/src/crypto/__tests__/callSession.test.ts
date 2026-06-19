/**
 * callSession.test.ts — sealed call session (sealed-sender Phase 2, mobile).
 *
 * Verifies the per-call handshake + symmetric session-key signaling:
 *   - sealCallInvite round-trips offer + authenticated caller `from` + callKey
 *   - the invite wire carries NO caller identity
 *   - both parties derive the SAME callKey
 *   - a forged caller is rejected
 *   - answer/ICE seal+open under callKey round-trips
 *   - a wrong callKey cannot open symmetric signaling
 *   - tampered symmetric ciphertext is rejected
 */

import nacl from 'tweetnacl';

import {
  sealCallInvite,
  openCallInvite,
  sealWithCallKey,
  openWithCallKey,
} from '../callSession';

const NOW = 1_750_000_000_000;

function makeActor() {
  return { box: nacl.box.keyPair(), sign: nacl.sign.keyPair() };
}

describe('sealed call session (mobile)', () => {
  test('invite round-trips offer + authenticated caller, both derive the same key', () => {
    const alice = makeActor();
    const bob = makeActor();
    const { wire, callKey } = sealCallInvite(
      bob.box.publicKey,
      'AAA-BBBB-CCCC',
      alice.sign.secretKey,
      'sdp-offer-blob',
      NOW,
    );

    // Wire carries no caller identity.
    expect(Object.keys(wire).sort()).toEqual(['ciphertext', 'epk', 'nonce']);

    const opened = openCallInvite(
      wire,
      bob.box.secretKey,
      (from) => (from === 'AAA-BBBB-CCCC' ? alice.sign.publicKey : null),
      NOW,
    );
    expect(opened).not.toBeNull();
    expect(opened!.from).toBe('AAA-BBBB-CCCC');
    expect(opened!.offer).toBe('sdp-offer-blob');
    // Both sides hold the identical session key.
    expect(encode(opened!.callKey)).toBe(encode(callKey));
  });

  test('rejects a forged caller (signature by the wrong key)', () => {
    const mallory = makeActor();
    const bob = makeActor();
    const { wire } = sealCallInvite(bob.box.publicKey, 'AAA-BBBB-CCCC', mallory.sign.secretKey, 'x', NOW);
    const alice = makeActor();
    const opened = openCallInvite(
      wire,
      bob.box.secretKey,
      (from) => (from === 'AAA-BBBB-CCCC' ? alice.sign.publicKey : null),
      NOW,
    );
    expect(opened).toBeNull();
  });

  test('answer/ICE round-trip under the session key', () => {
    const alice = makeActor();
    const bob = makeActor();
    const { wire, callKey } = sealCallInvite(bob.box.publicKey, 'AAA-BBBB-CCCC', alice.sign.secretKey, 'o', NOW);
    const opened = openCallInvite(wire, bob.box.secretKey, () => alice.sign.publicKey, NOW)!;

    // Callee → caller answer, sealed under the shared key.
    const ans = sealWithCallKey(opened.callKey, 'sdp-answer-blob');
    expect(openWithCallKey(callKey, ans)).toBe('sdp-answer-blob');

    // Caller → callee ICE candidate.
    const ice = sealWithCallKey(callKey, '{"candidate":"..."}');
    expect(openWithCallKey(opened.callKey, ice)).toBe('{"candidate":"..."}');
  });

  test('a wrong session key cannot open signaling', () => {
    const k1 = nacl.randomBytes(nacl.secretbox.keyLength);
    const k2 = nacl.randomBytes(nacl.secretbox.keyLength);
    const w = sealWithCallKey(k1, 'secret');
    expect(openWithCallKey(k2, w)).toBeNull();
  });

  test('rejects tampered symmetric ciphertext', () => {
    const k = nacl.randomBytes(nacl.secretbox.keyLength);
    const w = sealWithCallKey(k, 'secret');
    const tampered = { ...w, ciphertext: w.ciphertext.slice(0, -2) + (w.ciphertext.endsWith('AA') ? 'BB' : 'AA') };
    expect(openWithCallKey(k, tampered)).toBeNull();
  });
});

function encode(u: Uint8Array): string {
  return Buffer.from(u).toString('base64');
}
