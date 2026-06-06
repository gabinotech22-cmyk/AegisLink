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

export interface DevicePreKeySet {
  signedPreKey: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
    secretKey: Uint8Array;
  };
  oneTimePreKeys: { keyId: number; publicKeyB64: string }[];
  opkSecrets: Map<number, Uint8Array>;
}

export function generatePreKeys(
  identity: Identity,
  startOpkId = 1,
  count = 100,
  spkKeyId = 1
): DevicePreKeySet {
  // Signed PreKey
  const spk = nacl.box.keyPair();
  const signature = nacl.sign.detached(spk.publicKey, identity.signingSecretKey);

  const oneTimePreKeys: { keyId: number; publicKeyB64: string }[] = [];
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

/**
 * Rebuild a DevicePreKeySet (public material + secrets) from persisted SECRETS.
 *
 * X25519 public keys are derived deterministically from their secret via
 * `nacl.scalarMult.base(secret)`; the SPK signature is recomputed with the
 * identity's Ed25519 signing key. This guarantees the public material we
 * (re)publish ALWAYS corresponds to the secrets in the durable DB — the
 * single-source-of-truth invariant that fixes the root-key divergence caused
 * by concurrent independent `generatePreKeys` calls.
 */
function reconstructPreKeySetFromSecrets(
  identity: Identity,
  spkKeyId: number,
  spkSecret: Uint8Array,
  opkSecretsB64: Map<number, string>,
): DevicePreKeySet {
  const spkPublic = nacl.scalarMult.base(spkSecret);
  const signature = nacl.sign.detached(spkPublic, identity.signingSecretKey);

  const oneTimePreKeys: { keyId: number; publicKeyB64: string }[] = [];
  const opkSecrets = new Map<number, Uint8Array>();
  // Stable ascending order so the published bundle is deterministic.
  const keyIds = Array.from(opkSecretsB64.keys()).sort((a, b) => a - b);
  for (const keyId of keyIds) {
    const secret = decodeBase64(opkSecretsB64.get(keyId)!);
    oneTimePreKeys.push({
      keyId,
      publicKeyB64: encodeBase64(nacl.scalarMult.base(secret)),
    });
    opkSecrets.set(keyId, secret);
  }

  return {
    signedPreKey: {
      keyId: spkKeyId,
      publicKeyB64: encodeBase64(spkPublic),
      signatureB64: encodeBase64(signature),
      secretKey: spkSecret,
    },
    oneTimePreKeys,
    opkSecrets,
  };
}

// ── Single-source-of-truth device prekey set ────────────────────────────────
// Serializes concurrent callers (publishToServer fire-and-forget, the socket
// `unknown_identity` handler, Onboarding, profile creation) per active slot so
// two routes can never publish DIFFERENT sets. The first caller generates and
// durably persists ONE set; every subsequent caller (concurrent or later)
// reuses it, reconstructing the public material from the persisted secrets.
const ensurePreKeysInFlight = new Map<string, Promise<DevicePreKeySet>>();

/**
 * Return THE device's prekey set for the active slot — creating and durably
 * persisting it exactly once. All registration / re-registration routes MUST
 * use this instead of calling `generatePreKeys` directly, so the public bundle
 * published to the relay always matches the secrets stored on device.
 *
 * Invariant preserved: a freshly generated SPK secret is written to the durable
 * DB and read back BEFORE the set is returned; if the readback fails we throw
 * (the caller must not publish a SPK whose secret it cannot recover).
 *
 * db/local is required lazily (CommonJS) so this otherwise pure-crypto module
 * stays free of native (expo-sqlite) imports at static-graph load time and
 * Jest-friendly (`require`, never `await import`).
 */
export async function ensureDevicePreKeys(identity: Identity): Promise<DevicePreKeySet> {
  const db = require('../../db/local') as typeof import('../../db/local');
  const slot = db.getActiveDbSlot();

  const existing = ensurePreKeysInFlight.get(slot);
  if (existing) return existing;

  const work = (async (): Promise<DevicePreKeySet> => {
    // 1. Reuse a persisted set if one exists.
    const spkKeyId = await db.getSpkKeyId();
    if (spkKeyId !== null) {
      const spkSecretB64 = await db.loadSpkSecret(spkKeyId);
      if (spkSecretB64) {
        const opkSecretsB64 = await db.loadAllOpkSecrets();
        return reconstructPreKeySetFromSecrets(
          identity,
          spkKeyId,
          decodeBase64(spkSecretB64),
          opkSecretsB64,
        );
      }
    }

    // 2. No durable set yet — generate one, persist it (with readback), return it.
    const set = generatePreKeys(identity, 1, 100, 1);
    const spkSecretB64 = encodeBase64(set.signedPreKey.secretKey);

    let persisted = false;
    for (let attempt = 1; attempt <= 2 && !persisted; attempt++) {
      try {
        await db.saveSpkSecret(set.signedPreKey.keyId, spkSecretB64);
        const back = await db.loadSpkSecret(set.signedPreKey.keyId);
        if (back === spkSecretB64) persisted = true;
      } catch {/* retry once */}
    }
    if (!persisted) {
      throw new Error(
        `ensureDevicePreKeys: could not persist SPK secret for keyId ${set.signedPreKey.keyId} — refusing to publish`,
      );
    }

    try { await db.setSpkKeyId(set.signedPreKey.keyId); } catch {/* best-effort */}
    for (const [keyId, secret] of set.opkSecrets.entries()) {
      try { await db.saveOpkSecret(keyId, encodeBase64(secret)); } catch {/* best-effort */}
    }
    return set;
  })();

  ensurePreKeysInFlight.set(slot, work);
  try {
    return await work;
  } finally {
    // Release the in-flight latch so a later slot switch / rotation can refresh.
    ensurePreKeysInFlight.delete(slot);
  }
}
