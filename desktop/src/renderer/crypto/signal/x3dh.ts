import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { hkdfSHA256 } from './kdf';
import { type Identity } from '../identity';

// ─── PQXDH (post-quantum hybrid X3DH, Signal-style) ──────────────────────────
//
// Ported from mobile/src/crypto/signal/x3dh.ts (commits 52c4b68 + 6f3ab46).
// We do NOT replace classic X3DH. The four X25519 DH legs (DH1..DH4) stay byte
// for byte identical; PQXDH only APPENDS an ML-KEM-768 shared secret to the
// concatenated DH output before HKDF, and uses a v2 domain-separation label so
// a v1 and a v2 handshake over the same classical inputs can never derive the
// same root key. This keeps full interop with v1 peers (older desktop/mobile).
//
// RNG note (mobile gotcha #7): @noble/post-quantum reads
// globalThis.crypto.getRandomValues. In the Electron renderer (Chromium) that
// exists natively, so — unlike React Native/Hermes — NO crypto shim is needed.
//
// ML-KEM-768 fixed sizes (FIPS 203, Table 3) — used for strict length checks:
const MLKEM768_PUBLICKEY_BYTES = 1184;
const MLKEM768_SECRETKEY_BYTES = 2400;
const MLKEM768_CIPHERTEXT_BYTES = 1088;
const MLKEM768_SHAREDSECRET_BYTES = 32;

/** Handshake protocol version. v1 = classic X3DH, v2 = PQXDH hybrid. */
export type HandshakeVersion = 1 | 2;

/**
 * HKDF `info` domain-separation labels. v1 keeps the original 'AegisLinkX3DH'
 * so existing v1 sessions remain bit-compatible; v2 uses a DISTINCT label so the
 * same classical DH inputs can never collide with a v1-derived key. Changing
 * either string is a wire-breaking change.
 */
const HKDF_INFO_V1 = 'AegisLinkX3DH';
const HKDF_INFO_V2 = 'AegisLinkPQXDH';

/**
 * X25519 contributory-behaviour guard (ported from mobile). nacl.scalarMult
 * returns an all-zero shared secret for low-order/identity points; a malicious
 * relay could swap a peer key for one and force a known root key. Abort the
 * handshake before deriving anything from a degenerate secret.
 */
function assertNonZeroDH(dh: Uint8Array, label: string): Uint8Array {
  let acc = 0;
  for (let i = 0; i < dh.length; i++) acc |= dh[i];
  if (acc === 0) {
    throw new Error(`X3DH: all-zero ${label} shared secret — low-order point attack`);
  }
  return dh;
}

/** Zero a key-material buffer in place so it doesn't linger in memory. */
function zeroize(buf: Uint8Array): void {
  for (let i = 0; i < buf.length; i++) buf[i] = 0;
}

/**
 * ML-KEM has no low-order-point analogue, but a buggy/malicious implementation
 * (or memory corruption) returning an all-zero shared secret would still be
 * catastrophic — it would make the PQ contribution to the hybrid root key
 * fully predictable. Cheap to check, so we do, mirroring `assertNonZeroDH`.
 */
function assertNonZeroSharedSecret(secret: Uint8Array, label: string): Uint8Array {
  let acc = 0;
  for (let i = 0; i < secret.length; i++) acc |= secret[i];
  if (acc === 0) {
    throw new Error(`PQXDH: all-zero ${label} shared secret`);
  }
  return secret;
}

/**
 * Signed PQ prekey (PQSPK): an ML-KEM-768 public key whose bytes are signed
 * with the OWNER's Ed25519 identity signing key (the same key that signs the
 * classic SPK). The receiver MUST verify `signatureB64` against the bundle's
 * `signingPublicKeyB64` BEFORE encapsulating to `publicKeyB64`, exactly mirroring
 * the classic SPK signature check. The relay transports it as an opaque blob.
 */
export interface PqSignedPreKeyPublic {
  keyId: number;
  /** base64 of the 1184-byte ML-KEM-768 public key. */
  publicKeyB64: string;
  /** base64 of the 64-byte Ed25519 detached signature over the raw pubkey bytes. */
  signatureB64: string;
}

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
  /**
   * Optional PQXDH signed PQ prekey. When PRESENT, the sender derives a v2
   * (post-quantum hybrid) root key. When ABSENT (legacy v1 peer / older relay),
   * the sender falls back to classic v1 X3DH.
   */
  pqSignedPreKey?: PqSignedPreKeyPublic | null;
}

export interface X3DHResult {
  rootKey: Uint8Array;
  myEphemeralPublicKeyB64: string;
  /** Negotiated handshake version actually used to derive `rootKey`. */
  version: HandshakeVersion;
  /**
   * ML-KEM-768 ciphertext (base64 of 1088 bytes) from encapsulating to the
   * peer's PQSPK. Present iff `version === 2`. MUST be sent to the receiver
   * inside the sealed initial message so Bob can decapsulate. The relay only
   * ever sees the opaque sealed envelope, so no relay change is required.
   */
  pqCiphertextB64?: string;
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

  // Intermediates zeroized in `finally` below — none of these leave this
  // function (only myEphemeralPublicKeyB64 and the derived rootKey do), so
  // there is no reason for the raw DH/KEM outputs to linger in memory after
  // the root key has been derived.
  let dh1: Uint8Array | undefined;
  let dh2: Uint8Array | undefined;
  let dh3: Uint8Array | undefined;
  let dh4: Uint8Array | undefined;
  let dhOut: Uint8Array | undefined;
  let combined: Uint8Array | undefined;
  let sharedSecret: Uint8Array | undefined;

  try {
    dh1 = assertNonZeroDH(nacl.scalarMult(myIdentity.secretKey, bobSPK), 'DH1');
    dh2 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobIK), 'DH2');
    dh3 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobSPK), 'DH3');

    const F = new Uint8Array(32).fill(0xFF);
    dhOut = new Uint8Array(F.length + dh1.length + dh2.length + dh3.length);
    dhOut.set(F, 0);
    dhOut.set(dh1, F.length);
    dhOut.set(dh2, F.length + dh1.length);
    dhOut.set(dh3, F.length + dh1.length + dh2.length);

    if (contactBundle.oneTimePreKey) {
      const bobOPK = decodeBase64(contactBundle.oneTimePreKey.publicKeyB64);
      dh4 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobOPK), 'DH4');
      const newDhOut = new Uint8Array(dhOut.length + dh4.length);
      newDhOut.set(dhOut, 0);
      newDhOut.set(dh4, dhOut.length);
      zeroize(dhOut);
      dhOut = newDhOut;
    }

    // PQXDH (v2) layer — only when the peer published a PQ signed prekey.
    // Falls back to v1 otherwise (interop with v1 peers).
    if (contactBundle.pqSignedPreKey) {
      // MANDATORY: verify the Ed25519 signature over the PQSPK BEFORE
      // encapsulating — identical trust model to the classic SPK check above.
      // bobSignK is already validated (length + present) by the SPK block.
      const bobPQPK = decodeBase64(contactBundle.pqSignedPreKey.publicKeyB64);
      const pqSig = decodeBase64(contactBundle.pqSignedPreKey.signatureB64);
      if (bobPQPK.length !== MLKEM768_PUBLICKEY_BYTES) {
        throw new Error('PQXDH: Invalid ML-KEM-768 public key length');
      }
      if (pqSig.length !== nacl.sign.signatureLength) {
        throw new Error('PQXDH: Invalid PQ prekey signature length');
      }
      const validPqSig = nacl.sign.detached.verify(bobPQPK, pqSig, bobSignK);
      if (!validPqSig) {
        throw new Error('PQXDH: Invalid PQ prekey signature — possible key compromise or MITM');
      }

      const encapsulated = ml_kem768.encapsulate(bobPQPK);
      const cipherText = encapsulated.cipherText;
      sharedSecret = encapsulated.sharedSecret;
      if (sharedSecret.length !== MLKEM768_SHAREDSECRET_BYTES) {
        throw new Error('PQXDH: unexpected ML-KEM shared-secret length');
      }
      assertNonZeroSharedSecret(sharedSecret, 'PQXDH encapsulate');

      // Append the PQ shared secret to the END of dhOut (after DH4 if present),
      // then derive with the v2 domain-separation label.
      combined = new Uint8Array(dhOut.length + sharedSecret.length);
      combined.set(dhOut, 0);
      combined.set(sharedSecret, dhOut.length);

      const salt = new Uint8Array(32);
      const info = new TextEncoder().encode(HKDF_INFO_V2);
      const rootKey = hkdfSHA256(combined, salt, info, 32);

      return {
        rootKey,
        myEphemeralPublicKeyB64: encodeBase64(myEK_pub),
        version: 2,
        pqCiphertextB64: encodeBase64(cipherText),
      };
    }

    // v1 fallback — classic X3DH derivation.
    const salt = new Uint8Array(32);
    const info = new TextEncoder().encode(HKDF_INFO_V1);
    const rootKey = hkdfSHA256(dhOut, salt, info, 32);

    return {
      rootKey,
      myEphemeralPublicKeyB64: encodeBase64(myEK_pub),
      version: 1,
    };
  } finally {
    zeroize(myEK_sec);
    if (dh1) zeroize(dh1);
    if (dh2) zeroize(dh2);
    if (dh3) zeroize(dh3);
    if (dh4) zeroize(dh4);
    if (dhOut) zeroize(dhOut);
    if (combined) zeroize(combined);
    if (sharedSecret) zeroize(sharedSecret);
  }
}

/**
 * PQXDH receiver inputs. Present iff the responder is processing a v2 initial
 * message that carried a PQ ciphertext.
 */
export interface X3DHReceiverPqInputs {
  /** ML-KEM-768 ciphertext (raw bytes) Alice sent, to be decapsulated. */
  cipherText: Uint8Array;
  /** This device's ML-KEM-768 PQSPK secret key (2400 bytes). Never leaves device. */
  pqSpkSecret: Uint8Array;
}

/**
 * Perform X3DH from the receiver's perspective (Bob)
 *
 * When `pq` is supplied the receiver derives the v2 (PQXDH) root key by
 * decapsulating the ML-KEM ciphertext with its PQSPK secret and appending the
 * shared secret at the SAME position as the sender, under the v2 label. When
 * `pq` is omitted it derives the classic v1 root key.
 *
 * The CALLER decides whether `pq` must be present via `shouldUsePqReceiver()`,
 * because only the caller knows whether THIS device advertised a PQSPK.
 */
export function performX3DHReceiver(
  myIdentity: Identity,
  mySpkSecret: Uint8Array,
  myOpkSecret: Uint8Array | null,
  aliceIK: Uint8Array,
  aliceEK: Uint8Array,
  pq?: X3DHReceiverPqInputs | null,
): Uint8Array {
  // Intermediates zeroized in `finally` below. NOTE: mySpkSecret/myOpkSecret/
  // myIdentity.secretKey are caller-owned (the SPK in particular is reused
  // across many incoming handshakes) and must NOT be zeroized here.
  let dh1: Uint8Array | undefined;
  let dh2: Uint8Array | undefined;
  let dh3: Uint8Array | undefined;
  let dh4: Uint8Array | undefined;
  let dhOut: Uint8Array | undefined;
  let combined: Uint8Array | undefined;
  let sharedSecret: Uint8Array | undefined;

  try {
    dh1 = assertNonZeroDH(nacl.scalarMult(mySpkSecret, aliceIK), 'DH1');
    dh2 = assertNonZeroDH(nacl.scalarMult(myIdentity.secretKey, aliceEK), 'DH2');
    dh3 = assertNonZeroDH(nacl.scalarMult(mySpkSecret, aliceEK), 'DH3');

    const F = new Uint8Array(32).fill(0xFF);
    dhOut = new Uint8Array(F.length + dh1.length + dh2.length + dh3.length);
    dhOut.set(F, 0);
    dhOut.set(dh1, F.length);
    dhOut.set(dh2, F.length + dh1.length);
    dhOut.set(dh3, F.length + dh1.length + dh2.length);

    if (myOpkSecret) {
      dh4 = assertNonZeroDH(nacl.scalarMult(myOpkSecret, aliceEK), 'DH4');
      const newDhOut = new Uint8Array(dhOut.length + dh4.length);
      newDhOut.set(dhOut, 0);
      newDhOut.set(dh4, dhOut.length);
      zeroize(dhOut);
      dhOut = newDhOut;
    }

    if (pq) {
      if (pq.cipherText.length !== MLKEM768_CIPHERTEXT_BYTES) {
        throw new Error('PQXDH: Invalid ML-KEM-768 ciphertext length');
      }
      if (pq.pqSpkSecret.length !== MLKEM768_SECRETKEY_BYTES) {
        throw new Error('PQXDH: Invalid ML-KEM-768 secret key length');
      }
      // ML-KEM decapsulation is implicit-rejection: a tampered ciphertext yields a
      // DIFFERENT pseudo-random shared secret rather than throwing, so Bob's root
      // key simply diverges from Alice's.
      sharedSecret = ml_kem768.decapsulate(pq.cipherText, pq.pqSpkSecret);
      assertNonZeroSharedSecret(sharedSecret, 'PQXDH decapsulate');
      combined = new Uint8Array(dhOut.length + sharedSecret.length);
      combined.set(dhOut, 0);
      combined.set(sharedSecret, dhOut.length);

      const salt = new Uint8Array(32);
      const info = new TextEncoder().encode(HKDF_INFO_V2);
      return hkdfSHA256(combined, salt, info, 32);
    }

    const salt = new Uint8Array(32);
    const info = new TextEncoder().encode(HKDF_INFO_V1);

    return hkdfSHA256(dhOut, salt, info, 32);
  } finally {
    if (dh1) zeroize(dh1);
    if (dh2) zeroize(dh2);
    if (dh3) zeroize(dh3);
    if (dh4) zeroize(dh4);
    if (dhOut) zeroize(dhOut);
    if (combined) zeroize(combined);
    if (sharedSecret) zeroize(sharedSecret);
  }
}

/**
 * Anti-downgrade decision for the responder.
 *
 * @param weAdvertisedPq   true iff THIS device published a PQSPK in its bundle.
 * @param msgHasCiphertext true iff the inbound initial message carried a PQ ciphertext.
 * @returns 'v2' to require the PQ path, 'v1' for the classic path.
 *
 * POLICY (relaxed, mirrors mobile 2026-06): "advertised PQ but no ciphertext"
 * does NOT abort — that hard-abort broke every first-contact handshake from a
 * legitimate v1 peer (or whenever our own published bundle lacked the PQSPK),
 * causing total message loss. We FALL BACK to v1 (still full X25519 E2EE) and
 * the CALLER surfaces the downgrade via a local-only counter. A strict
 * "PQ-mandatory" mode is a future opt-in for when the whole fleet is v2.
 */
export function shouldUsePqReceiver(
  weAdvertisedPq: boolean,
  msgHasCiphertext: boolean,
): 'v1' | 'v2' {
  if (weAdvertisedPq && msgHasCiphertext) return 'v2';
  // weAdvertisedPq && !msgHasCiphertext → downgrade fallback to v1 (logged by caller).
  // !weAdvertisedPq → v1 (a spurious ciphertext is ignored; cannot weaken below v1).
  return 'v1';
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
  /**
   * PQXDH signed PQ prekey (ML-KEM-768). publicKeyB64 + signatureB64 go in the
   * published bundle; secretKey (2400 bytes) stays on-device only.
   */
  pqSignedPreKey: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
    secretKey: Uint8Array;
  };
}

export function generatePreKeys(
  identity: Identity,
  startOpkId = 1,
  count = 100,
  spkKeyId = 1,
  pqSpkKeyId = 1,
): DevicePreKeySet {
  const spk = nacl.box.keyPair();
  const signature = nacl.sign.detached(spk.publicKey, identity.signingSecretKey);

  // Signed PQ PreKey (ML-KEM-768), signed with the SAME Ed25519 identity key.
  const pq = ml_kem768.keygen();
  const pqSignature = nacl.sign.detached(pq.publicKey, identity.signingSecretKey);

  const oneTimePreKeys: { keyId: number; publicKeyB64: string }[] = [];
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
    pqSignedPreKey: {
      keyId: pqSpkKeyId,
      publicKeyB64: encodeBase64(pq.publicKey),
      signatureB64: encodeBase64(pqSignature),
      secretKey: pq.secretKey,
    },
  };
}
