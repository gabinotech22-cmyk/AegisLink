import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { createEphemeralIdentity } from '../identity.js';
import { encryptMessage, openEnvelope, tryDecryptMessage } from '../messaging.js';
import { performX3DH, performX3DHReceiver, generatePreKeys } from '../signal/x3dh.js';
import { initRatchet } from '../signal/ratchet.js';
import { generateLinkingQR, decryptLinkingResponse, encryptLinkingResponse } from '../linking.js';

function makePair() {
  const alice = createEphemeralIdentity();
  const bob = createEphemeralIdentity();

  // Bob generates a public bundle.
  const bobPK = generatePreKeys(bob, 1, 1);
  const bundle = {
    identityKeyB64: bob.publicKeyB64,
    signingPublicKeyB64: bob.signingPublicKeyB64,
    signedPreKey: {
      keyId: bobPK.signedPreKey.keyId,
      publicKeyB64: bobPK.signedPreKey.publicKeyB64,
      signatureB64: bobPK.signedPreKey.signatureB64,
    },
    oneTimePreKey: bobPK.oneTimePreKeys[0],
  };

  // Alice runs X3DH against Bob's bundle.
  const x = performX3DH(alice, bundle);

  // Bob receives Alice's EK and IK and derives the same root key.
  const aliceIK = alice.publicKey;
  const aliceEK = decodeBase64(x.myEphemeralPublicKeyB64);
  const bobOpkSec = bobPK.opkSecrets.get(bundle.oneTimePreKey.keyId);
  const bobRoot = performX3DHReceiver(bob, bobPK.signedPreKey.secretKey, bobOpkSec, aliceIK, aliceEK);

  // Sanity: both sides derive identical root keys.
  expect(Buffer.from(x.rootKey)).toEqual(Buffer.from(bobRoot));

  // Build ratchet states. Alice starts; Bob's DHs == his SPK pair.
  const bobSPKPair = {
    publicKey: decodeBase64(bobPK.signedPreKey.publicKeyB64),
    secretKey: bobPK.signedPreKey.secretKey,
  };
  const aliceState = initRatchet(x.rootKey, bobSPKPair.publicKey, true);
  const bobState = initRatchet(bobRoot, null, false, bobSPKPair);

  return { alice, bob, aliceState, bobState };
}

describe('desktop crypto roundtrip', () => {
  test('encryptMessage -> openEnvelope + ratchet decrypt roundtrip', () => {
    const { alice, bob, aliceState, bobState } = makePair();
    const plaintext = 'hello from desktop';
    const { envelope } = encryptMessage(plaintext, alice.aegisId, bob.publicKey, alice.secretKey, aliceState);

    const out = tryDecryptMessage(envelope, alice.publicKey, bob.secretKey, bobState);
    expect(out).not.toBeNull();
    expect(out.from).toBe(alice.aegisId);
    expect(out.body).toBe(plaintext);
  });

  test('openEnvelope without ratchet decode also succeeds and exposes inner fields', () => {
    const { alice, bob, aliceState } = makePair();
    const { envelope } = encryptMessage('ping', alice.aegisId, bob.publicKey, alice.secretKey, aliceState);
    const inner = openEnvelope(envelope, alice.publicKey, bob.secretKey);
    expect(inner).not.toBeNull();
    expect(inner.v).toBe(2);
    expect(inner.from).toBe(alice.aegisId);
    expect(inner.ratchet).toBeTruthy();
  });

  test('altered ciphertext fails MAC verification', () => {
    const { alice, bob, aliceState, bobState } = makePair();
    const { envelope } = encryptMessage('tampered', alice.aegisId, bob.publicKey, alice.secretKey, aliceState);

    // Flip one byte in the outer ciphertext.
    const ct = decodeBase64(envelope.ciphertextB64);
    ct[10] ^= 0x01;
    const tampered = { ciphertextB64: encodeBase64(ct), nonceB64: envelope.nonceB64 };

    expect(openEnvelope(tampered, alice.publicKey, bob.secretKey)).toBeNull();
    expect(tryDecryptMessage(tampered, alice.publicKey, bob.secretKey, bobState)).toBeNull();
  });

  test('generateLinkingQR produces a well-formed payload', () => {
    const { qrPayload, ephemeralKeypair } = generateLinkingQR('wss://relay.aegis.local');
    expect(qrPayload.v).toBe(1);
    expect(typeof qrPayload.pubKey).toBe('string');
    expect(qrPayload.relay).toBe('wss://relay.aegis.local');
    expect(decodeBase64(qrPayload.pubKey).length).toBe(nacl.box.publicKeyLength);
    expect(ephemeralKeypair.secretKey.length).toBe(nacl.box.secretKeyLength);
  });

  test('decryptLinkingResponse decrypts what the mobile would send', () => {
    const { qrPayload, ephemeralKeypair } = generateLinkingQR('wss://relay');
    const desktopPub = decodeBase64(qrPayload.pubKey);

    // Simulate mobile side.
    const mobileKP = nacl.box.keyPair();
    const payload = {
      aegisId: 'ABC-DEFG-HIJK',
      signingPublicKeyB64: encodeBase64(nacl.sign.keyPair().publicKey),
      displayName: 'mobile-device',
    };
    const encrypted = encryptLinkingResponse(payload, desktopPub, mobileKP);

    const decoded = decryptLinkingResponse(encrypted, ephemeralKeypair.secretKey);
    expect(decoded).toEqual(payload);
  });

  test('decryptLinkingResponse rejects tampered ciphertext', () => {
    const { qrPayload, ephemeralKeypair } = generateLinkingQR('wss://relay');
    const desktopPub = decodeBase64(qrPayload.pubKey);
    const mobileKP = nacl.box.keyPair();
    const encrypted = encryptLinkingResponse({ aegisId: 'XYZ' }, desktopPub, mobileKP);

    const ct = decodeBase64(encrypted.ciphertext);
    ct[0] ^= 0x80;
    encrypted.ciphertext = encodeBase64(ct);

    expect(decryptLinkingResponse(encrypted, ephemeralKeypair.secretKey)).toBeNull();
  });
});
