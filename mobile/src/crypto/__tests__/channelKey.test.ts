import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  generateSenderKey,
  ratchetSenderKey,
  deriveMessageKey,
  encryptChannelMessage,
  decryptChannelMessage,
  sealSenderKeyFor,
  openSenderKeyDistribution,
} from '../channelKey';

describe('channelKey — Sender Key scheme', () => {
  it('generateSenderKey produces a 32-byte chainKey at iteration 0', () => {
    const sk = generateSenderKey();
    expect(sk.chainKey).toBeInstanceOf(Uint8Array);
    expect(sk.chainKey.length).toBe(32);
    expect(sk.iteration).toBe(0);
  });

  it('ratchetSenderKey changes the chainKey and increments iteration', () => {
    const sk0 = generateSenderKey();
    const sk1 = ratchetSenderKey(sk0);
    const sk2 = ratchetSenderKey(sk1);
    expect(encodeBase64(sk1.chainKey)).not.toBe(encodeBase64(sk0.chainKey));
    expect(encodeBase64(sk2.chainKey)).not.toBe(encodeBase64(sk1.chainKey));
    expect(sk1.iteration).toBe(1);
    expect(sk2.iteration).toBe(2);
  });

  it('encrypt + decrypt round-trips at the matching iteration', () => {
    const senderKey = generateSenderKey();
    const body = 'classified channel payload 🛰️';
    const { ciphertextB64, nonceB64, newSenderKey } = encryptChannelMessage(body, senderKey);

    // Recipient holds the SAME iteration the sender used to encrypt (senderKey),
    // and ratchets forward independently afterwards.
    const decrypted = decryptChannelMessage(ciphertextB64, nonceB64, senderKey);
    expect(decrypted).toBe(body);
    expect(newSenderKey.iteration).toBe(senderKey.iteration + 1);
  });

  it('sealSenderKeyFor + openSenderKeyDistribution round-trips with real NaCl keypairs', () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const sk = ratchetSenderKey(generateSenderKey());

    const dist = sealSenderKeyFor(
      sk,
      'channel-123',
      'AEGIS-SENDER',
      encodeBase64(recipient.publicKey),
      encodeBase64(sender.secretKey)
    );

    const opened = openSenderKeyDistribution(
      dist,
      encodeBase64(recipient.secretKey),
      encodeBase64(sender.publicKey)
    );
    expect(encodeBase64(opened.chainKey)).toBe(encodeBase64(sk.chainKey));
    expect(opened.iteration).toBe(sk.iteration);
  });

  it('decryption with a wrong key throws (MAC failure)', () => {
    const senderKey = generateSenderKey();
    const wrongKey = generateSenderKey();
    const { ciphertextB64, nonceB64 } = encryptChannelMessage('secret', senderKey);
    expect(() => decryptChannelMessage(ciphertextB64, nonceB64, wrongKey)).toThrow();
  });

  it('decryption of tampered ciphertext throws', () => {
    const senderKey = generateSenderKey();
    const { ciphertextB64, nonceB64 } = encryptChannelMessage('secret', senderKey);
    const tampered = encodeBase64(
      (() => {
        const b = require('tweetnacl-util').decodeBase64(ciphertextB64) as Uint8Array;
        b[0] ^= 0xff;
        return b;
      })()
    );
    expect(() => decryptChannelMessage(tampered, nonceB64, senderKey)).toThrow();
  });

  it('opening a distribution sealed for someone else throws', () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const attacker = nacl.box.keyPair();
    const dist = sealSenderKeyFor(
      generateSenderKey(),
      'ch',
      'AEGIS-SENDER',
      encodeBase64(recipient.publicKey),
      encodeBase64(sender.secretKey)
    );
    expect(() =>
      openSenderKeyDistribution(
        dist,
        encodeBase64(attacker.secretKey),
        encodeBase64(sender.publicKey)
      )
    ).toThrow();
  });

  it('ratchet is one-way: the old message key cannot be re-derived after ratcheting', () => {
    const sk0 = generateSenderKey();
    const mk0 = deriveMessageKey(sk0);
    const sk1 = ratchetSenderKey(sk0);
    const mk1 = deriveMessageKey(sk1);
    expect(encodeBase64(mk1)).not.toBe(encodeBase64(mk0));

    // From sk1 there is no function mapping back to sk0's chainKey: the only
    // forward operation produces sk2, never sk0.
    const sk2 = ratchetSenderKey(sk1);
    expect(encodeBase64(sk2.chainKey)).not.toBe(encodeBase64(sk0.chainKey));
    expect(encodeBase64(deriveMessageKey(sk2))).not.toBe(encodeBase64(mk0));
  });
});
