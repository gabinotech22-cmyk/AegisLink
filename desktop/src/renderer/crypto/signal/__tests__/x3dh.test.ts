import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import {
  performX3DH,
  performX3DHReceiver,
  shouldUsePqReceiver,
  generatePreKeys,
  type PreKeyBundle,
} from '../x3dh';
import { initRatchet, ratchetEncrypt, ratchetDecrypt } from '../ratchet';
import { type Identity } from '../../identity';
import { hkdfSHA256 } from '../kdf';

function buildIdentity(): Identity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return {
    aegisId: 'TEST' + encodeBase64(box.publicKey).slice(0, 8),
    publicKey: box.publicKey,
    secretKey: box.secretKey,
    publicKeyB64: encodeBase64(box.publicKey),
    secretKeyB64: encodeBase64(box.secretKey),
    signingPublicKey: sign.publicKey,
    signingSecretKey: sign.secretKey,
    signingPublicKeyB64: encodeBase64(sign.publicKey),
    signingSecretKeyB64: encodeBase64(sign.secretKey),
    createdAt: Date.now(),
  };
}

describe('performX3DH — SPK signature verification (FND-02)', () => {
  it('completes the handshake when the SPK signature is valid', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);

    const bundle: PreKeyBundle = {
      identityKeyB64: bob.publicKeyB64,
      signingPublicKeyB64: bob.signingPublicKeyB64,
      signedPreKey: {
        keyId: bobPreKeys.signedPreKey.keyId,
        publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
        signatureB64: bobPreKeys.signedPreKey.signatureB64,
      },
      oneTimePreKey: bobPreKeys.oneTimePreKeys[0] ?? null,
    };

    const result = performX3DH(alice, bundle);
    expect(result.rootKey).toBeInstanceOf(Uint8Array);
    expect(result.rootKey.length).toBe(32);
    expect(typeof result.myEphemeralPublicKeyB64).toBe('string');
  });

  it('throws when the SPK signature is forged/invalid (MITM attempt)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const attacker = nacl.box.keyPair();

    // Attacker replaces the SPK but cannot forge a signature with Bob's signing key.
    // We sign the attacker SPK with a DIFFERENT key to simulate an invalid signature.
    const rogueSigner = nacl.sign.keyPair();
    const forgedSig = nacl.sign.detached(attacker.publicKey, rogueSigner.secretKey);

    const bundle: PreKeyBundle = {
      identityKeyB64: bob.publicKeyB64,
      signingPublicKeyB64: bob.signingPublicKeyB64, // claim to be Bob
      signedPreKey: {
        keyId: 1,
        publicKeyB64: encodeBase64(attacker.publicKey),
        signatureB64: encodeBase64(forgedSig),
      },
      oneTimePreKey: null,
    };

    expect(() => performX3DH(alice, bundle)).toThrow(/Invalid SPK signature/);
  });

  it('rejects a low-order identity key that forces an all-zero DH (FND-CRYPTO-DH0)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);

    // X25519 low-order point: 32 zero bytes is the identity element and yields
    // an all-zero shared secret for any scalar. We substitute it for Bob's
    // identity key so DH2 = scalarMult(EK_alice, lowOrder) == 0.
    const lowOrder = encodeBase64(new Uint8Array(32));

    const bundle: PreKeyBundle = {
      identityKeyB64: lowOrder,
      signingPublicKeyB64: bob.signingPublicKeyB64,
      signedPreKey: {
        keyId: bobPreKeys.signedPreKey.keyId,
        publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
        signatureB64: bobPreKeys.signedPreKey.signatureB64,
      },
      oneTimePreKey: null,
    };

    expect(() => performX3DH(alice, bundle)).toThrow(/all-zero/);
  });

  it('throws when the signing public key is missing', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);

    const bundle: PreKeyBundle = {
      identityKeyB64: bob.publicKeyB64,
      signingPublicKeyB64: '',
      signedPreKey: {
        keyId: bobPreKeys.signedPreKey.keyId,
        publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
        signatureB64: bobPreKeys.signedPreKey.signatureB64,
      },
      oneTimePreKey: null,
    };

    expect(() => performX3DH(alice, bundle)).toThrow(/Missing recipient signing public key/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fresh-session symmetry — regression for the on-device "every new session is
// born desynced" bug. Alice (performX3DH) and Bob (performX3DHReceiver) MUST
// derive the IDENTICAL root key for BOTH the OPK-present and OPK-absent cases.
// If the DH order/KDF or the OPK-null handling diverged, these would fail.
// ─────────────────────────────────────────────────────────────────────────────
describe('X3DH sender/receiver root-key symmetry', () => {
  function setup(withOpk: boolean) {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const opk = withOpk ? (bobPreKeys.oneTimePreKeys[0] ?? null) : null;

    const bundle: PreKeyBundle = {
      identityKeyB64: bob.publicKeyB64,
      signingPublicKeyB64: bob.signingPublicKeyB64,
      signedPreKey: {
        keyId: bobPreKeys.signedPreKey.keyId,
        publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
        signatureB64: bobPreKeys.signedPreKey.signatureB64,
      },
      oneTimePreKey: opk,
    };

    const aliceResult = performX3DH(alice, bundle);

    // Bob derives using the SPK secret matching the keyId Alice committed to, and
    // (when present) the OPK secret for the opkId in Alice's header.
    const mySpkSecret = bobPreKeys.signedPreKey.secretKey;
    const myOpkSecret =
      opk !== null ? (bobPreKeys.opkSecrets.get(opk.keyId) ?? null) : null;

    const bobRoot = performX3DHReceiver(
      bob,
      mySpkSecret,
      myOpkSecret,
      alice.publicKey, // Bob's view of Alice's identity key (from the wire / contact row)
      decodeBase64(aliceResult.myEphemeralPublicKeyB64),
    );

    return { alice, bob, bundle, aliceResult, bobRoot, mySpkSecret };
  }

  it('derives the SAME root key when an OPK IS used (DH1..DH4)', () => {
    const { aliceResult, bobRoot } = setup(true);
    expect(encodeBase64(bobRoot)).toBe(encodeBase64(aliceResult.rootKey));
  });

  it('derives the SAME root key when NO OPK is used (DH1..DH3)', () => {
    const { aliceResult, bobRoot } = setup(false);
    expect(encodeBase64(bobRoot)).toBe(encodeBase64(aliceResult.rootKey));
  });

  it('asymmetric OPK usage produces DIFFERENT root keys (proves DH4 matters)', () => {
    // Alice uses an OPK; Bob (mistakenly) omits DH4. This is exactly the on-device
    // failure mode the fix prevents — it MUST yield divergent keys here.
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const opk = bobPreKeys.oneTimePreKeys[0];

    const bundle: PreKeyBundle = {
      identityKeyB64: bob.publicKeyB64,
      signingPublicKeyB64: bob.signingPublicKeyB64,
      signedPreKey: {
        keyId: bobPreKeys.signedPreKey.keyId,
        publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
        signatureB64: bobPreKeys.signedPreKey.signatureB64,
      },
      oneTimePreKey: opk,
    };

    const aliceResult = performX3DH(alice, bundle);
    const bobRootNoDh4 = performX3DHReceiver(
      bob,
      bobPreKeys.signedPreKey.secretKey,
      null, // BUG simulation: Bob omits DH4 although Alice used it
      alice.publicKey,
      decodeBase64(aliceResult.myEphemeralPublicKeyB64),
    );

    expect(encodeBase64(bobRootNoDh4)).not.toBe(encodeBase64(aliceResult.rootKey));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end fresh session: Alice performs X3DH + initRatchet(Alice), encrypts
// her FIRST normal message; Bob performs X3DHReceiver + initRatchet(Bob) with
// Alice's SPK as DHs, and decrypts that first message. This is the exact path a
// brand-new contact takes; before the fix the first message returned null.
// ─────────────────────────────────────────────────────────────────────────────
describe('X3DH + Double Ratchet fresh-session first-message roundtrip', () => {
  function runRoundtrip(withOpk: boolean) {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const opk = withOpk ? bobPreKeys.oneTimePreKeys[0] : null;

    const bundle: PreKeyBundle = {
      identityKeyB64: bob.publicKeyB64,
      signingPublicKeyB64: bob.signingPublicKeyB64,
      signedPreKey: {
        keyId: bobPreKeys.signedPreKey.keyId,
        publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
        signatureB64: bobPreKeys.signedPreKey.signatureB64,
      },
      oneTimePreKey: opk,
    };

    // Alice
    const aliceX3DH = performX3DH(alice, bundle);
    const aliceState = initRatchet(
      aliceX3DH.rootKey,
      decodeBase64(bundle.signedPreKey.publicKeyB64),
      true,
    );
    const plaintext = new TextEncoder().encode('first message on a fresh session');
    const { ciphertext, nonce, header } = ratchetEncrypt(aliceState, plaintext);

    // Bob — mirrors decryptAndAppend's X3DH branch.
    const mySpkSecret = bobPreKeys.signedPreKey.secretKey;
    const myOpkSecret = opk ? (bobPreKeys.opkSecrets.get(opk.keyId) ?? null) : null;
    const bobRoot = performX3DHReceiver(
      bob,
      mySpkSecret,
      myOpkSecret,
      alice.publicKey,
      decodeBase64(aliceX3DH.myEphemeralPublicKeyB64),
    );
    const spkPub = nacl.scalarMult.base(mySpkSecret);
    const bobState = initRatchet(bobRoot, header.ratchetKey, false, {
      publicKey: spkPub,
      secretKey: mySpkSecret,
    });

    const out = ratchetDecrypt(bobState, header, ciphertext, nonce);
    return { out, plaintext };
  }

  it('Bob decrypts Alice\'s first message (OPK used)', () => {
    const { out, plaintext } = runRoundtrip(true);
    expect(out).not.toBeNull();
    expect(encodeBase64(out!)).toBe(encodeBase64(plaintext));
  });

  it('Bob decrypts Alice\'s first message (no OPK)', () => {
    const { out, plaintext } = runRoundtrip(false);
    expect(out).not.toBeNull();
    expect(encodeBase64(out!)).toBe(encodeBase64(plaintext));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PQXDH (post-quantum hybrid X3DH). The classic DH legs are unchanged; v2 only
// appends an ML-KEM-768 shared secret to dhOut and derives under a distinct
// HKDF label. These tests cover the 6 acceptance criteria.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a Bob bundle. `withPq` toggles whether the PQSPK is advertised (v2). */
function buildBundle(
  bob: Identity,
  bobPreKeys: ReturnType<typeof generatePreKeys>,
  opts: { withOpk?: boolean; withPq?: boolean } = {},
): PreKeyBundle {
  const opk = opts.withOpk ? (bobPreKeys.oneTimePreKeys[0] ?? null) : null;
  return {
    identityKeyB64: bob.publicKeyB64,
    signingPublicKeyB64: bob.signingPublicKeyB64,
    signedPreKey: {
      keyId: bobPreKeys.signedPreKey.keyId,
      publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
      signatureB64: bobPreKeys.signedPreKey.signatureB64,
    },
    oneTimePreKey: opk,
    pqSignedPreKey: opts.withPq
      ? {
          keyId: bobPreKeys.pqSignedPreKey.keyId,
          publicKeyB64: bobPreKeys.pqSignedPreKey.publicKeyB64,
          signatureB64: bobPreKeys.pqSignedPreKey.signatureB64,
        }
      : null,
  };
}

describe('PQXDH v2 — hybrid post-quantum handshake', () => {
  // (1) Round-trip: Alice and Bob derive the SAME 32-byte rootKey via v2.
  it('Alice and Bob derive the SAME v2 rootKey (with OPK)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const bundle = buildBundle(bob, bobPreKeys, { withOpk: true, withPq: true });

    const aliceResult = performX3DH(alice, bundle);
    expect(aliceResult.version).toBe(2);
    expect(aliceResult.rootKey.length).toBe(32);
    expect(typeof aliceResult.pqCiphertextB64).toBe('string');

    const opk = bobPreKeys.oneTimePreKeys[0];
    const bobRoot = performX3DHReceiver(
      bob,
      bobPreKeys.signedPreKey.secretKey,
      bobPreKeys.opkSecrets.get(opk.keyId) ?? null,
      alice.publicKey,
      decodeBase64(aliceResult.myEphemeralPublicKeyB64),
      {
        cipherText: decodeBase64(aliceResult.pqCiphertextB64!),
        pqSpkSecret: bobPreKeys.pqSignedPreKey.secretKey,
      },
    );

    expect(encodeBase64(bobRoot)).toBe(encodeBase64(aliceResult.rootKey));
  });

  it('Alice and Bob derive the SAME v2 rootKey (no OPK)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const bundle = buildBundle(bob, bobPreKeys, { withOpk: false, withPq: true });

    const aliceResult = performX3DH(alice, bundle);
    expect(aliceResult.version).toBe(2);

    const bobRoot = performX3DHReceiver(
      bob,
      bobPreKeys.signedPreKey.secretKey,
      null,
      alice.publicKey,
      decodeBase64(aliceResult.myEphemeralPublicKeyB64),
      {
        cipherText: decodeBase64(aliceResult.pqCiphertextB64!),
        pqSpkSecret: bobPreKeys.pqSignedPreKey.secretKey,
      },
    );

    expect(encodeBase64(bobRoot)).toBe(encodeBase64(aliceResult.rootKey));
  });

  // (2) Domain separation: v2 rootKey != v1 rootKey for the SAME classical
  // inputs. We force identical classical material by reusing the SAME alice
  // ephemeral is not directly controllable, so instead we assert that running
  // v2 vs v1 over the same bundle (minus PQ) never collides, AND we prove the
  // label itself diverges by deriving with both labels over a fixed dhOut.
  it('v2 rootKey differs from v1 rootKey (domain separation)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);

    // Deterministic comparison: feed the SAME classical dhOut into both labels.
    // Re-derive using the library so the test pins the domain-separation guarantee.
    const dhOut = nacl.randomBytes(160); // stand-in for a fixed classical dhOut
    const pqSs = nacl.randomBytes(32);
    const combined = new Uint8Array(dhOut.length + pqSs.length);
    combined.set(dhOut, 0);
    combined.set(pqSs, dhOut.length);
    const salt = new Uint8Array(32);
    const v1 = hkdfSHA256(dhOut, salt, new TextEncoder().encode('AegisLinkX3DH'), 32);
    const v2 = hkdfSHA256(combined, salt, new TextEncoder().encode('AegisLinkPQXDH'), 32);
    expect(encodeBase64(v1)).not.toBe(encodeBase64(v2));

    // And at the API level: a v2 handshake never yields a v1-style result.
    const v2Bundle = buildBundle(bob, bobPreKeys, { withPq: true });
    const v1Bundle = buildBundle(bob, bobPreKeys, { withPq: false });
    const r2 = performX3DH(alice, v2Bundle);
    const r1 = performX3DH(alice, v1Bundle);
    expect(r2.version).toBe(2);
    expect(r1.version).toBe(1);
    expect(encodeBase64(r2.rootKey)).not.toBe(encodeBase64(r1.rootKey));
  });

  // (3) PQ prekey signature: an invalid PQSPK signature makes performX3DH throw.
  it('throws when the PQ prekey signature is forged/invalid (MITM)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);

    // Attacker substitutes a rogue ML-KEM pubkey, signed with a DIFFERENT key.
    const rogue = ml_kem768.keygen();
    const rogueSigner = nacl.sign.keyPair();
    const forgedSig = nacl.sign.detached(rogue.publicKey, rogueSigner.secretKey);

    const bundle = buildBundle(bob, bobPreKeys, { withPq: true });
    bundle.pqSignedPreKey = {
      keyId: 1,
      publicKeyB64: encodeBase64(rogue.publicKey),
      signatureB64: encodeBase64(forgedSig),
    };

    expect(() => performX3DH(alice, bundle)).toThrow(/Invalid PQ prekey signature/);
  });

  // (4) Anti-downgrade (relaxed policy): bundle advertised PQ but the initial
  // message carried no ciphertext → the responder FALLS BACK to v1 (still full
  // X25519 E2EE) instead of aborting, so a v1 sender / bundle-publish gap never
  // causes total message loss. The fallback is logged for telemetry.
  it('shouldUsePqReceiver falls back to v1 when PQ advertised but no ciphertext', () => {
    expect(shouldUsePqReceiver(true, false)).toBe('v1');
  });

  it('shouldUsePqReceiver selects v2 when PQ advertised and ciphertext present', () => {
    expect(shouldUsePqReceiver(true, true)).toBe('v2');
  });

  it('shouldUsePqReceiver selects v1 when PQ was not advertised', () => {
    expect(shouldUsePqReceiver(false, false)).toBe('v1');
    // A stray ciphertext without our PQSPK is ignored (not below v1 security).
    expect(shouldUsePqReceiver(false, true)).toBe('v1');
  });

  // (5) Interop/fallback: bundle WITHOUT PQ prekey → v1, classic round-trip OK.
  it('falls back to v1 when the bundle has no PQ prekey (interop)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const bundle = buildBundle(bob, bobPreKeys, { withOpk: true, withPq: false });

    const aliceResult = performX3DH(alice, bundle);
    expect(aliceResult.version).toBe(1);
    expect(aliceResult.pqCiphertextB64).toBeUndefined();

    const opk = bobPreKeys.oneTimePreKeys[0];
    const bobRoot = performX3DHReceiver(
      bob,
      bobPreKeys.signedPreKey.secretKey,
      bobPreKeys.opkSecrets.get(opk.keyId) ?? null,
      alice.publicKey,
      decodeBase64(aliceResult.myEphemeralPublicKeyB64),
      null, // no PQ inputs — classic path
    );
    expect(encodeBase64(bobRoot)).toBe(encodeBase64(aliceResult.rootKey));
  });

  // (6) Tamper: a manipulated ML-KEM ciphertext makes Bob's root key DIVERGE
  // from Alice's (ML-KEM implicit rejection → different shared secret, no throw).
  it('tampered ML-KEM ciphertext → divergent root keys (Bob != Alice)', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const bundle = buildBundle(bob, bobPreKeys, { withPq: true });

    const aliceResult = performX3DH(alice, bundle);
    const ct = decodeBase64(aliceResult.pqCiphertextB64!);
    // Flip one byte of the ciphertext.
    ct[0] ^= 0xff;

    const bobRoot = performX3DHReceiver(
      bob,
      bobPreKeys.signedPreKey.secretKey,
      null,
      alice.publicKey,
      decodeBase64(aliceResult.myEphemeralPublicKeyB64),
      { cipherText: ct, pqSpkSecret: bobPreKeys.pqSignedPreKey.secretKey },
    );

    expect(encodeBase64(bobRoot)).not.toBe(encodeBase64(aliceResult.rootKey));
  });

  // End-to-end: v2 X3DH + Double Ratchet first-message roundtrip.
  it('v2 end-to-end: Bob decrypts Alice\'s first message over a PQXDH session', () => {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const bundle = buildBundle(bob, bobPreKeys, { withOpk: true, withPq: true });

    const aliceX3DH = performX3DH(alice, bundle);
    expect(aliceX3DH.version).toBe(2);
    const aliceState = initRatchet(
      aliceX3DH.rootKey,
      decodeBase64(bundle.signedPreKey.publicKeyB64),
      true,
    );
    const plaintext = new TextEncoder().encode('first PQXDH message');
    const { ciphertext, nonce, header } = ratchetEncrypt(aliceState, plaintext);

    const opk = bobPreKeys.oneTimePreKeys[0];
    const bobRoot = performX3DHReceiver(
      bob,
      bobPreKeys.signedPreKey.secretKey,
      bobPreKeys.opkSecrets.get(opk.keyId) ?? null,
      alice.publicKey,
      decodeBase64(aliceX3DH.myEphemeralPublicKeyB64),
      {
        cipherText: decodeBase64(aliceX3DH.pqCiphertextB64!),
        pqSpkSecret: bobPreKeys.pqSignedPreKey.secretKey,
      },
    );
    const spkPub = nacl.scalarMult.base(bobPreKeys.signedPreKey.secretKey);
    const bobState = initRatchet(bobRoot, header.ratchetKey, false, {
      publicKey: spkPub,
      secretKey: bobPreKeys.signedPreKey.secretKey,
    });

    const out = ratchetDecrypt(bobState, header, ciphertext, nonce);
    expect(out).not.toBeNull();
    expect(encodeBase64(out!)).toBe(encodeBase64(plaintext));
  });

  // The PQSPK signature verifies under the identity signing key (parity w/ SPK).
  it('generatePreKeys produces a PQSPK whose signature verifies under the identity key', () => {
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    expect(decodeBase64(bobPreKeys.pqSignedPreKey.publicKeyB64).length).toBe(1184);
    expect(
      nacl.sign.detached.verify(
        decodeBase64(bobPreKeys.pqSignedPreKey.publicKeyB64),
        decodeBase64(bobPreKeys.pqSignedPreKey.signatureB64),
        bob.signingPublicKey,
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1: Hybrid PQ Double Ratchet. Unlike the PQXDH tests above (which only seed
// the ML-KEM secret into the INITIAL X3DH root key), these tests seed
// initRatchet's `initialPQr`/`initialPQs` so the ratchet itself mixes a FRESH
// ML-KEM-768 shared secret into the root on every chain turn — the actual R1
// deliverable. Mirrors how socket/client.ts wires this in production. Twin of
// mobile/src/crypto/signal/__tests__/x3dh.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe('R1 hybrid PQ Double Ratchet (per-chain-turn ML-KEM mixing)', () => {
  function establishHybridSession() {
    const alice = buildIdentity();
    const bob = buildIdentity();
    const bobPreKeys = generatePreKeys(bob);
    const bundle = buildBundle(bob, bobPreKeys, { withOpk: true, withPq: true });

    const aliceX3DH = performX3DH(alice, bundle);
    expect(aliceX3DH.version).toBe(2);

    // Alice seeds Bob's PQSPK public key as her initial PQr (mirrors
    // socket/client.ts's getOrCreateSessionLocked).
    const aliceState = initRatchet(
      aliceX3DH.rootKey,
      decodeBase64(bundle.signedPreKey.publicKeyB64),
      true,
      undefined,
      undefined,
      decodeBase64(bundle.pqSignedPreKey!.publicKeyB64),
    );

    const opk = bobPreKeys.oneTimePreKeys[0];
    const bobRoot = performX3DHReceiver(
      bob,
      bobPreKeys.signedPreKey.secretKey,
      bobPreKeys.opkSecrets.get(opk.keyId) ?? null,
      alice.publicKey,
      decodeBase64(aliceX3DH.myEphemeralPublicKeyB64),
      {
        cipherText: decodeBase64(aliceX3DH.pqCiphertextB64!),
        pqSpkSecret: bobPreKeys.pqSignedPreKey.secretKey,
      },
    );

    // First message header carries Alice's pqPub/pqCt because hybrid mode
    // mixes PQ immediately on initRatchet's isAlice branch.
    const firstPlaintext = new TextEncoder().encode('hybrid message 1 (alice -> bob)');
    const first = ratchetEncrypt(aliceState, firstPlaintext);
    expect(first.header.pqPub).toBeDefined();
    expect(first.header.pqCt).toBeDefined();

    // Bob seeds his own PQSPK keypair as his initial PQs (mirrors
    // socket/client.ts's decryptAndAppendLocked).
    const spkPub = nacl.scalarMult.base(bobPreKeys.signedPreKey.secretKey);
    const bobState = initRatchet(
      bobRoot,
      first.header.ratchetKey,
      false,
      { publicKey: spkPub, secretKey: bobPreKeys.signedPreKey.secretKey },
      {
        publicKey: decodeBase64(bobPreKeys.pqSignedPreKey.publicKeyB64),
        secretKey: bobPreKeys.pqSignedPreKey.secretKey,
      },
    );

    const out1 = ratchetDecrypt(bobState, first.header, first.ciphertext, first.nonce);
    expect(out1).not.toBeNull();
    expect(encodeBase64(out1!)).toBe(encodeBase64(firstPlaintext));

    return { aliceState, bobState };
  }

  it('Bob decrypts the first message of a hybrid session (PQ mixed from message 1)', () => {
    const { aliceState, bobState } = establishHybridSession();
    expect(aliceState.PQs).toBeTruthy();
    expect(bobState.PQs).toBeTruthy();
  });

  it('survives multiple round-trip chain turns, each rotating PQ material', () => {
    const { aliceState, bobState } = establishHybridSession();

    const alicePqPubRound1 = encodeBase64(aliceState.PQs!.publicKey);

    const reply1Plaintext = new TextEncoder().encode('hybrid message 2 (bob -> alice)');
    const reply1 = ratchetEncrypt(bobState, reply1Plaintext);
    expect(reply1.header.pqPub).toBeDefined();
    expect(reply1.header.pqCt).toBeDefined();

    const aliceOut1 = ratchetDecrypt(aliceState, reply1.header, reply1.ciphertext, reply1.nonce);
    expect(aliceOut1).not.toBeNull();
    expect(encodeBase64(aliceOut1!)).toBe(encodeBase64(reply1Plaintext));

    const alicePqPubRound2 = encodeBase64(aliceState.PQs!.publicKey);
    expect(alicePqPubRound2).not.toBe(alicePqPubRound1);

    const msg2Plaintext = new TextEncoder().encode('hybrid message 3 (alice -> bob)');
    const msg2 = ratchetEncrypt(aliceState, msg2Plaintext);
    expect(msg2.header.pqPub).toBeDefined();
    expect(msg2.header.pqCt).toBeDefined();

    const bobOut2 = ratchetDecrypt(bobState, msg2.header, msg2.ciphertext, msg2.nonce);
    expect(bobOut2).not.toBeNull();
    expect(encodeBase64(bobOut2!)).toBe(encodeBase64(msg2Plaintext));
  });

  it('rejects a chain-turn header stripped of PQ material (downgrade attack)', () => {
    const { aliceState, bobState } = establishHybridSession();

    const replyPlaintext = new TextEncoder().encode('attempted downgrade');
    const reply = ratchetEncrypt(bobState, replyPlaintext);
    const strippedHeader = { ratchetKey: reply.header.ratchetKey, n: reply.header.n, pn: reply.header.pn };

    expect(() => ratchetDecrypt(aliceState, strippedHeader, reply.ciphertext, reply.nonce)).toThrow(
      /downgrade/i,
    );
  });
});

// Cross-platform KAT: the hybrid root derivation (dhOut ‖ pqSecret under the
// 'AegisLinkRootPQ' label) MUST be byte-identical on desktop and mobile, or two
// twin clients silently derive different roots and every message fails. This
// exact block + vector is mirrored in the mobile ratchet test
// (mobile/src/crypto/signal/__tests__/ratchet.test.ts). Vector from
// _scratch/kat-gen.mjs.
const KAT_ROOT_PQ_HEX =
  '4302ce0529c32b63da34f031ea6658753e568732c4fd56526fd421a81b74559c' +
  'bac8b9ad0a53c62d197de7ecb208b50a35387e4a8c03278e113bf4c44a490fea';

describe('R1 — cross-platform hybrid root KAT', () => {
  it('hybrid root derivation matches the pinned vector (desktop↔mobile parity)', () => {
    const rk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const dhOut = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff);
    const pqSecret = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff);
    const combined = new Uint8Array(64);
    combined.set(dhOut, 0);
    combined.set(pqSecret, 32);
    const out = hkdfSHA256(combined, rk, new TextEncoder().encode('AegisLinkRootPQ'), 64);
    expect(Buffer.from(out).toString('hex')).toBe(KAT_ROOT_PQ_HEX);
  });
});
