/**
 * channelKey.skipCap.test.ts — regression for the audit 2026-06 SenderKey
 * hardening:
 *   - advanceSenderKeyTo caps fast-forward at MAX_SENDERKEY_SKIP (DoS guard)
 *     and refuses targets in the past.
 *   - decryptChannelMessage validates nonce length instead of degrading.
 */
import { encodeBase64 } from 'tweetnacl-util';
import {
  generateSenderKey,
  ratchetSenderKey,
  advanceSenderKeyTo,
  MAX_SENDERKEY_SKIP,
  encryptChannelMessage,
  decryptChannelMessage,
} from '../channelKey';

describe('SenderKey skip cap (audit 2026-06)', () => {
  it('refuses a target iteration in the past', () => {
    const sk = ratchetSenderKey(generateSenderKey()); // iteration 1
    expect(advanceSenderKeyTo(sk, 0)).toBeNull();
  });

  it('refuses a jump larger than MAX_SENDERKEY_SKIP', () => {
    const sk = generateSenderKey(); // iteration 0
    expect(advanceSenderKeyTo(sk, MAX_SENDERKEY_SKIP + 1)).toBeNull();
  });

  it('refuses a non-integer target', () => {
    const sk = generateSenderKey();
    expect(advanceSenderKeyTo(sk, 2.5)).toBeNull();
  });

  it('advances to a valid target identically to ratcheting N times', () => {
    const sk = generateSenderKey();
    const advanced = advanceSenderKeyTo(sk, 5);
    expect(advanced).not.toBeNull();
    expect(advanced!.iteration).toBe(5);

    let manual = sk;
    for (let i = 0; i < 5; i++) manual = ratchetSenderKey(manual);
    expect(Array.from(advanced!.chainKey)).toEqual(Array.from(manual.chainKey));
  });
});

describe('decryptChannelMessage nonce validation (audit 2026-06)', () => {
  it('throws on a wrong-length nonce instead of degrading silently', () => {
    const sk = generateSenderKey();
    const { ciphertextB64 } = encryptChannelMessage('hola', sk);
    const badNonce = encodeBase64(new Uint8Array(8)); // not 24 bytes
    expect(() => decryptChannelMessage(ciphertextB64, badNonce, sk)).toThrow(
      /invalid nonce length/,
    );
  });
});
