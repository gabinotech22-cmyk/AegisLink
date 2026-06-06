import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { performX3DH, performX3DHReceiver, generatePreKeys, type PreKeyBundle } from '../x3dh';
import { initRatchet, ratchetEncrypt, ratchetDecrypt } from '../ratchet';
import { type Identity } from '../../identity';

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
