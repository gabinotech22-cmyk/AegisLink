/**
 * ratchetSerde.persistence.test.ts — regression for the hybrid-session
 * persistence bug.
 *
 * saveSessionState used a hand-rolled field whitelist that omitted the hybrid
 * PQ ratchet material (PQs/PQr/pqSendCt). A reloaded hybrid session silently
 * degraded to classic: the next inbound chain turn derived the root WITHOUT
 * the PQ secret (MAC failure → permanent ONE-WAY desync: intra-chain messages
 * from the peer's live state still decrypted, but every chain turn died).
 * Observed live as "A→B works, B→A never arrives".
 *
 * These tests run the hybrid Double Ratchet ping-pong with a
 * serializeRatchetState → reviveRatchetState round-trip between EVERY step —
 * exactly what the app does (sessions are persisted after each operation and
 * reloaded on the next).
 */

import { decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';

import { runAnonymousOnboarding } from '../../crypto/onboarding';
import { performX3DH, performX3DHReceiver, generatePreKeys } from '../../crypto/signal/x3dh';
import {
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  type RatchetState,
} from '../../crypto/signal/ratchet';
import { serializeRatchetState, reviveRatchetState } from '../ratchetSerde';

/** Persist + reload — the exact save/load cycle the socket client performs. */
function roundTrip(state: RatchetState): RatchetState {
  return reviveRatchetState(serializeRatchetState(state));
}

function newHybridPair(): { aliceState: RatchetState; bobState: RatchetState } {
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
  expect(x.version).toBe(2);
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
  return { aliceState, bobState };
}

describe('serializeRatchetState — hybrid PQ material survives persistence', () => {
  it('keeps PQs/PQr/pqSendCt across a save/load round-trip', () => {
    const { aliceState } = newHybridPair();
    const reloaded = roundTrip(aliceState);

    expect(reloaded.PQs).toBeTruthy();
    expect(reloaded.PQs!.publicKey).toBeInstanceOf(Uint8Array);
    expect(reloaded.PQs!.secretKey).toBeInstanceOf(Uint8Array);
    expect(reloaded.PQs!.publicKey.length).toBe(1184);
    expect(reloaded.PQr).toBeInstanceOf(Uint8Array);
    expect(reloaded.pqSendCt).toBeInstanceOf(Uint8Array);
    expect(reloaded.pqSendCt!.length).toBe(1088);
  });

  it('hybrid ping-pong stays in sync with persistence between EVERY step (the live bug)', () => {
    let { aliceState, bobState } = newHybridPair();

    for (let i = 0; i < 3; i++) {
      // Alice sends (chain turn on i>0), then is persisted+reloaded.
      const a = ratchetEncrypt(aliceState, decodeUTF8(`a${i}`));
      aliceState = roundTrip(aliceState);

      // Bob (also persisted+reloaded) decrypts Alice's chain turn.
      bobState = roundTrip(bobState);
      const gotA = ratchetDecrypt(bobState, a.header, a.ciphertext, a.nonce);
      expect(gotA).not.toBeNull();
      expect(encodeUTF8(gotA!)).toBe(`a${i}`);

      // Bob replies (chain turn), both sides persisted+reloaded again.
      bobState = roundTrip(bobState);
      const b = ratchetEncrypt(bobState, decodeUTF8(`b${i}`));
      bobState = roundTrip(bobState);

      // Pre-fix, THIS is where it died: Alice reloaded without PQs (classic),
      // ran a classic dhRatchet on Bob's hybrid chain turn and got a MAC
      // failure (null) — the permanent one-way desync seen on device.
      aliceState = roundTrip(aliceState);
      const gotB = ratchetDecrypt(aliceState, b.header, b.ciphertext, b.nonce);
      expect(gotB).not.toBeNull();
      expect(encodeUTF8(gotB!)).toBe(`b${i}`);
      aliceState = roundTrip(aliceState);
    }
  });

  it('a reloaded hybrid session still attaches PQ material on its next chain turn', () => {
    let { aliceState, bobState } = newHybridPair();

    // Establish the chain, then force a chain turn from Bob after reload.
    const a0 = ratchetEncrypt(aliceState, decodeUTF8('hi'));
    expect(ratchetDecrypt(bobState, a0.header, a0.ciphertext, a0.nonce)).not.toBeNull();

    bobState = roundTrip(bobState);
    const reply = ratchetEncrypt(bobState, decodeUTF8('yo'));
    // Pre-fix the reloaded state had no PQs/pqSendCt, so the chain-turn header
    // shipped WITHOUT PQ material and the hybrid peer rejected it as a
    // downgrade attack.
    expect(reply.header.pqPub).toBeDefined();
    expect(reply.header.pqCt).toBeDefined();
  });
});
