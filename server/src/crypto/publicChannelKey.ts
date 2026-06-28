/**
 * AegisLink — Sealed Public Channels crypto primitives (Phase 0 spike)
 *
 * Implements docs/SEALED-PUBLIC-CHANNELS.md §2–§6: channel identity, CEK wrap,
 * delivery token derivation, sealed post encrypt/decrypt with Ed25519 sender
 * authentication, hash chain, manifest signing, and editor delegation certs.
 *
 * Design reference: Zerion Channels Wire Protocol (hash chain, manifest,
 * delegations, content key wrap, per-attachment keys).
 *
 * Framework-free (no DB, no socket) so it can be ported verbatim to
 * mobile/desktop. Uses node:crypto for HKDF/HMAC/SHA-256 (server) — the
 * mobile port swaps to @noble/hashes (same algorithms, same outputs).
 *
 * Properties:
 *  - The relay never sees `from`, `body`, `seqNum`, or `prevHash`.
 *  - Posts are always encrypted, even for public channels (relay = blob forwarder).
 *  - Hash chain binds post order + signature — relay cannot reorder/inject.
 *  - Delivery token derived from capability — proves CEK possession without
 *    revealing identity.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto';

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
  const digest = createHash('sha256')
    .update(CHANNEL_ID_LABEL)
    .update(Buffer.from(channelEd25519Pub))
    .update(Buffer.from(salt))
    .digest();
  return encodeBase64(Uint8Array.from(digest.subarray(0, CHANNEL_ID_BYTES)));
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
  const channelIdBytes = Buffer.from(decodeBase64(channelId));
  return new Uint8Array(
    hkdfSync('sha256', Buffer.from(capability), channelIdBytes, CONTENT_KEY_WRAP_LABEL, 32)
  );
}

/**
 * Wrap (encrypt) CEK with AES-256-GCM using a key derived from capability.
 * Returns { iv, ciphertext, tag } all base64-encoded.
 */
export function wrapCEK(
  cek: Uint8Array,
  capability: Uint8Array,
  channelId: string
): { ivB64: string; wrappedB64: string } {
  if (cek.length !== 32) throw new Error('wrapCEK: CEK must be 32 bytes');
  const wrapKey = deriveWrapKey(capability, channelId);
  // Use nacl.secretbox for consistency with the rest of the stack (XSalsa20-Poly1305).
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

/** Derive channel delivery token from capability + channelId. */
export function deriveChannelDeliveryToken(capability: Uint8Array, channelId: string): string {
  const channelIdBytes = Buffer.from(decodeBase64(channelId));
  const token = hkdfSync('sha256', Buffer.from(capability), channelIdBytes, DELIVERY_TOKEN_LABEL, 16);
  return Buffer.from(token).toString('base64url');
}

/** Hash a channel delivery token for at-rest storage (same as deliveryToken.ts). */
export function hashChannelDeliveryToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('base64');
}

/** Constant-time verify a channel delivery token. */
export function verifyChannelDeliveryToken(rawToken: string, storedHashB64: string): boolean {
  if (typeof rawToken !== 'string' || typeof storedHashB64 !== 'string') return false;
  let presented: Buffer;
  let stored: Buffer;
  try {
    presented = Buffer.from(hashChannelDeliveryToken(rawToken), 'base64');
    stored = Buffer.from(storedHashB64, 'base64');
  } catch {
    return false;
  }
  if (presented.length !== stored.length) {
    timingSafeEqual(presented, presented); // constant-time even on length mismatch
    return false;
  }
  return timingSafeEqual(presented, stored);
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
 * manifest blob (JSON). The relay MUST verify admin actions (delete/ban/
 * tombstone) against THIS key — never against a client-supplied pubkey, or
 * anyone who knows the public channelId could forge admin actions by signing
 * with their own key (golden rules #3, #7).
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
  return timingSafeEqual(Buffer.from(expected), Buffer.from(currentPrevHash));
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
// Utility helpers (pure, no side effects)
// ---------------------------------------------------------------------------

function sha256Bytes(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(Buffer.from(data)).digest());
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
