import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { hkdfSHA256 } from './kdf';
import { type Identity } from '../identity';

/**
 * X25519 contributory-behaviour guard.
 *
 * `nacl.scalarMult` will happily return an all-zero shared secret when fed a
 * low-order / identity public point. A malicious server (or peer) that swaps a
 * peer's public key for a low-order point could force the shared secret — and
 * therefore the derived root key — to a value it knows, fully breaking the
 * handshake confidentiality. Signed prekeys are signature-checked, but the peer
 * identity key, ephemeral key and OPK are not, so we MUST reject all-zero DH
 * outputs here. Throwing aborts the handshake before any key is derived.
 */
function assertNonZeroDH(dh: Uint8Array, label: string): Uint8Array {
  let acc = 0;
  for (let i = 0; i < dh.length; i++) acc |= dh[i];
  if (acc === 0) {
    throw new Error(`X3DH: all-zero ${label} shared secret — low-order point attack`);
  }
  return dh;
}

export interface PreKeyBundle {
  identityKeyB64: string; // The user's public identity key
  signedPreKey: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
  };
  oneTimePreKey: {
    keyId: number;
    publicKeyB64: string;
  } | null;
  // We also need the contact's signing public key to verify the SPK signature
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

  // 1. MANDATORY: Verify Ed25519 signature of the Signed PreKey using the
  //    recipient's Identity Signing Key. This MUST happen BEFORE any DH
  //    operation involving bobSPK — otherwise a malicious server could
  //    substitute the SPK and execute a full MITM on the handshake.
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

  // 2. Generate our Ephemeral Key
  const { publicKey: myEK_pub, secretKey: myEK_sec } = nacl.box.keyPair();

  // 3. Perform DH operations (Signal X3DH spec):
  //    DH1 = DH(IK_sender, SPK_receiver)
  //    DH2 = DH(EK_sender, IK_receiver)
  //    DH3 = DH(EK_sender, SPK_receiver)
  const dh1 = assertNonZeroDH(nacl.scalarMult(myIdentity.secretKey, bobSPK), 'DH1');
  const dh2 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobIK), 'DH2');
  const dh3 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobSPK), 'DH3');

  // Signal spec: prepend 32 bytes of 0xFF before concatenating DH outputs
  const F = new Uint8Array(32).fill(0xFF);
  let dhOut = new Uint8Array(F.length + dh1.length + dh2.length + dh3.length);
  dhOut.set(F, 0);
  dhOut.set(dh1, F.length);
  dhOut.set(dh2, F.length + dh1.length);
  dhOut.set(dh3, F.length + dh1.length + dh2.length);

  if (contactBundle.oneTimePreKey) {
    const bobOPK = decodeBase64(contactBundle.oneTimePreKey.publicKeyB64);
    const dh4 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobOPK), 'DH4');
    const newDhOut = new Uint8Array(dhOut.length + dh4.length);
    newDhOut.set(dhOut, 0);
    newDhOut.set(dh4, dhOut.length);
    dhOut = newDhOut;
  }

  // 4. Derive Root Key via HKDF (Signal X3DH spec: salt = 0x00…, info = app-specific)
  const salt = new Uint8Array(32); // 32 zero bytes per spec
  const info = new TextEncoder().encode('AegisLinkX3DH');
  const rootKey = hkdfSHA256(dhOut, salt, info, 32);

  return {
    rootKey,
    myEphemeralPublicKeyB64: encodeBase64(myEK_pub)
  };
}

/**
 * Perform X3DH from the receiver's perspective (Bob)
 * Bob receives Alice's IK and EK, and knows which of his SPK/OPK were used.
 */
export function performX3DHReceiver(
  myIdentity: Identity,
  mySpkSecret: Uint8Array,
  myOpkSecret: Uint8Array | null,
  aliceIK: Uint8Array,
  aliceEK: Uint8Array
): Uint8Array {
  // Mirror sender's DH order: DH1=DH(SPK,IK_alice), DH2=DH(IK,EK_alice), DH3=DH(SPK,EK_alice)
  const dh1 = assertNonZeroDH(nacl.scalarMult(mySpkSecret, aliceIK), 'DH1');
  const dh2 = assertNonZeroDH(nacl.scalarMult(myIdentity.secretKey, aliceEK), 'DH2');
  const dh3 = assertNonZeroDH(nacl.scalarMult(mySpkSecret, aliceEK), 'DH3');

  // Signal spec: prepend 32 bytes of 0xFF
  const F = new Uint8Array(32).fill(0xFF);
  let dhOut = new Uint8Array(F.length + dh1.length + dh2.length + dh3.length);
  dhOut.set(F, 0);
  dhOut.set(dh1, F.length);
  dhOut.set(dh2, F.length + dh1.length);
  dhOut.set(dh3, F.length + dh1.length + dh2.length);

  if (myOpkSecret) {
    const dh4 = assertNonZeroDH(nacl.scalarMult(myOpkSecret, aliceEK), 'DH4');
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
  // Signed PreKey
  const spk = nacl.box.keyPair();
  const signature = nacl.sign.detached(spk.publicKey, identity.signingSecretKey);

  const oneTimePreKeys = [];
  const opkSecrets = new Map<number, Uint8Array>();
  
  for (let i = 0; i < count; i++) {
    const opk = nacl.box.keyPair();
    const keyId = startOpkId + i;
    oneTimePreKeys.push({
      keyId,
      publicKeyB64: encodeBase64(opk.publicKey)
    });
    opkSecrets.set(keyId, opk.secretKey);
  }

  return {
    signedPreKey: {
      keyId: spkKeyId,
      publicKeyB64: encodeBase64(spk.publicKey),
      signatureB64: encodeBase64(signature),
      secretKey: spk.secretKey
    },
    oneTimePreKeys,
    opkSecrets
  };
}
