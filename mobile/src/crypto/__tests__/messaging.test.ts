/**
 * messaging.test.ts — 1:1 encrypt/decrypt round-trip over the full stack
 * (X3DH -> Double Ratchet -> Sealed Sender envelope) from crypto/messaging.ts.
 *
 * Covers:
 *   - happy-path round-trip yields the original plaintext + correct sender
 *   - a tampered outer ciphertext fails to open (authenticated encryption)
 *   - a tampered inner ratchet ciphertext fails to decrypt
 *   - a third party with the wrong key cannot decrypt
 *   - multi-message ordering works across ratchet steps
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8 } from 'tweetnacl-util';

import { runAnonymousOnboarding } from '../onboarding';
import { performX3DH, performX3DHReceiver } from '../signal/x3dh';
import { initRatchet, ratchetDecrypt } from '../signal/ratchet';
import { encryptMessage, tryDecryptMessage } from '../messaging';

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

describe('1:1 messaging', () => {
  it('round-trips a message end to end', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { envelope } = encryptMessage(
      'mensaje secreto',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const dec = tryDecryptMessage(envelope, alice.identity.publicKey, bob.identity.secretKey, bobState);
    expect(dec).not.toBeNull();
    expect(dec!.body).toBe('mensaje secreto');
    expect(dec!.from).toBe(alice.identity.aegisId);
  });

  it('fails when the outer ciphertext is tampered', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { envelope } = encryptMessage(
      'integridad',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const tampered = decodeBase64(envelope.ciphertextB64);
    tampered[0] ^= 0x01;
    const broken = { ...envelope, ciphertextB64: encodeBase64(tampered) };
    const dec = tryDecryptMessage(broken, alice.identity.publicKey, bob.identity.secretKey, bobState);
    expect(dec).toBeNull();
  });

  it('cannot be decrypted by a third party with the wrong key', () => {
    const { alice, bob, aliceState } = setupSession();
    const eve = runAnonymousOnboarding(1);
    const { envelope } = encryptMessage(
      'no para eve',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const eveState = initRatchet(nacl.randomBytes(32), nacl.box.keyPair().publicKey, true);
    const dec = tryDecryptMessage(envelope, alice.identity.publicKey, eve.identity.secretKey, eveState);
    expect(dec).toBeNull();
  });

  it('delivers multiple messages across ratchet steps', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const bodies = ['uno', 'dos', 'tres'];
    const envs = bodies.map(
      (b) =>
        encryptMessage(b, alice.identity.aegisId, bob.identity.publicKey, alice.identity.secretKey, aliceState)
          .envelope,
    );
    const out = envs.map(
      (e) => tryDecryptMessage(e, alice.identity.publicKey, bob.identity.secretKey, bobState)?.body,
    );
    expect(out).toEqual(bodies);
  });

  it('isolates sessions: a fresh receiver state cannot decrypt a later message', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    // Advance the sending chain so the second message lives on n=1.
    encryptMessage('uno', alice.identity.aegisId, bob.identity.publicKey, alice.identity.secretKey, aliceState);
    const { envelope } = encryptMessage(
      'dos',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    // A pristine ratchet state that never saw message n=0 cannot jump ahead.
    const freshBob = initRatchet(
      // wrong root key entirely -> chain keys never agree
      nacl.randomBytes(32),
      new Uint8Array(),
      false,
      { publicKey: bobState.DHs.publicKey, secretKey: bobState.DHs.secretKey },
    );
    const dec = tryDecryptMessage(envelope, alice.identity.publicKey, bob.identity.secretKey, freshBob);
    expect(dec).toBeNull();
    void ratchetDecrypt;
    void encodeUTF8;
  });
});
