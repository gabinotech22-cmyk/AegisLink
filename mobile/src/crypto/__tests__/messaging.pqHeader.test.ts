/**
 * messaging.pqHeader.test.ts — regression for the "missing PQ material on
 * hybrid session" bug.
 *
 * The socket client's init-adoption decrypt path hand-rolled its own header
 * from the wire and DROPPED pqPubB64/pqCtB64, so a hybrid receiver rejected
 * the very first chain-turn message as a downgrade attack and no fresh v2
 * session could ever be established (both peers looped in desync recovery).
 *
 * The fix: parseRatchetHeader is the single point of truth for wire → header
 * and every decrypt path uses it. This test round-trips the exact path the
 * client uses when adopting an inbound X3DH init: encryptMessage (v1 outer)
 * → openEnvelope → parseRatchetHeader → ratchetDecrypt on a hybrid session.
 */

import { decodeBase64, encodeUTF8 } from 'tweetnacl-util';

import { runAnonymousOnboarding } from '../onboarding';
import { performX3DH, performX3DHReceiver, generatePreKeys } from '../signal/x3dh';
import { initRatchet, ratchetDecrypt, type RatchetState } from '../signal/ratchet';
import { encryptMessage, openEnvelope, parseRatchetHeader } from '../messaging';

function newHybridPair(): {
  alice: ReturnType<typeof runAnonymousOnboarding>;
  bob: ReturnType<typeof runAnonymousOnboarding>;
  aliceState: RatchetState;
  bobState: RatchetState;
} {
  const alice = runAnonymousOnboarding(5);
  const bob = runAnonymousOnboarding(5);
  const bobPreKeys = generatePreKeys(bob.identity);

  const bundle = {
    identityKeyB64: bob.identity.publicKeyB64,
    signingPublicKeyB64: bob.identity.signingPublicKeyB64,
    signedPreKey: {
      keyId: bobPreKeys.signedPreKey.keyId,
      publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
      signatureB64: bobPreKeys.signedPreKey.signatureB64,
    },
    oneTimePreKey: null,
    pqSignedPreKey: {
      keyId: bobPreKeys.pqSignedPreKey.keyId,
      publicKeyB64: bobPreKeys.pqSignedPreKey.publicKeyB64,
      signatureB64: bobPreKeys.pqSignedPreKey.signatureB64,
    },
  };

  const x = performX3DH(alice.identity, bundle);
  expect(x.version).toBe(2); // sanity: PQXDH negotiated
  const bobRoot = performX3DHReceiver(
    bob.identity,
    bobPreKeys.signedPreKey.secretKey,
    null,
    alice.identity.publicKey,
    decodeBase64(x.myEphemeralPublicKeyB64),
    {
      cipherText: decodeBase64(x.pqCiphertextB64!),
      pqSpkSecret: bobPreKeys.pqSignedPreKey.secretKey,
    },
  );

  const bobSpkPub = decodeBase64(bobPreKeys.signedPreKey.publicKeyB64);
  const bobPqPub = decodeBase64(bobPreKeys.pqSignedPreKey.publicKeyB64);

  const aliceState = initRatchet(x.rootKey, bobSpkPub, true, undefined, null, bobPqPub);
  const bobState = initRatchet(
    bobRoot,
    new Uint8Array(),
    false,
    { publicKey: bobSpkPub, secretKey: bobPreKeys.signedPreKey.secretKey },
    { publicKey: bobPqPub, secretKey: bobPreKeys.pqSignedPreKey.secretKey },
    null,
  );
  return { alice, bob, aliceState, bobState };
}

describe('parseRatchetHeader — PQ material forwarded over the wire', () => {
  it('preserves pqPub/pqCt from the wire form of a hybrid chain-turn message', () => {
    const { alice, bob, aliceState } = newHybridPair();

    const { envelope } = encryptMessage(
      'first contact',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const parsed = openEnvelope(envelope, alice.identity.publicKey, bob.identity.secretKey);
    expect(parsed).not.toBeNull();

    // The wire carries the PQ material…
    expect(parsed!.ratchet.pqPubB64).toBeDefined();
    expect(parsed!.ratchet.pqCtB64).toBeDefined();

    // …and parseRatchetHeader forwards it (the bug: a hand-rolled header
    // dropped these two fields).
    const header = parseRatchetHeader(parsed!.ratchet);
    expect(header.pqPub).toBeDefined();
    expect(header.pqCt).toBeDefined();
    expect(header.pqPub!.length).toBe(1184); // ML-KEM-768 public key
    expect(header.pqCt!.length).toBe(1088); // ML-KEM-768 ciphertext
  });

  it('hybrid init round-trips over the client decrypt path (openEnvelope → parseRatchetHeader → ratchetDecrypt)', () => {
    const { alice, bob, aliceState, bobState } = newHybridPair();

    const { envelope } = encryptMessage(
      'hola pq',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const parsed = openEnvelope(envelope, alice.identity.publicKey, bob.identity.secretKey)!;

    // Exactly what the socket client does after adopting an inbound init.
    const header = parseRatchetHeader(parsed.ratchet);
    const plaintext = ratchetDecrypt(
      bobState,
      header,
      decodeBase64(parsed.ratchet.ciphertextB64),
      decodeBase64(parsed.ratchet.nonceB64),
    );
    expect(plaintext).not.toBeNull();
    expect(encodeUTF8(plaintext!)).toBe('hola pq');
  });

  it('a header stripped of PQ fields is still rejected by a hybrid receiver (anti-downgrade intact)', () => {
    const { alice, bob, aliceState, bobState } = newHybridPair();

    const { envelope } = encryptMessage(
      'downgrade me',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const parsed = openEnvelope(envelope, alice.identity.publicKey, bob.identity.secretKey)!;

    // Reproduce the OLD buggy header (no pqPub/pqCt) — the hybrid receiver
    // must keep treating it as a downgrade attempt.
    const buggyHeader = {
      ratchetKey: decodeBase64(parsed.ratchet.ratchetKeyB64),
      n: parsed.ratchet.n,
      pn: parsed.ratchet.pn,
    };
    expect(() =>
      ratchetDecrypt(
        bobState,
        buggyHeader,
        decodeBase64(parsed.ratchet.ciphertextB64),
        decodeBase64(parsed.ratchet.nonceB64),
      ),
    ).toThrow(/missing PQ material|downgrade/i);
  });

  it('omits pqPub/pqCt when the wire form has none (classic v1 header unchanged)', () => {
    const header = parseRatchetHeader({
      ratchetKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      n: 3,
      pn: 1,
      ciphertextB64: 'AA==',
      nonceB64: 'AA==',
    });
    expect(header.n).toBe(3);
    expect(header.pn).toBe(1);
    expect(header.pqPub).toBeUndefined();
    expect(header.pqCt).toBeUndefined();
  });
});
