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

import { decodeBase64, decodeUTF8, encodeUTF8, encodeBase64 } from 'tweetnacl-util';

import { runAnonymousOnboarding } from '../../crypto/onboarding';
import { performX3DH, performX3DHReceiver, generatePreKeys } from '../../crypto/signal/x3dh';
import {
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  type RatchetState,
} from '../../crypto/signal/ratchet';
import { serializeRatchetState, reviveRatchetState } from '../ratchetSerde';
import { pk, pkOrNull } from '../../crypto/__tests__/helpers/rawIdentity';
import { peek } from '../../crypto/__tests__/helpers/ratchetPeek';

/** Persist + reload — the exact save/load cycle the socket client performs. */
function roundTrip(state: RatchetState): RatchetState {
  return reviveRatchetState(serializeRatchetState(state), state.slot);
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
    pk(bobPreKeys.signedPreKey.secretStored),
    null,
    alice.identity.publicKey,
    decodeBase64(x.myEphemeralPublicKeyB64),
    {
      cipherText: decodeBase64(x.pqCiphertextB64!),
      pqSpkSecret: pk(bobPreKeys.pqSignedPreKey.secretStored, 'mlkem768'),
    },
  );

  const bobSpkPub = decodeBase64(bobPreKeys.signedPreKey.publicKeyB64);
  const bobPqPub = decodeBase64(bobPreKeys.pqSignedPreKey.publicKeyB64);
  const aliceState = initRatchet('self', x.rootKey, bobSpkPub, true, undefined, null, bobPqPub);
  const bobState = initRatchet(
    'self',
    bobRoot,
    new Uint8Array(),
    false,
    { publicKey: bobSpkPub, secretKey: pk(bobPreKeys.signedPreKey.secretStored) },
    { publicKey: bobPqPub, secretKey: pk(bobPreKeys.pqSignedPreKey.secretStored, 'mlkem768') },
    null,
  );
  return { aliceState, bobState };
}

describe('serializeRatchetState — hybrid PQ material survives persistence', () => {
  it('keeps PQs/PQr/pqSendCt across a save/load round-trip', () => {
    const { aliceState } = newHybridPair();
    const reloaded = roundTrip(aliceState);

    expect(reloaded.info.hybrid).toBe(true);
    const raw = peek(reloaded);
    expect(raw.PQs).toBeTruthy();
    expect(raw.PQs!.publicKey.length).toBe(1184);
    expect(raw.PQs!.secretKey.length).toBe(2400);
    expect(raw.PQr).toBeInstanceOf(Uint8Array);
    expect(raw.pqSendCt!.length).toBe(1088);
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

  it('a receiver state persists before its first decrypt (sealed, no handle inside) (F-1b phase 3)', () => {
    const { aliceState, bobState } = newHybridPair();
    const reloaded = roundTrip(bobState);
    const a0 = ratchetEncrypt(aliceState, decodeUTF8('hi'));
    expect(encodeUTF8(ratchetDecrypt(reloaded, a0.header, a0.ciphertext, a0.nonce)!)).toBe('hi');
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

describe('persisted form (F-1b phase 3): only the sealed state leaves the vault', () => {
  it('the JSON holds the sealed blob and non-secret metadata, never a key field', () => {
    const { aliceState } = newHybridPair();
    const json = JSON.parse(serializeRatchetState(aliceState));
    expect(Object.keys(json).sort()).toEqual(['createdAtMs', 'info', 'sealed', 'slot', 'v'].sort());
    expect(json.v).toBe(3);
    for (const k of ['RK', 'CKs', 'CKr', 'DHs', 'MKSKIPPED', 'PQs']) expect(json[k]).toBeUndefined();
    expect(Object.keys(json.info).sort()).toEqual(['Ns', 'Nr', 'PN', 'dhr', 'dhs', 'hasCKr', 'hasCKs', 'hybrid'].sort());
  });

  it('a session of another profile is refused', () => {
    const { aliceState } = newHybridPair();
    expect(() => reviveRatchetState(serializeRatchetState(aliceState), 'otherprofile')).toThrow(/another profile/);
  });

  it('a tampered sealed state fails closed', () => {
    const { aliceState } = newHybridPair();
    const bad = { ...aliceState, sealed: Uint8Array.from(aliceState.sealed) };
    bad.sealed[bad.sealed.length - 1] ^= 1;
    expect(() => ratchetEncrypt(bad, decodeUTF8('x'))).toThrow(/sealed state rejected/);
  });

  it('a pre-phase-3 session (raw keys in JSON, skipped keys included) is imported once and keeps working', () => {
    const { aliceState, bobState } = newHybridPair();
    // Bob misses a0, gets a1: a0's key lands in the skipped keys.
    const a0 = ratchetEncrypt(aliceState, decodeUTF8('a0'));
    const a1 = ratchetEncrypt(aliceState, decodeUTF8('a1'));
    expect(encodeUTF8(ratchetDecrypt(bobState, a1.header, a1.ciphertext, a1.nonce)!)).toBe('a1');
    // Write Bob's state the way the app did before phase 3.
    const r = peek(bobState);
    const arr = (b: Uint8Array | null) => (b ? Array.from(b) : null);
    const legacy = JSON.stringify({
      RK: arr(r.RK),
      DHs: { publicKey: arr(r.DHs.publicKey), secretKey: arr(r.DHs.secretKey) },
      DHr: arr(r.DHr),
      CKs: arr(r.CKs),
      CKr: arr(r.CKr),
      Ns: r.Ns,
      Nr: r.Nr,
      PN: r.PN,
      PQs: r.PQs ? { publicKey: arr(r.PQs.publicKey), secretKey: arr(r.PQs.secretKey) } : null,
      PQr: arr(r.PQr),
      pqSendCt: arr(r.pqSendCt),
      MKSKIPPED: r.skipped.map((e) => [`${encodeBase64(e.pub)}:${e.n}`, Array.from(e.mk)]),
      createdAtMs: 1234,
    });
    const imported = reviveRatchetState(legacy, 'self');
    expect(imported.createdAtMs).toBe(1234);
    expect(peek(imported).skipped).toHaveLength(1);
    expect(encodeUTF8(ratchetDecrypt(imported, a0.header, a0.ciphertext, a0.nonce)!)).toBe('a0');
    // And it now persists as v3.
    expect(JSON.parse(serializeRatchetState(imported)).v).toBe(3);
  });

  it('a malformed pre-phase-3 session fails closed instead of guessing bytes', () => {
    expect(() => reviveRatchetState(JSON.stringify({ RK: [1, 2, 3], DHs: { publicKey: [], secretKey: [] }, Ns: 0, Nr: 0, PN: 0 }), 'self')).toThrow(/legacy session/);
  });
});
