/**
 * deliveryToken.test.ts — mobile delivery-token hashing must match the server.
 *
 * The relay stores the hash the recipient registers and compares it against
 * sha256(rawToken) of the token a sender presents. If mobile's hash diverged
 * from the server's (server/src/crypto/deliveryToken.ts), every v2 send would
 * be rejected with bad_delivery_token. This pins the cross-implementation
 * agreement with a fixed vector computed by the server algorithm
 * (node crypto: sha256(utf8(token)).digest('base64')).
 */

import { hashDeliveryToken, generateDeliveryToken } from '../deliveryToken';

describe('delivery token hashing (mobile ↔ server parity)', () => {
  it('matches the server hash for a fixed vector', () => {
    // node -e sha256('AegisTokenVector123','utf8').digest('base64')
    expect(hashDeliveryToken('AegisTokenVector123')).toBe('ev+RvpmzDO4NcaE3QhjpgoBRiI4HiPwMQXxn5PswRHI=');
  });

  it('generates distinct 128-bit tokens', () => {
    const a = generateDeliveryToken();
    const b = generateDeliveryToken();
    expect(a).not.toBe(b);
    // 16 bytes → 24 base64 chars incl. padding.
    expect(a.length).toBe(24);
  });
});
