/**
 * channelKey — sealSenderKeyForRecipients contract
 *
 * Step 4 of the large-groups plan. The re-key-after-removal path seals one
 * fresh SenderKey for every remaining member (up to ~1024). The sealing helper
 * must (a) stay correct — each recipient can open exactly its own box back to
 * the original SenderKey — and (b) yield between chunks so a large group never
 * freezes the JS thread. This locks (a) and the order/aegisId mapping; it also
 * exercises a recipient count that crosses the SEAL_CHUNK_SIZE (32) boundary.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  generateSenderKey,
  sealSenderKeyForRecipients,
  openSenderKeyDistribution,
  SEAL_CHUNK_SIZE,
} from '../channelKey';

describe('sealSenderKeyForRecipients', () => {
  const sender = nacl.box.keyPair();
  const senderSecretKeyB64 = encodeBase64(sender.secretKey);
  const senderPublicKeyB64 = encodeBase64(sender.publicKey);

  function makeRecipients(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const kp = nacl.box.keyPair();
      return {
        aegisId: `member-${i}`,
        publicKeyB64: encodeBase64(kp.publicKey),
        secretKeyB64: encodeBase64(kp.secretKey),
      };
    });
  }

  it('seals a key each recipient can open back to the original, preserving order', async () => {
    // 65 crosses the 32-seal chunk boundary (2 full chunks + 1) so the internal
    // yield path is exercised.
    const count = SEAL_CHUNK_SIZE * 2 + 1;
    const recipients = makeRecipients(count);
    const sk = generateSenderKey();

    const sealed = await sealSenderKeyForRecipients(
      sk,
      'group-xyz',
      'sender-aegis',
      senderSecretKeyB64,
      recipients.map((r) => ({ aegisId: r.aegisId, publicKeyB64: r.publicKeyB64 })),
    );

    expect(sealed).toHaveLength(count);

    sealed.forEach((dist, i) => {
      // Order + identity mapping preserved.
      expect(dist.aegisId).toBe(recipients[i].aegisId);
      expect(dist.senderAegisId).toBe('sender-aegis');
      expect(dist.channelId).toBe('group-xyz');

      // The matching recipient — and only it — recovers the SenderKey.
      const opened = openSenderKeyDistribution(dist, recipients[i].secretKeyB64, senderPublicKeyB64);
      expect(Array.from(opened.chainKey)).toEqual(Array.from(sk.chainKey));
      expect(opened.iteration).toBe(sk.iteration);

      // A different recipient's secret key cannot open this box.
      const wrong = recipients[(i + 1) % count].secretKeyB64;
      expect(() => openSenderKeyDistribution(dist, wrong, senderPublicKeyB64)).toThrow();
    });
  });

  it('returns an empty array for no recipients', async () => {
    const sealed = await sealSenderKeyForRecipients(
      generateSenderKey(),
      'g',
      'sender-aegis',
      senderSecretKeyB64,
      [],
    );
    expect(sealed).toEqual([]);
  });
});
