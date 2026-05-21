import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { performX3DH, generatePreKeys, type PreKeyBundle } from '../x3dh';
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
