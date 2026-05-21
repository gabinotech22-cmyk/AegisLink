import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { hkdfSHA256 } from './kdf';
import { type Identity } from '../identity';

export interface PreKeyBundle {
  identityKeyB64: string;
  signedPreKey: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
  };
  oneTimePreKey: {
    keyId: number;
    publicKeyB64: string;
  } | null;
  signingPublicKeyB64: string;
}

export interface X3DHResult {
  rootKey: Uint8Array;
  myEphemeralPublicKeyB64: string;
}

/**
 * Perform X3DH from the sender's perspective (Alice)
 */
export function performX3DH(
  myIdentity: Identity,
  contactBundle: PreKeyBundle
): X3DHResult {
  const bobIK = decodeBase64(contactBundle.identityKeyB64);
  const bobSPK = decodeBase64(contactBundle.signedPreKey.publicKeyB64);
  const spkSig = decodeBase64(contactBundle.signedPreKey.signatureB64);

  // MANDATORY: Verify Ed25519 signature of the Signed PreKey BEFORE any DH op.
  if (!contactBundle.signingPublicKeyB64) {
    throw new Error('X3DH: Missing recipient signing public key — cannot verify SPK');
  }
  const bobSignK = decodeBase64(contactBundle.signingPublicKeyB64);
  if (bobSignK.length !== nacl.sign.publicKeyLength) {
    throw new Error('X3DH: Invalid recipient signing public key length');
  }
  if (spkSig.length !== nacl.sign.signatureLength) {
    throw new Error('X3DH: Invalid SPK signature length');
  }
  const validSig = nacl.sign.detached.verify(bobSPK, spkSig, bobSignK);
  if (!validSig) {
    throw new Error('X3DH: Invalid SPK signature — possible key compromise or MITM');
  }

  const { publicKey: myEK_pub, secretKey: myEK_sec } = nacl.box.keyPair();

  const dh1 = nacl.scalarMult(myIdentity.secretKey, bobSPK);
  const dh2 = nacl.scalarMult(myEK_sec, bobIK);
  const dh3 = nacl.scalarMult(myEK_sec, bobSPK);

  const F = new Uint8Array(32).fill(0xFF);
  let dhOut = new Uint8Array(F.length + dh1.length + dh2.length + dh3.length);
  dhOut.set(F, 0);
  dhOut.set(dh1, F.length);
  dhOut.set(dh2, F.length + dh1.length);
  dhOut.set(dh3, F.length + dh1.length + dh2.length);

  if (contactBundle.oneTimePreKey) {
    const bobOPK = decodeBase64(contactBundle.oneTimePreKey.publicKeyB64);
    const dh4 = nacl.scalarMult(myEK_sec, bobOPK);
    const newDhOut = new Uint8Array(dhOut.length + dh4.length);
    newDhOut.set(dhOut, 0);
    newDhOut.set(dh4, dhOut.length);
    dhOut = newDhOut;
  }

  const salt = new Uint8Array(32);
  const info = new TextEncoder().encode('AegisLinkX3DH');
  const rootKey = hkdfSHA256(dhOut, salt, info, 32);

  return {
    rootKey,
    myEphemeralPublicKeyB64: encodeBase64(myEK_pub),
  };
}

/**
 * Perform X3DH from the receiver's perspective (Bob)
 */
export function performX3DHReceiver(
  myIdentity: Identity,
  mySpkSecret: Uint8Array,
  myOpkSecret: Uint8Array | null,
  aliceIK: Uint8Array,
  aliceEK: Uint8Array
): Uint8Array {
  const dh1 = nacl.scalarMult(mySpkSecret, aliceIK);
  const dh2 = nacl.scalarMult(myIdentity.secretKey, aliceEK);
  const dh3 = nacl.scalarMult(mySpkSecret, aliceEK);

  const F = new Uint8Array(32).fill(0xFF);
  let dhOut = new Uint8Array(F.length + dh1.length + dh2.length + dh3.length);
  dhOut.set(F, 0);
  dhOut.set(dh1, F.length);
  dhOut.set(dh2, F.length + dh1.length);
  dhOut.set(dh3, F.length + dh1.length + dh2.length);

  if (myOpkSecret) {
    const dh4 = nacl.scalarMult(myOpkSecret, aliceEK);
    const newDhOut = new Uint8Array(dhOut.length + dh4.length);
    newDhOut.set(dhOut, 0);
    newDhOut.set(dh4, dhOut.length);
    dhOut = newDhOut;
  }

  const salt = new Uint8Array(32);
  const info = new TextEncoder().encode('AegisLinkX3DH');

  return hkdfSHA256(dhOut, salt, info, 32);
}

export function generatePreKeys(
  identity: Identity,
  startOpkId = 1,
  count = 100,
  spkKeyId = 1
) {
  const spk = nacl.box.keyPair();
  const signature = nacl.sign.detached(spk.publicKey, identity.signingSecretKey);

  const oneTimePreKeys = [];
  const opkSecrets = new Map<number, Uint8Array>();

  for (let i = 0; i < count; i++) {
    const opk = nacl.box.keyPair();
    const keyId = startOpkId + i;
    oneTimePreKeys.push({
      keyId,
      publicKeyB64: encodeBase64(opk.publicKey),
    });
    opkSecrets.set(keyId, opk.secretKey);
  }

  return {
    signedPreKey: {
      keyId: spkKeyId,
      publicKeyB64: encodeBase64(spk.publicKey),
      signatureB64: encodeBase64(signature),
      secretKey: spk.secretKey,
    },
    oneTimePreKeys,
    opkSecrets,
  };
}
