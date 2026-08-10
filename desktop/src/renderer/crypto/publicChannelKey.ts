/**
 * AegisLink — Sealed Public Channels crypto primitives (Phase 2, mobile port)
 *
 * Verbatim-compatible port of server/src/crypto/publicChannelKey.ts. Same labels,
 * same byte layouts, same algorithms — only the crypto backend differs:
 *   node:crypto (createHash/hkdfSync/timingSafeEqual)  →  @noble/hashes + tweetnacl.
 *
 * Cross-platform parity is load-bearing: a channelId/delivery-token/signature/
 * sealed-post produced here MUST be byte-identical to the server (and desktop in
 * Phase 3). Known-answer vectors in __tests__/publicChannelKey.parity.test.ts
 * lock this against the server module. Do NOT "optimize" any serialization here
 * without regenerating those vectors — a drift silently breaks interop.
 *
 * Properties (mirrors server doc §2–§7, §12–§13):
 *  - The relay never sees `from`, `body`, `seqNum`, or `prevHash`.
 *  - Posts are always encrypted, even for public channels.
 *  - Hash chain binds post order + signature — relay cannot reorder/inject.
 *  - Delivery token derived from capability — proves CEK possession anonymously.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
// Desktop is on @noble/hashes 2.x, which requires the explicit .js specifier;
// mobile is still on 1.x, where the bare path resolves. The ONLY difference
// between this file and mobile/src/crypto/publicChannelKey.ts. Keep it that way:
// this is channel key derivation, and it has to agree byte-for-byte with the
// other platform or a channel created on one is unreadable on the other.
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

const { encodeBase64, decodeBase64 } = naclUtil;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// §2 — Channel identity
// ---------------------------------------------------------------------------

/** Channel ID bytes (128-bit, same as mailbox IDs). */
export const CHANNEL_ID_BYTES = 16;

const CHANNEL_ID_LABEL = 'aegislink/CHANNEL_ID';

/** Derive channelId from the channel's Ed25519 public key + salt. */
export function deriveChannelId(channelEd25519Pub: Uint8Array, salt: Uint8Array): string {
  if (channelEd25519Pub.length !== nacl.sign.publicKeyLength) {
    throw new Error('deriveChannelId: invalid public key length');
  }
  if (salt.length !== 16) {
    throw new Error('deriveChannelId: salt must be 16 bytes');
  }
  // sha256 over LABEL ‖ pub ‖ salt — concatenation equals the server's chained
  // .update() calls.
  const digest = sha256(concat([encoder.encode(CHANNEL_ID_LABEL), channelEd25519Pub, salt]));
  return encodeBase64(digest.subarray(0, CHANNEL_ID_BYTES));
}

/** Generate a new channel keypair + salt. Returns everything needed to create a channel. */
export function generateChannelIdentity() {
  const keyPair = nacl.sign.keyPair();
  const salt = nacl.randomBytes(16);
  const channelId = deriveChannelId(keyPair.publicKey, salt);
  return { channelId, channelEd25519Pub: keyPair.publicKey, channelEd25519Secret: keyPair.secretKey, salt };
}

// ---------------------------------------------------------------------------
// §4.1–4.2 — CEK (Channel Encryption Key) + content key wrap
// ---------------------------------------------------------------------------

const CONTENT_KEY_WRAP_LABEL = 'aegislink/CHANNEL_CONTENT_KEY_WRAP';
const DELIVERY_TOKEN_LABEL = 'aegislink/CHANNEL_DELIVERY_TOKEN';

/** Generate a fresh 256-bit CEK. */
export function generateCEK(): Uint8Array {
  return nacl.randomBytes(32);
}

/** Derive the wrap key from a capability (32 bytes) + channelId. */
export function deriveWrapKey(capability: Uint8Array, channelId: string): Uint8Array {
  if (capability.length !== 32) throw new Error('deriveWrapKey: capability must be 32 bytes');
  const channelIdBytes = decodeBase64(channelId);
  // noble hkdf(hash, ikm, salt, info, length) — same (ikm, salt, info) semantics
  // as node hkdfSync('sha256', ikm, salt, info, len).
  return hkdf(sha256, capability, channelIdBytes, encoder.encode(CONTENT_KEY_WRAP_LABEL), 32);
}

/**
 * Wrap (encrypt) CEK with XSalsa20-Poly1305 (nacl.secretbox) using a key derived
 * from capability. Returns { iv, wrapped } both base64-encoded.
 */
export function wrapCEK(
  cek: Uint8Array,
  capability: Uint8Array,
  channelId: string
): { ivB64: string; wrappedB64: string } {
  if (cek.length !== 32) throw new Error('wrapCEK: CEK must be 32 bytes');
  const wrapKey = deriveWrapKey(capability, channelId);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const wrapped = nacl.secretbox(cek, nonce, wrapKey);
  try {
    return { ivB64: encodeBase64(nonce), wrappedB64: encodeBase64(wrapped) };
  } finally {
    wrapKey.fill(0); // golden rule #9
  }
}

/** Unwrap (decrypt) CEK. Returns the raw 32-byte key or null on failure. */
export function unwrapCEK(
  ivB64: string,
  wrappedB64: string,
  capability: Uint8Array,
  channelId: string
): Uint8Array | null {
  const wrapKey = deriveWrapKey(capability, channelId);
  try {
    const nonce = decodeBase64(ivB64);
    const wrapped = decodeBase64(wrappedB64);
    const cek = nacl.secretbox.open(wrapped, nonce, wrapKey);
    if (!cek || cek.length !== 32) return null;
    return cek;
  } catch {
    return null;
  } finally {
    wrapKey.fill(0);
  }
}

// ---------------------------------------------------------------------------
// §4.4 — Delivery token (derived from capability)
// ---------------------------------------------------------------------------

/** Derive channel delivery token from capability + channelId (base64url, no pad). */
export function deriveChannelDeliveryToken(capability: Uint8Array, channelId: string): string {
  const channelIdBytes = decodeBase64(channelId);
  const token = hkdf(sha256, capability, channelIdBytes, encoder.encode(DELIVERY_TOKEN_LABEL), 16);
  return base64url(token);
}

/** Hash a channel delivery token for at-rest storage (matches server exactly). */
export function hashChannelDeliveryToken(rawToken: string): string {
  return encodeBase64(sha256(encoder.encode(rawToken)));
}

/** Constant-time verify a channel delivery token. */
export function verifyChannelDeliveryToken(rawToken: string, storedHashB64: string): boolean {
  if (typeof rawToken !== 'string' || typeof storedHashB64 !== 'string') return false;
  let presented: Uint8Array;
  let stored: Uint8Array;
  try {
    presented = decodeBase64(hashChannelDeliveryToken(rawToken));
    stored = decodeBase64(storedHashB64);
  } catch {
    return false;
  }
  // nacl.verify is constant-time but requires equal length; guard length without
  // an early-return timing leak (golden rule #8).
  if (presented.length !== stored.length) {
    nacl.verify(presented, presented);
    return false;
  }
  return nacl.verify(presented, stored);
}

// ---------------------------------------------------------------------------
// §3.3 — Manifest signing
// ---------------------------------------------------------------------------

const MANIFEST_LABEL = encoder.encode('aegislink/CHANNEL_MANIFEST');

export interface ChannelManifestData {
  channelId: string;
  salt: Uint8Array;
  channelEd25519Pub: Uint8Array;
  name: string;
  description: string;
  avatarHash: Uint8Array | null;
  channelType: 0 | 1 | 2 | 3; // open | readonly | moderated | approval
  createdAtHourMs: number;
  manifestSeq: number;
  contentKeyHash: Uint8Array | null;
  delegationsHash: Uint8Array;
  revokedHash: Uint8Array;
  pinnedPostSeq: number;
  discussionsEnabled: boolean;
}

/** Build the byte-exact signed-input for a manifest (§3.2). */
export function buildManifestSignedInput(m: ChannelManifestData): Uint8Array {
  const nameHash = sha256Bytes(encoder.encode(m.name));
  const descHash = sha256Bytes(encoder.encode(m.description));

  const parts: Uint8Array[] = [
    decodeBase64(m.channelId),             // 16
    m.salt,                                 // 16
    m.channelEd25519Pub,                    // 32
    nameHash,                               // 32
    descHash,                               // 32
    u8(m.avatarHash ? 1 : 0),              // 1
  ];
  if (m.avatarHash) parts.push(m.avatarHash); // 32
  parts.push(
    u8(m.channelType),                      // 1
    u64be(m.createdAtHourMs),               // 8
    u64be(m.manifestSeq),                   // 8
    u8(m.contentKeyHash ? 1 : 0),           // 1
  );
  if (m.contentKeyHash) parts.push(m.contentKeyHash); // 32
  parts.push(
    m.delegationsHash,                      // 32
    m.revokedHash,                          // 32
    i64be(m.pinnedPostSeq),                 // 8
    u8(m.discussionsEnabled ? 1 : 0),       // 1
  );
  return concat(parts);
}

/** Sign a manifest. Returns the 64-byte Ed25519 signature. */
export function signManifest(
  manifest: ChannelManifestData,
  channelEd25519Secret: Uint8Array
): Uint8Array {
  const input = buildManifestSignedInput(manifest);
  const labeled = concat([MANIFEST_LABEL, input]);
  return nacl.sign.detached(labeled, channelEd25519Secret);
}

/** Verify a manifest signature. */
export function verifyManifest(
  manifest: ChannelManifestData,
  sig: Uint8Array
): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  const input = buildManifestSignedInput(manifest);
  const labeled = concat([MANIFEST_LABEL, input]);
  return nacl.sign.detached.verify(labeled, sig, manifest.channelEd25519Pub);
}

/**
 * Extract the AUTHORITATIVE channel signing public key from a stored, signed
 * manifest blob (JSON). Admin actions (delete/ban/tombstone) MUST be verified
 * against THIS key — never against a client-supplied pubkey (golden rules #3, #7).
 *
 * Re-derives the channelId from (pub, salt) and checks it matches the blob's
 * channelId, so a tampered blob whose pub no longer binds to the id is rejected.
 * Returns the 32-byte pubkey, or null on any parse/binding failure.
 */
export function extractChannelSignerPub(manifestBlobStr: string): Uint8Array | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(manifestBlobStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  try {
    const channelId = parsed['channelId'];
    const pubB64 = parsed['channelEd25519Pub'];
    const saltB64 = parsed['salt'];
    if (typeof channelId !== 'string' || typeof pubB64 !== 'string' || typeof saltB64 !== 'string') {
      return null;
    }
    const pub = decodeBase64(pubB64);
    const salt = decodeBase64(saltB64);
    if (pub.length !== nacl.sign.publicKeyLength || salt.length !== 16) return null;
    // Binding check: the id must be reproducible from this exact pub + salt.
    if (deriveChannelId(pub, salt) !== channelId) return null;
    return pub;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// §13 — Admin action signatures (delete / ban) — domain-separated
// ---------------------------------------------------------------------------

const DELETE_LABEL = encoder.encode('aegislink/CHANNEL_DELETE');
const BAN_LABEL = encoder.encode('aegislink/CHANNEL_BAN');

function deleteSignedInput(channelId: string, seqNum: number): Uint8Array {
  return concat([DELETE_LABEL, decodeBase64(channelId), u64be(seqNum)]);
}

/** Sign a post-deletion with the channel's private key. */
export function signDelete(channelId: string, seqNum: number, channelEd25519Secret: Uint8Array): Uint8Array {
  return nacl.sign.detached(deleteSignedInput(channelId, seqNum), channelEd25519Secret);
}

/** Verify a post-deletion signature against the channel's public key. */
export function verifyDelete(channelId: string, seqNum: number, sig: Uint8Array, channelEd25519Pub: Uint8Array): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  return nacl.sign.detached.verify(deleteSignedInput(channelId, seqNum), sig, channelEd25519Pub);
}

function banSignedInput(channelId: string, banRecord: string): Uint8Array {
  return concat([BAN_LABEL, decodeBase64(channelId), encoder.encode(banRecord)]);
}

/** Sign a ban record with the channel's private key. */
export function signBan(channelId: string, banRecord: string, channelEd25519Secret: Uint8Array): Uint8Array {
  return nacl.sign.detached(banSignedInput(channelId, banRecord), channelEd25519Secret);
}

/** Verify a ban-record signature against the channel's public key. */
export function verifyBan(channelId: string, banRecord: string, sig: Uint8Array, channelEd25519Pub: Uint8Array): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  return nacl.sign.detached.verify(banSignedInput(channelId, banRecord), sig, channelEd25519Pub);
}

// ---------------------------------------------------------------------------
// §10.2 — Approval-gated join (Phase 4)
//
// Owner-signed relay actions (pending list / approve) + the capability
// envelope: the owner seals the 32-byte capability to the applicant's
// ephemeral X25519 pubkey via box.before + HKDF + secretbox (same primitive
// family as wrapCEK — the doc's AES-GCM is realized as XSalsa20-Poly1305,
// matching every other envelope in the app).
// ---------------------------------------------------------------------------

const PENDING_LIST_LABEL = encoder.encode('aegislink/CHANNEL_PENDING_LIST');
const APPROVE_LABEL = encoder.encode('aegislink/CHANNEL_APPROVE');
const APPROVAL_WRAP_LABEL = 'aegislink/APPROVAL_WRAP';

function pendingListSignedInput(channelId: string, ts: number): Uint8Array {
  return concat([PENDING_LIST_LABEL, decodeBase64(channelId), u64be(ts)]);
}

/** Sign a pending-joins listing request (owner-only read). */
export function signPendingList(channelId: string, ts: number, channelEd25519Secret: Uint8Array): Uint8Array {
  return nacl.sign.detached(pendingListSignedInput(channelId, ts), channelEd25519Secret);
}

function approveSignedInput(channelId: string, joinEpkB64: string, ts: number): Uint8Array {
  return concat([APPROVE_LABEL, decodeBase64(channelId), encoder.encode(joinEpkB64), u64be(ts)]);
}

/** Sign an approve/reject decision for a pending joinEpk. */
export function signApprove(channelId: string, joinEpkB64: string, ts: number, channelEd25519Secret: Uint8Array): Uint8Array {
  return nacl.sign.detached(approveSignedInput(channelId, joinEpkB64, ts), channelEd25519Secret);
}

/** Applicant side: fresh ephemeral X25519 keypair for one join request. */
export function generateJoinEphemeral(): nacl.BoxKeyPair {
  return nacl.box.keyPair();
}

export interface ApprovalEnvelope {
  adminEpkB64: string;
  ivB64: string;
  wrappedB64: string;
}

/** Derive the approval wrap key from an X25519 shared secret (zeroize after). */
function deriveApprovalWrapKey(shared: Uint8Array, channelId: string): Uint8Array {
  return hkdf(sha256, shared, decodeBase64(channelId), encoder.encode(APPROVAL_WRAP_LABEL), 32);
}

/** Owner: seal the capability to the applicant's joinEpk (docs §10.2 step 6). */
export function sealApprovalCapability(
  capability: Uint8Array,
  joinEpkB64: string,
  channelId: string,
): ApprovalEnvelope {
  if (capability.length !== 32) throw new Error('sealApprovalCapability: capability must be 32 bytes');
  const joinEpk = decodeBase64(joinEpkB64);
  if (joinEpk.length !== nacl.box.publicKeyLength) throw new Error('sealApprovalCapability: bad joinEpk');
  const adminEph = nacl.box.keyPair();
  const shared = nacl.box.before(joinEpk, adminEph.secretKey);
  const wrapKey = deriveApprovalWrapKey(shared, channelId);
  try {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const wrapped = nacl.secretbox(capability, nonce, wrapKey);
    return { adminEpkB64: encodeBase64(adminEph.publicKey), ivB64: encodeBase64(nonce), wrappedB64: encodeBase64(wrapped) };
  } finally {
    // golden rule #9 — zeroize DH output + derived key + ephemeral secret
    shared.fill(0);
    wrapKey.fill(0);
    adminEph.secretKey.fill(0);
  }
}

/** Applicant: open the sealed capability with the join ephemeral secret. */
export function openApprovalCapability(
  envelope: ApprovalEnvelope,
  joinEskSecret: Uint8Array,
  channelId: string,
): Uint8Array | null {
  let shared: Uint8Array | null = null;
  let wrapKey: Uint8Array | null = null;
  try {
    const adminEpk = decodeBase64(envelope.adminEpkB64);
    if (adminEpk.length !== nacl.box.publicKeyLength) return null;
    shared = nacl.box.before(adminEpk, joinEskSecret);
    wrapKey = deriveApprovalWrapKey(shared, channelId);
    const capability = nacl.secretbox.open(decodeBase64(envelope.wrappedB64), decodeBase64(envelope.ivB64), wrapKey);
    if (!capability || capability.length !== 32) return null;
    return capability;
  } catch {
    return null;
  } finally {
    shared?.fill(0);
    wrapKey?.fill(0);
  }
}

// ---------------------------------------------------------------------------
// §6 — Post encryption + hash chain
// ---------------------------------------------------------------------------

const POST_LABEL = encoder.encode('aegislink/CHANNEL_POST');
const POST_CHAIN_LABEL = encoder.encode('aegislink/CHANNEL_POST_CHAIN');

export interface ChannelPostInner {
  from: string;       // sender aegisId
  body: string;
  ts: number;
  seqNum: number;
  prevHash: Uint8Array; // 32 bytes
  ttlMs: number;       // 0 = permanent
  attachmentsHash: Uint8Array; // SHA-256 of serialized attachments, or all-zero
}

/** Build post signed-input (§6.2). */
export function buildPostSignedInput(channelId: string, p: ChannelPostInner): Uint8Array {
  const bodyHash = sha256Bytes(encoder.encode(p.body));
  return concat([
    decodeBase64(channelId),    // 16
    u64be(p.seqNum),            // 8
    p.prevHash,                 // 32
    u64be(p.ts),                // 8
    bodyHash,                   // 32
    p.attachmentsHash,          // 32
    u64be(p.ttlMs),             // 8
  ]);
}

/** Sign a post with the sender's Ed25519 key. */
export function signPost(
  channelId: string,
  post: ChannelPostInner,
  senderEd25519Secret: Uint8Array
): Uint8Array {
  const input = buildPostSignedInput(channelId, post);
  const labeled = concat([POST_LABEL, input]);
  return nacl.sign.detached(labeled, senderEd25519Secret);
}

/** Verify a post signature. */
export function verifyPostSignature(
  channelId: string,
  post: ChannelPostInner,
  sig: Uint8Array,
  signerEd25519Pub: Uint8Array
): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  const input = buildPostSignedInput(channelId, post);
  const labeled = concat([POST_LABEL, input]);
  return nacl.sign.detached.verify(labeled, sig, signerEd25519Pub);
}

/** Compute the hash chain entry for a post (§6.3). Includes sig in hash. */
export function computePostHash(channelId: string, post: ChannelPostInner, sig: Uint8Array): Uint8Array {
  const bodyHash = sha256Bytes(encoder.encode(post.body));
  const input = concat([
    POST_CHAIN_LABEL,
    decodeBase64(channelId),
    u64be(post.seqNum),
    post.prevHash,
    u64be(post.ts),
    bodyHash,
    post.attachmentsHash,
    u64be(post.ttlMs),
    sig,                    // 64 bytes — chain includes signature
  ]);
  return sha256Bytes(input);
}

/** Verify that post N's prevHash matches the computed hash of post N-1. */
export function verifyChainLink(
  channelId: string,
  prevPost: ChannelPostInner,
  prevSig: Uint8Array,
  currentPrevHash: Uint8Array
): boolean {
  const expected = computePostHash(channelId, prevPost, prevSig);
  if (expected.length !== currentPrevHash.length) return false;
  return nacl.verify(expected, currentPrevHash);
}

/** Encrypt a post for the channel (§6.4). Returns wire-ready sealed blob. */
export function sealChannelPost(
  channelId: string,
  post: ChannelPostInner,
  senderEd25519Secret: Uint8Array,
  cek: Uint8Array
): { ciphertextB64: string; nonceB64: string; postHash: Uint8Array } {
  const sig = signPost(channelId, post, senderEd25519Secret);
  const postHash = computePostHash(channelId, post, sig);

  const inner = JSON.stringify({
    i: {
      from: post.from,
      body: post.body,
      ts: post.ts,
      seqNum: post.seqNum,
      prevHash: encodeBase64(post.prevHash),
      ttlMs: post.ttlMs,
      attachmentsHash: encodeBase64(post.attachmentsHash),
    },
    s: encodeBase64(sig),
  });

  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(encoder.encode(inner), nonce, cek);
  return {
    ciphertextB64: encodeBase64(ciphertext),
    nonceB64: encodeBase64(nonce),
    postHash,
  };
}

export interface OpenedChannelPost {
  post: ChannelPostInner;
  sig: Uint8Array;
  postHash: Uint8Array;
}

/** Open and authenticate a sealed channel post. Returns null on any failure. */
export function openChannelPost(
  channelId: string,
  ciphertextB64: string,
  nonceB64: string,
  cek: Uint8Array,
  resolveSigningKey: (from: string) => Uint8Array | null
): OpenedChannelPost | null {
  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  try {
    ciphertext = decodeBase64(ciphertextB64);
    nonce = decodeBase64(nonceB64);
  } catch { return null; }

  // Fail closed on malformed wire: nacl.secretbox.open THROWS on a wrong-length
  // nonce/key (checkLengths), which a malicious relay could exploit to crash the
  // live-message handler. Guard so a bad blob is dropped (null), not thrown.
  if (nonce.length !== nacl.secretbox.nonceLength) return null;
  const plaintext = nacl.secretbox.open(ciphertext, nonce, cek);
  if (!plaintext) return null;

  let outer: { i: Record<string, unknown>; s: string };
  try {
    outer = JSON.parse(decoder.decode(plaintext)) as { i: Record<string, unknown>; s: string };
  } catch { return null; }

  if (!outer.i || typeof outer.s !== 'string') return null;

  let sig: Uint8Array;
  try { sig = decodeBase64(outer.s); } catch { return null; }

  const raw = outer.i as {
    from: string; body: string; ts: number; seqNum: number;
    prevHash: string; ttlMs: number; attachmentsHash: string;
  };

  if (typeof raw.from !== 'string' || typeof raw.body !== 'string') return null;
  if (typeof raw.ts !== 'number' || typeof raw.seqNum !== 'number') return null;

  let prevHash: Uint8Array;
  let attachmentsHash: Uint8Array;
  try {
    prevHash = decodeBase64(raw.prevHash);
    attachmentsHash = decodeBase64(raw.attachmentsHash);
  } catch { return null; }

  const post: ChannelPostInner = {
    from: raw.from,
    body: raw.body,
    ts: raw.ts,
    seqNum: raw.seqNum,
    prevHash,
    ttlMs: raw.ttlMs ?? 0,
    attachmentsHash,
  };

  // Verify sender signature
  const signerPub = resolveSigningKey(post.from);
  if (!signerPub) return null;
  if (!verifyPostSignature(channelId, post, sig, signerPub)) return null;

  const postHash = computePostHash(channelId, post, sig);
  return { post, sig, postHash };
}

// ---------------------------------------------------------------------------
// §7 — Editor delegation certs
// ---------------------------------------------------------------------------

const DELEGATION_LABEL = encoder.encode('aegislink/CHANNEL_DELEGATION');

export interface DelegationCertData {
  channelId: string;
  delegateeEd25519Pub: Uint8Array;
  validFrom: number;
  validUntil: number;
  delegationSeq: number;
}

/** Build delegation signed-input (§7.2). */
export function buildDelegationSignedInput(d: DelegationCertData): Uint8Array {
  return concat([
    decodeBase64(d.channelId),     // 16
    d.delegateeEd25519Pub,          // 32
    u64be(d.validFrom),             // 8
    u64be(d.validUntil),            // 8
    u64be(d.delegationSeq),         // 8
  ]);
}

/** Sign a delegation cert with the channel's private key. */
export function signDelegation(
  cert: DelegationCertData,
  channelEd25519Secret: Uint8Array
): Uint8Array {
  const input = buildDelegationSignedInput(cert);
  const labeled = concat([DELEGATION_LABEL, input]);
  return nacl.sign.detached(labeled, channelEd25519Secret);
}

/** Verify a delegation cert against the channel's public key. */
export function verifyDelegation(
  cert: DelegationCertData,
  sig: Uint8Array,
  channelEd25519Pub: Uint8Array
): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  const input = buildDelegationSignedInput(cert);
  const labeled = concat([DELEGATION_LABEL, input]);
  return nacl.sign.detached.verify(labeled, sig, channelEd25519Pub);
}

/** Validate a delegated post: cert is valid + post sig matches delegatee. */
export function verifyDelegatedPost(
  channelId: string,
  post: ChannelPostInner,
  postSig: Uint8Array,
  cert: DelegationCertData,
  certSig: Uint8Array,
  channelEd25519Pub: Uint8Array,
  revokedSeqs: ReadonlySet<number>
): boolean {
  if (revokedSeqs.has(cert.delegationSeq)) return false;
  if (!verifyDelegation(cert, certSig, channelEd25519Pub)) return false;
  if (cert.validFrom > 0 && post.ts < cert.validFrom) return false;
  if (cert.validUntil > 0 && post.ts > cert.validUntil) return false;
  return verifyPostSignature(channelId, post, postSig, cert.delegateeEd25519Pub);
}

// ---------------------------------------------------------------------------
// §12 — Channel tombstone
// ---------------------------------------------------------------------------

const TOMBSTONE_LABEL = encoder.encode('aegislink/CHANNEL_TOMBSTONE');

/** Sign a channel tombstone. */
export function signTombstone(
  channelId: string,
  ts: number,
  channelEd25519Secret: Uint8Array
): Uint8Array {
  const input = concat([TOMBSTONE_LABEL, decodeBase64(channelId), u64be(ts)]);
  return nacl.sign.detached(input, channelEd25519Secret);
}

/** Verify a channel tombstone. */
export function verifyTombstone(
  channelId: string,
  ts: number,
  sig: Uint8Array,
  channelEd25519Pub: Uint8Array
): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  const input = concat([TOMBSTONE_LABEL, decodeBase64(channelId), u64be(ts)]);
  return nacl.sign.detached.verify(input, sig, channelEd25519Pub);
}

// ---------------------------------------------------------------------------
// §14 — Avatar association signatures (domain-separated)
// ---------------------------------------------------------------------------

const AVATAR_SET_LABEL = encoder.encode('aegislink/CHANNEL_AVATAR_SET');
const AVATAR_DELETE_LABEL = encoder.encode('aegislink/CHANNEL_AVATAR_DELETE');

function avatarSetSignedInput(channelId: string, blobId: string): Uint8Array {
  return concat([AVATAR_SET_LABEL, decodeBase64(channelId), encoder.encode(blobId)]);
}

/** Sign an avatar-set action with the channel's private key. */
export function signAvatarSet(
  channelId: string,
  blobId: string,
  channelEd25519Secret: Uint8Array
): Uint8Array {
  return nacl.sign.detached(avatarSetSignedInput(channelId, blobId), channelEd25519Secret);
}

/** Verify an avatar-set signature against the channel's public key. */
export function verifyAvatarSet(
  channelId: string,
  blobId: string,
  sig: Uint8Array,
  channelEd25519Pub: Uint8Array
): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  return nacl.sign.detached.verify(
    avatarSetSignedInput(channelId, blobId),
    sig,
    channelEd25519Pub
  );
}

function avatarDeleteSignedInput(channelId: string): Uint8Array {
  return concat([AVATAR_DELETE_LABEL, decodeBase64(channelId)]);
}

/** Sign an avatar-delete action with the channel's private key. */
export function signAvatarDelete(
  channelId: string,
  channelEd25519Secret: Uint8Array
): Uint8Array {
  return nacl.sign.detached(avatarDeleteSignedInput(channelId), channelEd25519Secret);
}

/** Verify an avatar-delete signature against the channel's public key. */
export function verifyAvatarDelete(
  channelId: string,
  sig: Uint8Array,
  channelEd25519Pub: Uint8Array
): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  return nacl.sign.detached.verify(
    avatarDeleteSignedInput(channelId),
    sig,
    channelEd25519Pub
  );
}

// ---------------------------------------------------------------------------
// Utility helpers (pure, no side effects)
// ---------------------------------------------------------------------------

function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/** base64url without padding — matches node Buffer.toString('base64url'). */
function base64url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function u8(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

function u64be(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(Math.max(0, Math.floor(n))), false);
  return buf;
}

function i64be(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigInt64(0, BigInt(Math.floor(n)), false);
  return buf;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
