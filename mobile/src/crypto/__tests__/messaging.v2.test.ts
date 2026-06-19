/**
 * messaging.v2.test.ts — sealed-sender v2 1:1 round-trip over the full stack
 * (X3DH → Double Ratchet → sealed-sender v2 outer envelope).
 *
 * Verifies the v2 path is cryptographically equivalent to v1 for established
 * sessions, while the outer wire carries no `from` and is authenticated by the
 * sender's signing key:
 *   - happy-path round-trip recovers plaintext + authenticated sender
 *   - multi-message ordering works across ratchet steps
 *   - an unknown sender (no signing key resolvable) is rejected
 *   - a wrong recipient cannot open
 */

import { runAnonymousOnboarding } from '../onboarding';
import { performX3DH, performX3DHReceiver } from '../signal/x3dh';
import { initRatchet } from '../signal/ratchet';
import { encryptMessageV2, decryptMessageV2 } from '../messaging';
import { decodeBase64 } from 'tweetnacl-util';

const NOW = 1_750_000_000_000;

function signingPub(identity: { signingSecretKey: Uint8Array }): Uint8Array {
  // nacl.sign secret key is 64 bytes: last 32 are the public key.
  return identity.signingSecretKey.slice(32, 64);
}

function setupSession() {
  const alice = runAnonymousOnboarding(5);
  const bob = runAnonymousOnboarding(5);

  const x = performX3DH(alice.identity, bob.bundle);
  const opkId = bob.bundle.oneTimePreKey?.keyId ?? null;
  const opkSec = opkId !== null ? bob.secrets.opkSecrets.get(opkId) ?? null : null;
  const bobRoot = performX3DHReceiver(
    bob.identity,
    bob.secrets.signedPreKey.secretKey,
    opkSec,
    alice.identity.publicKey,
    decodeBase64(x.myEphemeralPublicKeyB64),
  );

  const bobSpkPub = decodeBase64(bob.bundle.signedPreKey.publicKeyB64);
  const aliceState = initRatchet(x.rootKey, bobSpkPub, true);
  const bobState = initRatchet(bobRoot, new Uint8Array(), false, {
    publicKey: bobSpkPub,
    secretKey: bob.secrets.signedPreKey.secretKey,
  });
  return { alice, bob, aliceState, bobState };
}

describe('sealed-sender v2 1:1 messaging', () => {
  it('round-trips a message with authenticated sender and no from on the wire', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { wire } = encryptMessageV2(
      'mensaje sellado',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.signingSecretKey,
      aliceState,
      NOW,
    );
    // Wire has no sender identity.
    expect(Object.keys(wire).sort()).toEqual(['ciphertext', 'epk', 'nonce']);

    const dec = decryptMessageV2(
      wire,
      bob.identity.secretKey,
      (from) => (from === alice.identity.aegisId ? signingPub(alice.identity) : null),
      bobState,
      NOW,
    );
    expect(dec).not.toBeNull();
    expect(dec!.body).toBe('mensaje sellado');
    expect(dec!.from).toBe(alice.identity.aegisId);
  });

  it('delivers multiple messages across ratchet steps', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const bodies = ['uno', 'dos', 'tres'];
    const wires = bodies.map(
      (b) =>
        encryptMessageV2(b, alice.identity.aegisId, bob.identity.publicKey, alice.identity.signingSecretKey, aliceState, NOW)
          .wire,
    );
    const out = wires.map(
      (w) =>
        decryptMessageV2(w, bob.identity.secretKey, () => signingPub(alice.identity), bobState, NOW)?.body,
    );
    expect(out).toEqual(bodies);
  });

  it('rejects a message when the sender signing key is unknown', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { wire } = encryptMessageV2(
      'sin clave',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.signingSecretKey,
      aliceState,
      NOW,
    );
    const dec = decryptMessageV2(wire, bob.identity.secretKey, () => null, bobState, NOW);
    expect(dec).toBeNull();
  });

  it('cannot be opened by a wrong recipient', () => {
    const { alice, bob, aliceState } = setupSession();
    const eve = runAnonymousOnboarding(1);
    const { wire } = encryptMessageV2(
      'no para eve',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.signingSecretKey,
      aliceState,
      NOW,
    );
    const eveState = initRatchet(new Uint8Array(32), bob.identity.publicKey, true);
    const dec = decryptMessageV2(wire, eve.identity.secretKey, () => signingPub(alice.identity), eveState, NOW);
    expect(dec).toBeNull();
  });
});
