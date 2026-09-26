import { nacl, ml_kem768 } from '../sodium';
import { vault } from '../sodium/vault';
import { dhWith, decapsulateWith, isVaultKey, type SecretRef } from '../sodium/secretRef';
import { logger } from '../../utils/logger';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { hkdfSHA256 } from './kdf';
import { type Identity } from '../identity';
import { verifyDetached } from '../ed25519';
import { secretB64Equals } from '../secretEquals';

/**
 * Diagnostic-only helper: re-throws any caught value as `[step] Name: message`
 * so a registration failure that dies inside ensureDevicePreKeys/generatePreKeys
 * (native PQ keygen, SQLite prekey writes) names the EXACT sub-operation that
 * broke, instead of a bare "ensureDevicePreKeys failed" caught two frames up in
 * ensureRegistered.ts. Intentionally NOT gated behind `__DEV__` — this is the
 * only signal available once a build ships. Never includes key material: only
 * the JS exception's own name/message.
 */
function tagError(step: string, e: unknown): Error {
  if (e instanceof Error) {
    return new Error(`[${step}] ${e.name || 'Error'}: ${e.message}`);
  }
  let rendered: string;
  try {
    rendered = typeof e === 'string' ? e : JSON.stringify(e);
  } catch {
    rendered = Object.prototype.toString.call(e);
  }
  return new Error(`[${step}] non-Error throw: ${rendered}`);
}

// ─── PQXDH (post-quantum hybrid X3DH, Signal-style) ──────────────────────────
//
// We do NOT replace classic X3DH. The four X25519 DH legs (DH1..DH4) stay byte
// for byte identical; PQXDH only APPENDS an ML-KEM-768 shared secret to the
// concatenated DH output before HKDF, and uses a v2 domain-separation label so
// a v1 and a v2 handshake over the same classical inputs can never derive the
// same root key.
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
 * same classical DH inputs can never collide with a v1-derived key (requirement
 * #6: domain separation). Changing this string is a wire-breaking change.
 */
const HKDF_INFO_V1 = 'AegisLinkX3DH';
const HKDF_INFO_V2 = 'AegisLinkPQXDH';

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
 * the classic SPK signature check (x3dh.ts ~line 57-74).
 *
 * ── RELAY / WIRE-FORMAT NOTE (for backend-lead) ──────────────────────────────
 * The relay must transport this as an OPAQUE blob alongside the existing
 * signedPreKey. New bundle fields the server stores+serves verbatim:
 *   pqSignedPreKey.keyId        : number  (integer key id)
 *   pqSignedPreKey.publicKeyB64 : string  (base64 of 1184-byte ML-KEM-768 pubkey)
 *   pqSignedPreKey.signatureB64 : string  (base64 of 64-byte Ed25519 signature)
 * The relay NEVER inspects, validates or correlates these — same blind-relay
 * contract as the classic SPK. No new metadata, no new timestamps.
 */
export interface PqSignedPreKeyPublic {
  keyId: number;
  /** base64 of the 1184-byte ML-KEM-768 public key. */
  publicKeyB64: string;
  /** base64 of the 64-byte Ed25519 detached signature over the raw pubkey bytes. */
  signatureB64: string;
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
  /**
   * Optional PQXDH signed PQ prekey. When PRESENT, the sender derives a v2
   * (post-quantum hybrid) root key. When ABSENT (legacy v1 peer / older relay),
   * the sender falls back to classic v1 X3DH (requirement #5: interop).
   */
  pqSignedPreKey?: PqSignedPreKeyPublic | null;
}

export interface X3DHResult {
  rootKey: Uint8Array;
  myEphemeralPublicKeyB64: string;
  /** Negotiated handshake version actually used to derive `rootKey`. */
  version: HandshakeVersion;
  /**
   * ML-KEM-768 ciphertext (base64 of 1088 bytes) produced by encapsulating to
   * the peer's PQSPK. Present iff `version === 2`. MUST be sent to the receiver
   * alongside the ephemeral key in the initial message so Bob can decapsulate.
   *
   * ── WIRE-FORMAT NOTE (for backend-lead) ────────────────────────────────────
   * This rides INSIDE the already-sealed initial message (X3DHInitParams /
   * SealedInner), never as a relay-visible field. The relay only ever sees the
   * opaque sealed envelope, so no relay change is required to carry it.
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
  const validSig = verifyDetached(bobSPK, spkSig, bobSignK);
  if (!validSig) {
    throw new Error('X3DH: Invalid SPK signature — possible key compromise or MITM');
  }

  // 2. Generate our Ephemeral Key
  const { publicKey: myEK_pub, secretKey: myEK_sec } = nacl.box.keyPair();

  // Intermediates zeroized in `finally` below — none of these leave this
  // function (only myEphemeralPublicKeyB64 and the derived rootKey do), so
  // there is no reason for the raw DH/KEM outputs to linger in memory after
  // the root key has been derived (requirement: zeroize key intermediates).
  let dh1: Uint8Array | undefined;
  let dh2: Uint8Array | undefined;
  let dh3: Uint8Array | undefined;
  let dh4: Uint8Array | undefined;
  let dhOut: Uint8Array | undefined;
  let combined: Uint8Array | undefined;
  let sharedSecret: Uint8Array | undefined;

  try {
    // 3. Perform DH operations (Signal X3DH spec):
    //    DH1 = DH(IK_sender, SPK_receiver)
    //    DH2 = DH(EK_sender, IK_receiver)
    //    DH3 = DH(EK_sender, SPK_receiver)
    dh1 = assertNonZeroDH(vault.scalarMult(myIdentity.secretKey, bobSPK), 'DH1');
    dh2 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobIK), 'DH2');
    dh3 = assertNonZeroDH(nacl.scalarMult(myEK_sec, bobSPK), 'DH3');

    // Signal spec: prepend 32 bytes of 0xFF before concatenating DH outputs
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

    // 4. PQXDH (v2) layer — only when the peer published a PQ signed prekey.
    //    Falls back to v1 otherwise (requirement #5: interop with v1 peers).
    if (contactBundle.pqSignedPreKey) {
      // 4a. MANDATORY: verify the Ed25519 signature over the PQSPK BEFORE
      //     encapsulating — identical trust model to the classic SPK check above.
      //     A malicious relay that swaps the PQSPK must not be able to learn the
      //     encapsulated secret. bobSignK is already validated (length + present)
      //     by the classic SPK block, so we reuse it.
      const bobPQPK = decodeBase64(contactBundle.pqSignedPreKey.publicKeyB64);
      const pqSig = decodeBase64(contactBundle.pqSignedPreKey.signatureB64);
      if (bobPQPK.length !== MLKEM768_PUBLICKEY_BYTES) {
        throw new Error('PQXDH: Invalid ML-KEM-768 public key length');
      }
      if (pqSig.length !== nacl.sign.signatureLength) {
        throw new Error('PQXDH: Invalid PQ prekey signature length');
      }
      const validPqSig = verifyDetached(bobPQPK, pqSig, bobSignK);
      if (!validPqSig) {
        throw new Error('PQXDH: Invalid PQ prekey signature — possible key compromise or MITM');
      }

      // 4b. Encapsulate to the peer's PQSPK → {cipherText, sharedSecret}.
      const encapsulated = ml_kem768.encapsulate(bobPQPK);
      const cipherText = encapsulated.cipherText;
      sharedSecret = encapsulated.sharedSecret;
      if (sharedSecret.length !== MLKEM768_SHAREDSECRET_BYTES) {
        throw new Error('PQXDH: unexpected ML-KEM shared-secret length');
      }
      assertNonZeroSharedSecret(sharedSecret, 'PQXDH encapsulate');

      // 4c. Append the PQ shared secret to the END of dhOut (after DH4 if present),
      //     then derive with the v2 domain-separation label.
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

    // 4 (v1). Derive Root Key via HKDF (Signal X3DH spec: salt = 0x00…, info = app-specific)
    const salt = new Uint8Array(32); // 32 zero bytes per spec
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
 * PQXDH receiver inputs. `pq` is OPTIONAL: present iff the responder is
 * processing a v2 initial message that carried a PQ ciphertext.
 */
export interface X3DHReceiverPqInputs {
  /** ML-KEM-768 ciphertext (raw bytes) Alice sent, to be decapsulated. */
  cipherText: Uint8Array;
  /** This device's ML-KEM-768 PQSPK: a vault handle in the app (raw 2400 bytes in tests / golden vectors). */
  pqSpkSecret: SecretRef;
}

/**
 * Perform X3DH from the receiver's perspective (Bob)
 * Bob receives Alice's IK and EK, and knows which of his SPK/OPK were used.
 *
 * When `pq` is supplied the receiver derives the v2 (PQXDH) root key: it
 * decapsulates the ML-KEM ciphertext with its PQSPK secret and appends the
 * resulting shared secret to dhOut at the SAME position as the sender, under
 * the v2 domain-separation label. When `pq` is omitted it derives the classic
 * v1 root key (byte-identical to the legacy behaviour).
 *
 * ── ANTI-DOWNGRADE (requirement #5) ──────────────────────────────────────────
 * The CALLER is responsible for deciding whether `pq` must be present, because
 * only the caller knows whether THIS device published a PQSPK (i.e. advertised
 * PQ). The rule:
 *   - device advertised PQ + message carries ciphertext  → pass `pq` (v2).
 *   - device advertised PQ + message has NO ciphertext    → ABORT (downgrade).
 *   - device did NOT advertise PQ                          → omit `pq` (v1).
 * `shouldUsePqReceiver()` below encodes this decision so callers cannot get it
 * subtly wrong.
 */
export function performX3DHReceiver(
  myIdentity: Identity,
  mySpkSecret: SecretRef,
  myOpkSecret: SecretRef | null,
  aliceIK: Uint8Array,
  aliceEK: Uint8Array,
  pq?: X3DHReceiverPqInputs | null,
): Uint8Array {
  // Intermediates zeroized in `finally` below. NOTE: mySpkSecret/myOpkSecret
  // are caller-owned (vault handles in the app; the SPK in particular is reused
  // across many incoming handshakes) and must NOT be zeroized or released here.
  let dh1: Uint8Array | undefined;
  let dh2: Uint8Array | undefined;
  let dh3: Uint8Array | undefined;
  let dh4: Uint8Array | undefined;
  let dhOut: Uint8Array | undefined;
  let combined: Uint8Array | undefined;
  let sharedSecret: Uint8Array | undefined;

  try {
    // Mirror sender's DH order: DH1=DH(SPK,IK_alice), DH2=DH(IK,EK_alice), DH3=DH(SPK,EK_alice)
    dh1 = assertNonZeroDH(dhWith(mySpkSecret, aliceIK), 'DH1');
    dh2 = assertNonZeroDH(vault.scalarMult(myIdentity.secretKey, aliceEK), 'DH2');
    dh3 = assertNonZeroDH(dhWith(mySpkSecret, aliceEK), 'DH3');

    // Signal spec: prepend 32 bytes of 0xFF
    const F = new Uint8Array(32).fill(0xFF);
    dhOut = new Uint8Array(F.length + dh1.length + dh2.length + dh3.length);
    dhOut.set(F, 0);
    dhOut.set(dh1, F.length);
    dhOut.set(dh2, F.length + dh1.length);
    dhOut.set(dh3, F.length + dh1.length + dh2.length);

    if (myOpkSecret) {
      dh4 = assertNonZeroDH(dhWith(myOpkSecret, aliceEK), 'DH4');
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
      if (isVaultKey(pq.pqSpkSecret) ? pq.pqSpkSecret.type !== 'mlkem768' : pq.pqSpkSecret.length !== MLKEM768_SECRETKEY_BYTES) {
        throw new Error('PQXDH: Invalid ML-KEM-768 secret key length');
      }
      // ML-KEM decapsulation is implicit-rejection: a tampered ciphertext does NOT
      // throw, it yields a DIFFERENT (pseudo-random) shared secret. That is exactly
      // what makes the tamper test work — Bob's root key diverges from Alice's.
      sharedSecret = decapsulateWith(pq.cipherText, pq.pqSpkSecret);
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
 * Anti-downgrade decision for the responder (requirement #5).
 *
 * @param weAdvertisedPq  true iff THIS device published a PQSPK in its bundle.
 * @param msgHasCiphertext true iff the inbound initial message carried a PQ ciphertext.
 * @returns 'v2' to require the PQ path, 'v1' for the classic path.
 *
 * POLICY (relaxed, 2026-06): the "advertised PQ but no ciphertext" combination
 * previously THREW to abort as a silent-downgrade defense. In practice that hard
 * abort broke EVERY first-contact handshake whenever the sender ran classic v1 —
 * which happens for any legitimate v1 peer AND whenever our own published bundle
 * lacks the PQSPK (publish gaps). The result was total message loss. We now FALL
 * BACK to v1 (still full X25519 E2EE — the baseline Signal shipped for years)
 * and surface the downgrade via telemetry, rather than dropping the message.
 *
 * A strict "PQ-mandatory" mode (re-introducing the abort) should be a future
 * opt-in flag for when the entire fleet reliably advertises+sends PQ. See the
 * desktop-catchup plan note.
 *
 * The inverse case (we did NOT advertise PQ, yet a ciphertext arrived) is also
 * non-fatal: ignoring a spurious ciphertext cannot weaken security below v1.
 */
export function shouldUsePqReceiver(
  weAdvertisedPq: boolean,
  msgHasCiphertext: boolean,
): 'v1' | 'v2' {
  if (weAdvertisedPq && !msgHasCiphertext) {
    // Downgrade observed — fall back to v1 instead of aborting. NOTE (audit
    // 2026-07): this warning is __DEV__-only, so in shipped builds a PQ downgrade
    // leaves NO trace — a spike that "could indicate an attack OR a bundle-publish
    // regression" is currently NOT observable in production. Do not claim
    // telemetry here until a privacy-preserving aggregate counter (no key
    // material) actually emits in release builds. Confidentiality is unaffected:
    // v1 remains full X25519 E2EE; only the post-quantum guarantee is lost.
    if (__DEV__) {
      logger.warn(
        '[PQXDH] downgrade fallback: advertised a PQ prekey but inbound init carried no ML-KEM ciphertext — proceeding with classic v1 X3DH',
      );
    }
    return 'v1';
  }
  if (weAdvertisedPq && msgHasCiphertext) return 'v2';
  return 'v1';
}

/**
 * The device's prekeys (F-1b phase 2): public material for the bundle, and the
 * secrets ONLY in their persisted form — vault blobs of the identity's profile
 * ("vault1:…", `toStored`). The raw secrets never exist in JavaScript; the
 * receiver loads a blob into a handle when a handshake needs it.
 */
export interface DevicePreKeySet {
  signedPreKey: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
    secretStored: string;
  };
  oneTimePreKeys: { keyId: number; publicKeyB64: string }[];
  /** keyId → persisted OPK secret (vault blob). */
  opkSecrets: Map<number, string>;
  /**
   * PQXDH signed PQ prekey (ML-KEM-768). publicKeyB64 + signatureB64 go in the
   * published bundle; the 2400-byte secret stays in the vault.
   */
  pqSignedPreKey: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
    secretStored: string;
  };
}

/** A fresh vault key of the identity's profile: its public half and persisted form (the handle is released). */
function freshPrekey(slot: string, type: 'x25519prekey' | 'mlkem768'): { publicKey: Uint8Array; stored: string } {
  let k: ReturnType<typeof vault.generateStored>;
  try {
    k = vault.generateStored(slot, type);
  } catch (e) {
    throw tagError(type === 'mlkem768' ? 'ml_kem768.keygen' : 'prekey keygen', e);
  }
  vault.release(k.key);
  return { publicKey: k.key.publicKey, stored: k.stored };
}

/** The public half and (possibly migrated) persisted form of a stored prekey; the handle is released. */
function storedPrekey(slot: string, type: 'x25519prekey' | 'mlkem768', stored: string): { publicKey: Uint8Array; stored: string } {
  const k = vault.openStored(slot, type, stored);
  vault.release(k.key);
  return { publicKey: k.key.publicKey, stored: k.stored };
}

export function generatePreKeys(
  identity: Identity,
  startOpkId = 1,
  count = 100,
  spkKeyId = 1,
  pqSpkKeyId = 1,
): DevicePreKeySet {
  const slot = identity.secretKey.slot;
  // Signed PreKey
  const spk = freshPrekey(slot, 'x25519prekey');
  const signature = vault.sign(identity.signingSecretKey, spk.publicKey);

  // Signed PQ PreKey (ML-KEM-768), signed with the SAME Ed25519 identity key.
  const pq = freshPrekey(slot, 'mlkem768');
  const pqSignature = vault.sign(identity.signingSecretKey, pq.publicKey);

  const oneTimePreKeys: { keyId: number; publicKeyB64: string }[] = [];
  const opkSecrets = new Map<number, string>();

  for (let i = 0; i < count; i++) {
    const opk = freshPrekey(slot, 'x25519prekey');
    const keyId = startOpkId + i;
    oneTimePreKeys.push({
      keyId,
      publicKeyB64: encodeBase64(opk.publicKey)
    });
    opkSecrets.set(keyId, opk.stored);
  }

  return {
    signedPreKey: {
      keyId: spkKeyId,
      publicKeyB64: encodeBase64(spk.publicKey),
      signatureB64: encodeBase64(signature),
      secretStored: spk.stored,
    },
    oneTimePreKeys,
    opkSecrets,
    pqSignedPreKey: {
      keyId: pqSpkKeyId,
      publicKeyB64: encodeBase64(pq.publicKey),
      signatureB64: encodeBase64(pqSignature),
      secretStored: pq.stored,
    },
  };
}

/**
 * Rebuild a DevicePreKeySet (public material + persisted secrets) from the
 * persisted SECRETS.
 *
 * The vault computes each public key from its secret (X25519 base point; the
 * ML-KEM-768 secret embeds its public key, FIPS 203 sk = ek || …); the SPK and
 * PQSPK signatures are recomputed with the identity's Ed25519 key. This
 * guarantees the public material we (re)publish ALWAYS corresponds to the
 * secrets in the durable DB — the single-source-of-truth invariant that fixes
 * the root-key divergence caused by concurrent independent `generatePreKeys`
 * calls. Secrets stored raw before F-1b come back in their vault form, so the
 * caller re-persists them (one-time migration).
 */
function reconstructPreKeySetFromSecrets(
  identity: Identity,
  spkKeyId: number,
  spkStored: string,
  opkStored: Map<number, string>,
  pqSpkKeyId: number,
  pqSpkStored: string,
): DevicePreKeySet {
  const slot = identity.secretKey.slot;
  const spk = storedPrekey(slot, 'x25519prekey', spkStored);
  const signature = vault.sign(identity.signingSecretKey, spk.publicKey);

  const pq = storedPrekey(slot, 'mlkem768', pqSpkStored);
  const pqSignature = vault.sign(identity.signingSecretKey, pq.publicKey);

  const oneTimePreKeys: { keyId: number; publicKeyB64: string }[] = [];
  const opkSecrets = new Map<number, string>();
  // Stable ascending order so the published bundle is deterministic.
  const keyIds = Array.from(opkStored.keys()).sort((a, b) => a - b);
  for (const keyId of keyIds) {
    const opk = storedPrekey(slot, 'x25519prekey', opkStored.get(keyId)!);
    oneTimePreKeys.push({ keyId, publicKeyB64: encodeBase64(opk.publicKey) });
    opkSecrets.set(keyId, opk.stored);
  }

  return {
    signedPreKey: {
      keyId: spkKeyId,
      publicKeyB64: encodeBase64(spk.publicKey),
      signatureB64: encodeBase64(signature),
      secretStored: spk.stored,
    },
    oneTimePreKeys,
    opkSecrets,
    pqSignedPreKey: {
      keyId: pqSpkKeyId,
      publicKeyB64: encodeBase64(pq.publicKey),
      signatureB64: encodeBase64(pqSignature),
      secretStored: pq.stored,
    },
  };
}

/**
 * The raw SPK secret (base64) of a persisted SPK, for the user's OWN linked
 * devices only: device link (screens/Devices.tsx) and the SPK sync after a
 * rotation (socket/client.ts) — both box it to a device key right after. An
 * explicit export (F-1b design doc §5); vaultExport.guard allowlists this file.
 */
export function exportSpkForLinkedDevice(slot: string, spkStored: string): string {
  const { key } = vault.openStored(slot, 'x25519prekey', spkStored);
  try {
    const raw = vault.exportSecret(key);
    try {
      return encodeBase64(raw);
    } finally {
      raw.fill(0);
    }
  } finally {
    vault.release(key);
  }
}

// ── Single-source-of-truth device prekey set ────────────────────────────────
// Serializes concurrent callers (publishToServer fire-and-forget, the socket
// `unknown_identity` handler, Onboarding, profile creation) per active slot so
// two routes can never publish DIFFERENT sets. The first caller generates and
// durably persists ONE set; every subsequent caller (concurrent or later)
// reuses it, reconstructing the public material from the persisted secrets.
const ensurePreKeysInFlight = new Map<string, Promise<DevicePreKeySet>>();

/**
 * Durably persist a PQSPK secret (with the same write-then-readback invariant
 * as the SPK) so we NEVER publish a PQ prekey whose 2400-byte secret we cannot
 * recover. Returns true on confirmed persistence.
 */
async function persistPqSpkWithReadback(
  db: typeof import('../../db/local'),
  keyId: number,
  stored: string,
): Promise<boolean> {
  const b64 = stored;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await db.savePqSpkSecret(keyId, b64);
      const back = await db.loadPqSpkSecret(keyId);
      if (secretB64Equals(back, b64)) {
        try { await db.setPqSpkKeyId(keyId); } catch {/* best-effort */}
        return true;
      }
      lastErr = null; // write succeeded but readback mismatched — no exception to report
    } catch (e) {
      lastErr = e; // retry once, but remember the exception in case both attempts fail
    }
  }
  // Both attempts failed to persist+read back the PQSPK secret. If we captured
  // a real exception (vs. a silent readback mismatch), surface it tagged so the
  // caller's "refusing to publish" error names the underlying SQLite/native
  // failure instead of just "false".
  if (lastErr != null) throw tagError('persistPqSpk', lastErr);
  return false;
}

/**
 * Return THE device's prekey set for the active slot — creating and durably
 * persisting it exactly once. All registration / re-registration routes MUST
 * use this instead of calling `generatePreKeys` directly, so the public bundle
 * published to the relay always matches the secrets stored on device.
 *
 * Invariant preserved: a freshly generated SPK secret (and, for PQXDH, the
 * ML-KEM-768 PQSPK secret) is written to the durable DB and read back BEFORE
 * the set is returned; if the readback fails we throw (the caller must not
 * publish a prekey whose secret it cannot recover).
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

        // PQSPK migration: installs created before PQXDH have an SPK but no
        // PQSPK. Lazily generate + durably persist ONE PQSPK on first reuse so
        // the device upgrades to PQ-capable without regenerating its classic
        // prekeys (preserving in-flight v1 sessions). If persistence fails we
        // refuse to publish a PQSPK we can't read back, just like the SPK.
        let pqSpkKeyId = await db.getPqSpkKeyId();
        let pqSpkStored: string | null = null;
        if (pqSpkKeyId !== null) {
          pqSpkStored = await db.loadPqSpkSecret(pqSpkKeyId);
        }
        if (!pqSpkStored) {
          const pq = freshPrekey(identity.secretKey.slot, 'mlkem768');
          const newPqKeyId = (pqSpkKeyId ?? 0) + 1;
          const ok = await persistPqSpkWithReadback(db, newPqKeyId, pq.stored);
          if (!ok) {
            throw new Error(
              `ensureDevicePreKeys: could not persist PQSPK secret for keyId ${newPqKeyId} — refusing to publish`,
            );
          }
          pqSpkKeyId = newPqKeyId;
          pqSpkStored = pq.stored;
        }

        // Both branches above guarantee a non-null PQSPK keyId + secret. Assert
        // the invariant so the type narrows and we never publish a half-built set.
        if (pqSpkKeyId === null) {
          throw new Error('ensureDevicePreKeys: PQSPK keyId unexpectedly null after ensure');
        }

        const set = reconstructPreKeySetFromSecrets(
          identity,
          spkKeyId,
          spkSecretB64,
          opkSecretsB64,
          pqSpkKeyId,
          pqSpkStored,
        );
        // F-1b one-time migration: secrets stored raw before the vault come
        // back as vault blobs — replace the raw copies (best-effort per row;
        // an unmigrated row keeps working and migrates on a later call).
        if (set.signedPreKey.secretStored !== spkSecretB64) {
          try { await db.saveSpkSecret(spkKeyId, set.signedPreKey.secretStored); } catch {/* retried next time */}
        }
        if (set.pqSignedPreKey.secretStored !== pqSpkStored) {
          try { await db.savePqSpkSecret(pqSpkKeyId, set.pqSignedPreKey.secretStored); } catch {/* retried next time */}
        }
        for (const [keyId, stored] of set.opkSecrets) {
          if (stored !== opkSecretsB64.get(keyId)) {
            try { await db.saveOpkSecret(keyId, stored); } catch {/* retried next time */}
          }
        }
        return set;
      }
    }

    // 2. No durable set yet — generate one, persist it (with readback), return it.
    const set = generatePreKeys(identity, 1, 100, 1, 1);
    const spkSecretB64 = set.signedPreKey.secretStored;

    let persisted = false;
    let spkLastErr: unknown = null;
    for (let attempt = 1; attempt <= 2 && !persisted; attempt++) {
      try {
        await db.saveSpkSecret(set.signedPreKey.keyId, spkSecretB64);
        const back = await db.loadSpkSecret(set.signedPreKey.keyId);
        if (secretB64Equals(back, spkSecretB64)) { persisted = true; spkLastErr = null; }
      } catch (e) {
        spkLastErr = e; // retry once, but remember the exception in case both attempts fail
      }
    }
    if (!persisted) {
      // Surface the underlying exception (if any) so this doesn't read as a
      // generic failure — a real SQLite/native error should name itself here.
      if (spkLastErr != null) throw tagError('saveSpkSecret', spkLastErr);
      throw new Error(
        `ensureDevicePreKeys: could not persist SPK secret for keyId ${set.signedPreKey.keyId} — refusing to publish`,
      );
    }

    // Persist the PQSPK with the SAME never-publish-what-we-can't-read-back
    // invariant. PQXDH is the default for fresh installs, so a PQSPK we can't
    // recover would silently break every inbound v2 handshake.
    const pqOk = await persistPqSpkWithReadback(
      db, set.pqSignedPreKey.keyId, set.pqSignedPreKey.secretStored,
    );
    if (!pqOk) {
      throw new Error(
        `ensureDevicePreKeys: could not persist PQSPK secret for keyId ${set.pqSignedPreKey.keyId} — refusing to publish`,
      );
    }

    try { await db.setSpkKeyId(set.signedPreKey.keyId); } catch {/* best-effort */}
    // Start the SPK age clock for the age-based rotation trigger (B-3).
    try { await db.setSpkCreatedAt(Date.now()); } catch {/* best-effort */}
    for (const [keyId, stored] of set.opkSecrets.entries()) {
      try { await db.saveOpkSecret(keyId, stored); } catch {/* best-effort */}
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
