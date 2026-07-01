/**
 * AegisLink — Sealed Public Channels verified service (Phase 2e, mobile)
 *
 * Pure orchestration tying crypto/publicChannelKey to the transport/store. NO
 * socket, store or React imports — every function is deterministic and unit-
 * tested, so the integrity rules live in one auditable place:
 *
 *  - A fetched manifest is trusted ONLY after its Ed25519 signature verifies on
 *    THIS device (parseAndVerifyManifest). The relay's own check is not a
 *    substitute (golden rule #7).
 *  - Incoming posts are authenticated (sender signature, via openChannelPost) AND
 *    chained: each accepted post's prevHash must equal the previous accepted
 *    post's hash. A post that fails either check is dropped without advancing the
 *    chain head, so an injected/forged/tampered post cannot be accepted or
 *    poison the posts after it (relay can't reorder/inject — golden rule #4 wire).
 *  - Outgoing posts are sealed against the local chain head, so seqNum + prevHash
 *    bind every post into the same hash chain the receivers verify.
 *
 * Known limitation (documented, handled in the Phase 4 moderation slice): a
 * deletion leaves a gap, and a post whose prevHash points at a missing post
 * cannot be chain-verified here, so it is conservatively dropped rather than
 * trusted. CEK rotation + delete-aware chains are Phase 4.
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import {
  openChannelPost,
  sealChannelPost,
  verifyManifest,
  type ChannelManifestData,
  type ChannelPostInner,
  type OpenedChannelPost,
} from '../crypto/publicChannelKey';

/** Genesis prevHash: 32 zero bytes (the first post in a channel). */
const GENESIS_PREV = new Uint8Array(32);

/** The verified tip of a channel's hash chain. */
export interface ChainHead {
  seqNum: number;
  postHash: Uint8Array;
}

/** A sealed post as the transport delivers it (live msg or normalized pull row). */
export interface SealedWirePost {
  seqNum: number;
  ciphertext: string;
  nonce: string;
}

/** Resolves a post's `from` (sender aegisId) to their Ed25519 signing pubkey, or null. */
export type SignerResolver = (from: string) => Uint8Array | null;

export interface IngestResult {
  /** Authenticated + chained posts, in order. */
  posts: OpenedChannelPost[];
  /** New verified chain head (unchanged from `fromHead` if nothing was accepted). */
  head: ChainHead | null;
  /** Count of posts dropped for failing auth, ordering or chain linkage. */
  rejected: number;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/**
 * Parse a signed manifest blob (JSON) into ChannelManifestData and verify its
 * Ed25519 signature against the embedded channel key. Returns null on any
 * parse/length/signature failure — callers must treat null as "do not trust".
 */
export function parseAndVerifyManifest(blobStr: string): ChannelManifestData | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blobStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  try {
    const channelId = parsed['channelId'];
    if (typeof channelId !== 'string') return null;

    const salt = decodeBase64(parsed['salt'] as string);
    const channelEd25519Pub = decodeBase64(parsed['channelEd25519Pub'] as string);
    const sig = decodeBase64(parsed['sig'] as string);
    if (salt.length !== 16) return null;
    if (channelEd25519Pub.length !== nacl.sign.publicKeyLength) return null;

    const channelTypeNum = parsed['channelType'];
    if (typeof channelTypeNum !== 'number' || channelTypeNum < 0 || channelTypeNum > 3) return null;

    const avatarHashRaw = parsed['avatarHash'];
    const contentKeyHashRaw = parsed['contentKeyHash'];

    const manifest: ChannelManifestData = {
      channelId,
      salt,
      channelEd25519Pub,
      name: parsed['name'] as string,
      description: parsed['description'] as string,
      avatarHash: typeof avatarHashRaw === 'string' ? decodeBase64(avatarHashRaw) : null,
      channelType: channelTypeNum as 0 | 1 | 2 | 3,
      createdAtHourMs: parsed['createdAtHourMs'] as number,
      manifestSeq: parsed['manifestSeq'] as number,
      contentKeyHash: typeof contentKeyHashRaw === 'string' ? decodeBase64(contentKeyHashRaw) : null,
      delegationsHash: decodeBase64(parsed['delegationsHash'] as string),
      revokedHash: decodeBase64(parsed['revokedHash'] as string),
      pinnedPostSeq: parsed['pinnedPostSeq'] as number,
      discussionsEnabled: parsed['discussionsEnabled'] as boolean,
    };

    return verifyManifest(manifest, sig) ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * Serialize a manifest + its signature into the canonical signed-blob JSON the
 * relay stores and parseAndVerifyManifest reads back. Inverse of
 * parseAndVerifyManifest — keep the two in lockstep.
 */
export function serializeSignedManifest(m: ChannelManifestData, sig: Uint8Array): string {
  return JSON.stringify({
    channelId: m.channelId,
    salt: encodeBase64(m.salt),
    channelEd25519Pub: encodeBase64(m.channelEd25519Pub),
    sig: encodeBase64(sig),
    name: m.name,
    description: m.description,
    avatarHash: m.avatarHash ? encodeBase64(m.avatarHash) : null,
    channelType: m.channelType,
    createdAtHourMs: m.createdAtHourMs,
    manifestSeq: m.manifestSeq,
    contentKeyHash: m.contentKeyHash ? encodeBase64(m.contentKeyHash) : null,
    delegationsHash: encodeBase64(m.delegationsHash),
    revokedHash: encodeBase64(m.revokedHash),
    pinnedPostSeq: m.pinnedPostSeq,
    discussionsEnabled: m.discussionsEnabled,
  });
}

// ── Incoming posts: authenticate + chain-verify ──────────────────────────────

/**
 * Authenticate and chain-verify a batch of sealed posts starting from `fromHead`
 * (null = genesis). Posts are processed in ascending seqNum order; each accepted
 * post must (a) open + verify its sender signature, (b) carry the seqNum it was
 * sealed with, (c) have a seqNum greater than the last accepted, and (d) link via
 * prevHash to the previous accepted post's hash. Failures are dropped without
 * advancing the head.
 */
export function ingestChannelPosts(
  channelId: string,
  sealed: SealedWirePost[],
  cek: Uint8Array,
  resolveSigner: SignerResolver,
  fromHead: ChainHead | null,
): IngestResult {
  const ordered = [...sealed].sort((a, b) => a.seqNum - b.seqNum);
  let prevHash = fromHead ? fromHead.postHash : GENESIS_PREV;
  let lastSeq = fromHead ? fromHead.seqNum : -1;
  let head = fromHead;
  const posts: OpenedChannelPost[] = [];
  let rejected = 0;

  for (const sp of ordered) {
    if (sp.seqNum <= lastSeq) { rejected++; continue; }
    const opened = openChannelPost(channelId, sp.ciphertext, sp.nonce, cek, resolveSigner);
    if (!opened) { rejected++; continue; }
    // The sealed seqNum is authenticated (inside the signature); the wire seqNum
    // must match it, else the relay relabeled the post.
    if (opened.post.seqNum !== sp.seqNum) { rejected++; continue; }
    if (opened.post.prevHash.length !== prevHash.length || !nacl.verify(opened.post.prevHash, prevHash)) {
      rejected++;
      continue;
    }
    posts.push(opened);
    prevHash = opened.postHash;
    lastSeq = opened.post.seqNum;
    head = { seqNum: opened.post.seqNum, postHash: opened.postHash };
  }

  return { posts, head, rejected };
}

// ── Outgoing posts: seal against the local chain head ────────────────────────

export interface OutgoingPostParams {
  from: string;            // our sender aegisId
  body: string;
  ts: number;
  ttlMs?: number;          // 0 = permanent
  attachmentsHash?: Uint8Array; // 32 bytes, all-zero when none
}

export interface SealedOutgoingPost {
  wire: { ciphertext: string; nonce: string };
  seqNum: number;
  postHash: Uint8Array;
  newHead: ChainHead;
}

/**
 * Build + seal the next post for a channel, binding it to `head` (null = first
 * post). Returns the wire blob to hand to pubchannelPost plus the advanced head
 * the caller persists so the following post chains correctly.
 */
export function buildAndSealPost(
  channelId: string,
  params: OutgoingPostParams,
  head: ChainHead | null,
  senderEd25519Secret: Uint8Array,
  cek: Uint8Array,
): SealedOutgoingPost {
  const seqNum = head ? head.seqNum + 1 : 0;
  const prevHash = head ? head.postHash : GENESIS_PREV;
  const post: ChannelPostInner = {
    from: params.from,
    body: params.body,
    ts: params.ts,
    seqNum,
    prevHash,
    ttlMs: params.ttlMs ?? 0,
    attachmentsHash: params.attachmentsHash ?? new Uint8Array(32),
  };
  const sealed = sealChannelPost(channelId, post, senderEd25519Secret, cek);
  return {
    wire: { ciphertext: sealed.ciphertextB64, nonce: sealed.nonceB64 },
    seqNum,
    postHash: sealed.postHash,
    newHead: { seqNum, postHash: sealed.postHash },
  };
}

/**
 * Normalize a pull row (snake_case from the relay/DB) into a SealedWirePost so
 * pull results and live `pubchannel:msg` fan-out feed the same ingest path.
 */
export function normalizePullRow(row: {
  seqNum?: number;
  seq_num?: number;
  ciphertext?: string;
  ciphertext_b64?: string;
  nonce?: string;
  nonce_b64?: string;
}): SealedWirePost | null {
  const seqNum = row.seqNum ?? row.seq_num;
  const ciphertext = row.ciphertext ?? row.ciphertext_b64;
  const nonce = row.nonce ?? row.nonce_b64;
  if (typeof seqNum !== 'number' || typeof ciphertext !== 'string' || typeof nonce !== 'string') {
    return null;
  }
  return { seqNum, ciphertext, nonce };
}
