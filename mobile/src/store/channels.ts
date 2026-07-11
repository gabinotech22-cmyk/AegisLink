/**
 * AegisLink — Sealed Public Channels store (Phase 2d-1, mobile)
 *
 * Zustand store that orchestrates the channel layers built in Phase 2a–2e:
 *   REST (api/publicChannels) + transport (socket/publicChannels) +
 *   verified service (channels/channelService) + secret store
 *   (crypto/publicChannelStore).
 *
 * Integrity is delegated, never re-implemented here:
 *  - directory manifests are trusted only after parseAndVerifyManifest (#7);
 *    a manifest that fails verification is dropped from the directory.
 *  - feed posts are authenticated + chain-verified by ingestChannelPosts before
 *    they enter state; the relay can't inject/reorder (#4).
 *  - outgoing posts are sealed against the local chain head; no `from` on the
 *    wire (the sender identity is inside the sealed payload).
 *
 * This is the UI's data layer — the screens (2d-2) read these slices and call
 * these actions; they do no crypto themselves.
 */

import { create } from 'zustand';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import type { Identity } from '../crypto/identity';
import { useContacts } from './contacts';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2';
import { listPublicChannels, registerPublicChannel, getPublicChannelManifest, updatePublicChannelManifest, setChannelAvatar, type PublicChannelType } from '../api/publicChannels';
import { uploadAvatarBlob, cacheLocalAvatar } from '../channels/channelAvatarCache';
import { logger } from '../utils/logger';
import {
  pubchannelJoin,
  pubchannelPost,
  pubchannelPull,
  pubchannelTombstone,
  pubchannelApply,
  pubchannelPending,
  pubchannelApprove,
  pubchannelCheckApproval,
  pubchannelDelete,
  pubchannelBan,
  onPubchannelMsg,
  onPubchannelDelete,
  onPubchannelBan,
  onPubchannelTombstone,
} from '../socket/publicChannels';
import {
  parseAndVerifyManifest,
  ingestChannelPosts,
  buildAndSealPost,
  normalizePullRow,
  serializeSignedManifest,
  encodePostBody,
  openPostBody,
  type ChainHead,
  type SignerResolver,
  type PostMedia,
} from '../channels/channelService';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  signTombstone,
  signAvatarSet,
  signDelete,
  signBan,
  verifyBan,
  signPendingList,
  signApprove,
  generateJoinEphemeral,
  sealApprovalCapability,
  openApprovalCapability,
  type ApprovalEnvelope,
  deriveChannelId,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  wrapCEK,
  unwrapCEK,
  type ChannelManifestData,
} from '../crypto/publicChannelKey';
import { buildInviteLink, parseInviteLink } from '../channels/inviteLink';
import {
  saveChannelSecrets,
  saveChannelSigningKey,
  getChannelCEK,
  getChannelCapability,
  getChannelSigningKey,
  getChannelDeliveryToken,
  isChannelOwned,
  listChannelIds,
  deleteChannel as deleteChannelSecrets,
  saveJoinRequest,
  getJoinRequest,
  listJoinRequests,
  deleteJoinRequest,
  saveBannedMembers,
  getBannedMembers,
  saveChannelHead,
  getChannelHead,
  saveChannelMeta,
  getChannelMeta,
  type ChannelMeta,
} from '../crypto/publicChannelStore';

const CHANNEL_TYPE_NAMES: PublicChannelType[] = ['open', 'readonly', 'moderated', 'approval'];
const HOUR_MS = 60 * 60 * 1000;

/** constant-time-ish equality for two byte arrays (lengths first). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b);
}

/** A verified directory entry — name/type extracted from a signature-checked manifest. */
export interface DirectoryEntry {
  channelId: string;
  name: string;
  description: string;
  channelType: PublicChannelType;
  /** SHA-256 committed in the signed manifest, or null if no avatar. */
  avatarHash: Uint8Array | null;
  /** Blob ID from the directory listing (relay-side association). */
  avatarBlobId: string | null;
}

/** A channel we hold secrets for (appears in the subscribed list). */
export interface ChannelSummary {
  channelId: string;
  name: string;
  /** From the signature-verified manifest ('' when joined before it was stored). */
  description: string;
  channelType: PublicChannelType;
  owned: boolean;
  /** SHA-256 committed in the signed manifest, or null if no avatar. */
  avatarHash: Uint8Array | null;
  /**
   * Channel Ed25519 public key (base64) from the verified manifest. Lets
   * subscribers rebuild the invite link (owners can derive it from the signing
   * secret instead). Null for channels joined before this field existed.
   */
  channelEd25519PubB64: string | null;
}

/** A UI-facing, already-authenticated post. */
export interface FeedPost {
  id: string;
  from: string;
  body: string;
  /** Sender's profile display name, if the post carries one (v1 body envelope). Null for legacy plain-text posts. */
  senderName: string | null;
  /** Attachment carried in the sealed body (image/audio/gif/sticker/…), or null. */
  media: PostMedia | null;
  ts: number;
  seqNum: number;
}

interface ChannelsState {
  directory: DirectoryEntry[];
  loadingDirectory: boolean;
  subscribed: ChannelSummary[];
  /** True once hydrateSubscribed has completed at least once this session. */
  hydrated: boolean;
  feeds: Record<string, FeedPost[]>;
  heads: Record<string, ChainHead | null>;
  /**
   * Banned member aegisIds per channel (client-side only — docs §10.5: the
   * relay never stores a roster or ban list). Posts from banned authors are
   * filtered on ingest and purged retroactively.
   */
  banned: Record<string, string[]>;

  loadDirectory: () => Promise<void>;
  /**
   * Rebuild `subscribed` after an app restart from the SecureStore channel
   * index + the relay's signed manifests. Nothing beyond the secrets is kept
   * at rest (metadata minimization): names/types are re-verified on-device
   * from each manifest signature, never trusted from the relay.
   */
  hydrateSubscribed: () => Promise<void>;
  createChannel: (
    params: {
      name: string;
      description: string;
      channelType: PublicChannelType;
      /** Local file:// URI of the 256px compressed avatar, or null for no avatar. */
      avatarUri?: string | null;
      /** SHA-256 of the avatar file bytes (pre-computed by the caller). */
      avatarHash?: Uint8Array | null;
    },
    identity: Identity,
  ) => Promise<{ ok: boolean; channelId?: string; invite?: string; error?: string }>;
  joinViaInvite: (inviteUrl: string, identity: Identity) => Promise<{ ok: boolean; channelId?: string; applied?: boolean; error?: string }>;
  joinChannel: (channelId: string, capability: Uint8Array, cek: Uint8Array) => Promise<{ ok: boolean; error?: string }>;
  loadFeed: (channelId: string, identity: Identity) => Promise<void>;
  /**
   * Delta-pull every subscribed channel once and locally notify on new posts.
   * Used by the background-sync task (leak-free channel notifications — no relay
   * subscriber list). Returns the number of fresh posts surfaced.
   */
  syncSubscribedForBackground: (identity: Identity) => Promise<number>;
  sendPost: (channelId: string, body: string, identity: Identity, senderName?: string, media?: PostMedia | null) => Promise<{ ok: boolean; error?: string }>;
  attachLive: (identity: Identity) => () => void;
  removeChannel: (channelId: string) => Promise<void>;

  // ── Phase 4: owner admin + approval-gated joins ────────────────────────────
  /** Waiting-for-approval applications (approval-gated channels). */
  pendingApplications: Array<{ channelId: string; name: string; epkB64: string }>;
  /** Owner: rename / edit description (re-signs the manifest, seq+1). */
  updateChannelInfo: (channelId: string, updates: { name?: string; description?: string; channelType?: PublicChannelType }) => Promise<{ ok: boolean; error?: string }>;
  /** Owner: delete a post for everyone (signed; relay fans out). */
  deletePost: (channelId: string, seqNum: number) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Owner: ban a member (docs §10.4). Signs `{banned, ts, channelId}` with the
   * channel key, fans it out via `pubchannel:ban` (relay verifies the signature
   * against the STORED manifest key but learns nothing beyond the pseudonymous
   * aegisId already inside the record), persists the ban locally and purges the
   * member's posts from the feed.
   */
  banMember: (channelId: string, memberAegisId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Owner: list pending join requests for an approval-gated channel. */
  listPendingJoins: (channelId: string) => Promise<{ ok: boolean; pending?: Array<{ joinEpk: string; createdAt: number }>; error?: string }>;
  /** Owner: approve (seal capability to the applicant) or reject a request. */
  answerJoinRequest: (channelId: string, joinEpkB64: string, approve: boolean) => Promise<{ ok: boolean; error?: string }>;
  /** Applicant: poll all in-flight applications; completes the join on approval. */
  checkApprovals: (identity: Identity) => Promise<void>;
}

/** Build the from→Ed25519-signing-pubkey resolver from contacts + our own identity. */
function makeSignerResolver(identity: Identity): SignerResolver {
  const byId = new Map(useContacts.getState().contacts.map((c) => [c.aegisId, c] as const));
  return (from: string): Uint8Array | null => {
    if (from === identity.aegisId) return identity.signingPublicKey;
    const c = byId.get(from);
    if (c?.signingPublicKeyB64) {
      try { return decodeBase64(c.signingPublicKeyB64); } catch { return null; }
    }
    return null;
  };
}

function manifestType(n: 0 | 1 | 2 | 3): PublicChannelType {
  return CHANNEL_TYPE_NAMES[n] ?? 'open';
}

/** ChannelMeta stores JSON-safe strings; the summary uses typed values. */
function toChannelMeta(m: {
  name: string;
  description: string;
  channelType: PublicChannelType;
  avatarHash: Uint8Array | null;
  channelEd25519PubB64: string | null;
}): ChannelMeta {
  return {
    name: m.name,
    description: m.description,
    channelType: m.channelType,
    avatarHash: m.avatarHash ? encodeBase64(m.avatarHash) : null,
    channelEd25519PubB64: m.channelEd25519PubB64,
  };
}

function metaChannelType(s: string): PublicChannelType {
  return (CHANNEL_TYPE_NAMES as string[]).includes(s) ? (s as PublicChannelType) : 'open';
}

function metaAvatarHash(b64: string | null): Uint8Array | null {
  if (!b64) return null;
  try { return decodeBase64(b64); } catch { return null; }
}

/** Wire/at-rest shape of a ban record (docs §10.4 step 1). */
interface BanRecord {
  banned: string;
  ts: number;
  channelId: string;
}

/** Parse + shape-check a ban record string. Null on any mismatch. */
function parseBanRecord(recordStr: string, expectedChannelId: string): BanRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordStr);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r['banned'] !== 'string' || r['banned'].length === 0) return null;
  if (typeof r['ts'] !== 'number' || typeof r['channelId'] !== 'string') return null;
  if (r['channelId'] !== expectedChannelId) return null;
  return { banned: r['banned'], ts: r['ts'], channelId: r['channelId'] };
}

function postToFeed(p: { post: { from: string; body: string; ts: number; seqNum: number } }, channelId: string): FeedPost {
  const { text, senderName, media } = openPostBody(p.post.body);
  return { id: `${channelId}:${p.post.seqNum}`, from: p.post.from, body: text, senderName, media, ts: p.post.ts, seqNum: p.post.seqNum };
}

/** Merge two feed slices, de-duplicating by seqNum and keeping chain order. */
function mergeFeedPosts(existing: FeedPost[], incoming: FeedPost[]): FeedPost[] {
  const bySeq = new Map<number, FeedPost>();
  for (const p of existing) bySeq.set(p.seqNum, p);
  for (const p of incoming) bySeq.set(p.seqNum, p);
  return [...bySeq.values()].sort((a, b) => a.seqNum - b.seqNum);
}

/** Persist a channel's current in-memory feed to the at-rest cache (best-effort). */
function persistFeed(channelId: string, get: () => { feeds: Record<string, FeedPost[]> }): void {
  const posts = get().feeds[channelId];
  if (!posts) return;
  const { saveChannelFeed } = require('../db/local') as typeof import('../db/local');
  void saveChannelFeed(channelId, posts).catch(() => {});
}

/**
 * Fire local notifications for freshly ingested (decrypted + verified) posts
 * that were not written by us. Built entirely on-device (issue #206): the
 * relay never learns the mute state nor when a notification is shown.
 */
function notifyNewPosts(
  channelId: string,
  channelName: string,
  posts: FeedPost[],
  ownAegisId: string,
): void {
  const fresh = posts.filter((p) => p.from !== ownAegisId);
  if (fresh.length === 0) return;
  try {
    // Lazy require (same pattern as socket/client → notifications/push): keeps
    // expo-notifications out of this store's static import graph.
    const { showChannelPostNotification } =
      require('../notifications/channelNotifications') as typeof import('../notifications/channelNotifications');
    for (const p of fresh) {
      void showChannelPostNotification(channelId, channelName, p.body);
    }
  } catch (e) {
    logger.warn(`[channels] post notification failed: ${(e as Error).message}`);
  }
}

// Module-scope in-flight guard: hydrateSubscribed() is now called independently
// from App.tsx's rehydrate effect, useChannelSelfHydrate (ChannelFeed/ChannelInfo),
// and scheduledMessages.processDue(). Without this, two near-simultaneous callers
// (e.g. a deep link opening ChannelFeed while App.tsx is still hydrating) would
// each kick off their own manifest-fetch loop in parallel. Sharing the in-flight
// promise collapses concurrent calls into a single fetch.
let hydrateInFlight: Promise<void> | null = null;

export const useChannels = create<ChannelsState>((set, get) => ({
  directory: [],
  loadingDirectory: false,
  subscribed: [],
  hydrated: false,
  pendingApplications: [],
  feeds: {},
  heads: {},
  banned: {},

  async hydrateSubscribed() {
    // Duress (coercion PIN) containment: NEVER list the user's real channel
    // subscriptions to a coercer — which channels someone follows is exactly
    // the kind of association the duress mode exists to hide. The decoy
    // account simply follows no channels (plausible; the public directory
    // itself stays browsable, it's public data). Mirrors groups/contacts.
    {
      const { usePreferences } = require('./preferences') as typeof import('./preferences');
      if (usePreferences.getState().duressActive) {
        set({ subscribed: [], feeds: {}, heads: {}, hydrated: true });
        return;
      }
    }
    if (hydrateInFlight) return hydrateInFlight;
    hydrateInFlight = (async () => {
      const ids = await listChannelIds();
      const known = new Set(get().subscribed.map((c) => c.channelId));
      const restored: ChannelSummary[] = [];
      const restoredBans: Record<string, string[]> = {};
      for (const channelId of ids) {
        // Ban lists are local-only (never re-fetchable) — restore them even when
        // the manifest fetch below fails or the channel is already listed.
        const bans = await getBannedMembers(channelId);
        if (bans.length > 0) restoredBans[channelId] = bans;
        if (known.has(channelId)) continue;
        let blob: string;
        try {
          ({ signed_manifest_blob: blob } = await getPublicChannelManifest(channelId));
        } catch (e) {
          // Offline or relay hiccup: fall back to the this-device-only cached
          // metadata so the channel still LISTS with its real name (instead of a
          // nameless "Channels" fallback) and the feed title stays correct. The
          // next successful hydrate refreshes it. Only a truly first-seen channel
          // with no cache is skipped.
          logger.warn(`[channels] hydrate: manifest fetch failed for ${channelId.slice(0, 8)}…: ${(e as Error).message}`);
          const cached = await getChannelMeta(channelId);
          if (cached) {
            restored.push({
              channelId,
              name: cached.name,
              description: cached.description,
              channelType: metaChannelType(cached.channelType),
              owned: await isChannelOwned(channelId),
              avatarHash: metaAvatarHash(cached.avatarHash),
              channelEd25519PubB64: cached.channelEd25519PubB64,
            });
          }
          continue;
        }
        const manifest = parseAndVerifyManifest(blob);
        if (!manifest || manifest.channelId !== channelId) continue; // forged/corrupt → never trust
        if (deriveChannelId(manifest.channelEd25519Pub, manifest.salt) !== channelId) continue;
        const summary: ChannelSummary = {
          channelId,
          name: manifest.name,
          description: manifest.description,
          channelType: manifestType(manifest.channelType),
          owned: await isChannelOwned(channelId),
          avatarHash: manifest.avatarHash,
          channelEd25519PubB64: encodeBase64(manifest.channelEd25519Pub),
        };
        restored.push(summary);
        // Refresh the local display cache from the verified manifest.
        void saveChannelMeta(channelId, toChannelMeta(summary)).catch(() => {});
      }
      // Restore in-flight approval applications too (they survive restarts in
      // SecureStore alongside their ephemeral secrets).
      const requests = await listJoinRequests();
      // Restore persisted chain heads so a cold launch resumes with a DELTA pull
      // (and can detect + notify new posts) instead of re-pulling full history.
      const restoredHeads: Record<string, ChainHead | null> = {};
      for (const channelId of ids) {
        const h = await getChannelHead(channelId);
        if (h) restoredHeads[channelId] = h;
      }
      set((s) => ({
        hydrated: true,
        banned: { ...restoredBans, ...s.banned },
        heads: { ...restoredHeads, ...s.heads },
        // Re-check against current state: a join may have landed while we fetched.
        subscribed: [
          ...s.subscribed,
          ...restored.filter((r) => !s.subscribed.some((c) => c.channelId === r.channelId)),
        ],
        pendingApplications: [
          ...s.pendingApplications,
          ...requests
            .filter((r) => !s.pendingApplications.some((a) => a.channelId === r.channelId))
            .map((r) => ({ channelId: r.channelId, name: r.name, epkB64: r.epkB64 })),
        ],
      }));
    })();
    try {
      await hydrateInFlight;
    } finally {
      hydrateInFlight = null;
    }
  },

  async loadDirectory() {
    set({ loadingDirectory: true });
    try {
      const { channels } = await listPublicChannels();
      const verified: DirectoryEntry[] = [];
      for (const row of channels) {
        // Trust a directory row only if its manifest signature verifies on-device.
        const manifest = parseAndVerifyManifest(row.signed_manifest_blob);
        if (!manifest) continue;
        verified.push({
          channelId: manifest.channelId,
          name: manifest.name,
          description: manifest.description,
          channelType: manifestType(manifest.channelType),
          avatarHash: manifest.avatarHash,
          avatarBlobId: row.avatar_blob_id ?? null,
        });
      }
      set({ directory: verified });
    } finally {
      set({ loadingDirectory: false });
    }
  },

  async createChannel(params, identity) {
    // 0. Duplicate guard — a second OWNED channel with the same name is almost
    //    always an accidental re-submit (double-tap / retry after a silent
    //    failure). The relay can't dedupe: it never links channels to an owner
    //    (zero metadata), so the guard has to live client-side.
    const wantedName = params.name.trim().toLowerCase();
    if (get().subscribed.some((c) => c.owned && c.name.trim().toLowerCase() === wantedName)) {
      return { ok: false, error: 'duplicate_name' };
    }

    // 1. Fresh channel identity + content key + access capability.
    const id = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    const channelType = CHANNEL_TYPE_NAMES.indexOf(params.channelType);
    if (channelType < 0) return { ok: false, error: 'bad_channel_type' };

    // 2. Signed manifest binding name/type/contentKeyHash to the channel key.
    //    avatarHash is committed here BEFORE signing so the manifest binds the
    //    avatar to the channel's Ed25519 key. This makes the avatar verifiable
    //    even when downloaded from the untrusted relay.
    const manifest: ChannelManifestData = {
      channelId: id.channelId,
      salt: id.salt,
      channelEd25519Pub: id.channelEd25519Pub,
      name: params.name,
      description: params.description,
      avatarHash: params.avatarHash ?? null,
      channelType: channelType as 0 | 1 | 2 | 3,
      createdAtHourMs: Math.floor(Date.now() / HOUR_MS) * HOUR_MS, // hour-truncated (metadata minimization)
      manifestSeq: 1,
      contentKeyHash: sha256(cek),
      delegationsHash: new Uint8Array(32),
      revokedHash: new Uint8Array(32),
      pinnedPostSeq: -1,
      discussionsEnabled: true,
    };
    const sig = signManifest(manifest, id.channelEd25519Secret);
    const blob = serializeSignedManifest(manifest, sig);

    // 3. Wrap the CEK for capability-holders; register the channel (relay stores
    //    the blob + token hash + opaque envelope).
    const contentKeyEnvelope = JSON.stringify(wrapCEK(cek, capability, id.channelId));
    const deliveryToken = deriveChannelDeliveryToken(capability, id.channelId);
    try {
      await registerPublicChannel({
        signedManifestBlob: blob,
        deliveryTokenHashB64: hashChannelDeliveryToken(deliveryToken),
        channelType: params.channelType,
        contentKeyEnvelope,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'register_failed' };
    }

    // 4. Persist OUR secrets (we own this channel → also the signing key).
    //    If this fails the channel exists on the relay but is unusable here —
    //    best-effort tombstone so the orphan doesn't linger in the public
    //    directory, and return an error the UI can show (previously this threw
    //    past the screen's try/finally: silent failure → users re-tapped and
    //    created duplicates).
    try {
      await saveChannelSecrets(id.channelId, { cek, capability });
      await saveChannelSigningKey(id.channelId, id.channelEd25519Secret);
    } catch (e) {
      try {
        const ts = Date.now();
        const sig = signTombstone(id.channelId, ts, id.channelEd25519Secret);
        await pubchannelTombstone(id.channelId, ts, encodeBase64(sig));
      } catch (rollbackErr) {
        logger.warn(`[channels] orphan-channel tombstone failed: ${(rollbackErr as Error).message}`);
      }
      return { ok: false, error: e instanceof Error ? e.message : 'local_save_failed' };
    }

    const channelEd25519PubB64 = encodeBase64(id.channelEd25519Pub);
    set((s) => ({
      subscribed: [...s.subscribed, {
        channelId: id.channelId,
        name: params.name,
        description: params.description,
        channelType: params.channelType,
        owned: true,
        avatarHash: params.avatarHash ?? null,
        channelEd25519PubB64,
      }],
    }));
    // Cache display metadata so the channel keeps its name across restarts even
    // when the manifest re-fetch fails offline.
    void saveChannelMeta(id.channelId, toChannelMeta({
      name: params.name,
      description: params.description,
      channelType: params.channelType,
      avatarHash: params.avatarHash ?? null,
      channelEd25519PubB64,
    })).catch(() => {});

    // 5. Avatar upload (best-effort -- the channel is already created; the
    //    avatar can be retried later). ORDER: upload bytes to blob store, then
    //    sign proof-of-ownership and associate via POST /avatar.
    if (params.avatarUri && params.avatarHash) {
      try {
        const blobId = await uploadAvatarBlob(params.avatarUri);
        const avatarSig = signAvatarSet(id.channelId, blobId, id.channelEd25519Secret);
        await setChannelAvatar(id.channelId, blobId, encodeBase64(avatarSig));
        // Cache the avatar locally so it renders immediately for the creator.
        await cacheLocalAvatar(id.channelId, params.avatarUri);
      } catch (e) {
        // Non-fatal: the channel exists, the avatar just didn't attach.
        logger.warn(`[channels] avatar upload failed: ${(e as Error).message}`);
      }
    }

    // 6. Share link. Approval-gated channels omit the capability (p=1).
    const invite = buildInviteLink({
      channelId: id.channelId,
      channelEd25519Pub: id.channelEd25519Pub,
      capability: params.channelType === 'approval' ? null : capability,
      approvalGated: params.channelType === 'approval',
    });
    return { ok: true, channelId: id.channelId, invite };
  },

  async joinViaInvite(inviteUrl, identity) {
    const parsed = parseInviteLink(inviteUrl);
    if (!parsed) return { ok: false, error: 'bad_invite' };

    // Approval-gated invite (no capability): apply with a fresh ephemeral
    // X25519 key (docs §10.2) and wait for the owner to seal the capability.
    if (!parsed.capability) {
      if (get().pendingApplications.some((a) => a.channelId === parsed.channelId)) {
        return { ok: true, applied: true, channelId: parsed.channelId };
      }
      // Fetch + verify the manifest so we can show the channel name while waiting.
      let name = parsed.channelId;
      try {
        const { signed_manifest_blob } = await getPublicChannelManifest(parsed.channelId);
        const m = parseAndVerifyManifest(signed_manifest_blob);
        if (!m || m.channelId !== parsed.channelId) return { ok: false, error: 'bad_manifest' };
        if (!bytesEqual(m.channelEd25519Pub, parsed.channelEd25519Pub)) return { ok: false, error: 'pubkey_mismatch' };
        name = m.name;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'manifest_fetch_failed' };
      }

      const eph = generateJoinEphemeral();
      const epkB64 = encodeBase64(eph.publicKey);
      try {
        // Persist the ephemeral secret FIRST — an approval that lands after a
        // restart must still be claimable.
        await saveJoinRequest({ channelId: parsed.channelId, name, epkB64, eskB64: encodeBase64(eph.secretKey) });
        const ack = await pubchannelApply(parsed.channelId, epkB64);
        if (!ack.ok) {
          await deleteJoinRequest(parsed.channelId);
          return { ok: false, error: ack.error };
        }
      } finally {
        eph.secretKey.fill(0); // the SecureStore copy is now the only one
      }
      set((s) => ({
        pendingApplications: [...s.pendingApplications, { channelId: parsed.channelId, name, epkB64 }],
      }));
      return { ok: true, applied: true, channelId: parsed.channelId };
    }

    // Fetch + verify the manifest, and bind it to the invite's channelId/pubkey.
    let blob: string;
    try {
      ({ signed_manifest_blob: blob } = await getPublicChannelManifest(parsed.channelId));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'manifest_fetch_failed' };
    }
    const manifest = parseAndVerifyManifest(blob);
    if (!manifest) return { ok: false, error: 'bad_manifest' };
    if (manifest.channelId !== parsed.channelId) return { ok: false, error: 'channel_id_mismatch' };
    if (!bytesEqual(manifest.channelEd25519Pub, parsed.channelEd25519Pub)) return { ok: false, error: 'pubkey_mismatch' };
    // The id must bind to (pub, salt) — a forged manifest claiming someone's id fails here.
    if (deriveChannelId(manifest.channelEd25519Pub, manifest.salt) !== parsed.channelId) {
      return { ok: false, error: 'channel_id_unbound' };
    }

    // Join to obtain the wrapped CEK envelope.
    const deliveryToken = deriveChannelDeliveryToken(parsed.capability, parsed.channelId);
    const ack = await pubchannelJoin(parsed.channelId, deliveryToken);
    if (!ack.ok) return { ok: false, error: ack.error };
    if (!ack.contentKeyEnvelope) return { ok: false, error: 'no_content_key' };

    let env: { ivB64: string; wrappedB64: string };
    try {
      env = JSON.parse(ack.contentKeyEnvelope) as { ivB64: string; wrappedB64: string };
    } catch { return { ok: false, error: 'bad_envelope' }; }

    const cek = unwrapCEK(env.ivB64, env.wrappedB64, parsed.capability, parsed.channelId);
    if (!cek) return { ok: false, error: 'cek_unwrap_failed' };
    // The unwrapped CEK must match the signed manifest's contentKeyHash.
    if (manifest.contentKeyHash && !bytesEqual(sha256(cek), manifest.contentKeyHash)) {
      return { ok: false, error: 'cek_mismatch' };
    }

    await saveChannelSecrets(parsed.channelId, { cek, capability: parsed.capability });
    const joinedType = CHANNEL_TYPE_NAMES[manifest.channelType] ?? 'open';
    const joinedPubB64 = encodeBase64(manifest.channelEd25519Pub);
    set((s) => ({
      subscribed: s.subscribed.some((c) => c.channelId === parsed.channelId)
        ? s.subscribed
        : [...s.subscribed, {
            channelId: parsed.channelId,
            name: manifest.name,
            description: manifest.description,
            channelType: joinedType,
            owned: false,
            avatarHash: manifest.avatarHash,
            channelEd25519PubB64: joinedPubB64,
          }],
    }));
    void saveChannelMeta(parsed.channelId, toChannelMeta({
      name: manifest.name,
      description: manifest.description,
      channelType: joinedType,
      avatarHash: manifest.avatarHash,
      channelEd25519PubB64: joinedPubB64,
    })).catch(() => {});
    await get().loadFeed(parsed.channelId, identity);
    return { ok: true, channelId: parsed.channelId };
  },

  async joinChannel(channelId, capability, cek) {
    // Persist the secrets first so the delivery token can be derived and the feed
    // can decrypt; the invite/CEK-unwrap that produces (capability, cek) is the
    // caller's concern (a later create/invite slice), not this store's.
    await saveChannelSecrets(channelId, { cek, capability });
    const deliveryToken = await getChannelDeliveryToken(channelId);
    if (!deliveryToken) return { ok: false, error: 'no_delivery_token' };

    const ack = await pubchannelJoin(channelId, deliveryToken);
    if (!ack.ok) {
      // Failed join → don't keep a half-subscribed channel around.
      await deleteChannelSecrets(channelId);
      return { ok: false, error: ack.error };
    }

    const manifest = ack.manifest ? parseAndVerifyManifest(ack.manifest) : null;
    const summary: ChannelSummary = {
      channelId,
      name: manifest?.name ?? channelId,
      description: manifest?.description ?? '',
      channelType: manifest ? manifestType(manifest.channelType) : 'open',
      owned: await isChannelOwned(channelId),
      avatarHash: manifest?.avatarHash ?? null,
      channelEd25519PubB64: manifest ? encodeBase64(manifest.channelEd25519Pub) : null,
    };
    set((s) => ({
      subscribed: s.subscribed.some((c) => c.channelId === channelId)
        ? s.subscribed
        : [...s.subscribed, summary],
    }));
    void saveChannelMeta(channelId, toChannelMeta(summary)).catch(() => {});
    return { ok: true };
  },

  async loadFeed(channelId, identity) {
    const cek = await getChannelCEK(channelId);
    if (!cek) return; // not subscribed / no key
    const { saveChannelFeed, loadChannelFeed } = require('../db/local') as typeof import('../db/local');

    // Restore the persisted feed once per session BEFORE the delta pull. The
    // verified head is persisted, so a cold restart delta-pulls (since = head)
    // and the relay — which doesn't retain broadcast history forever — returns
    // nothing, leaving the feed empty. The local cache is the source of history.
    if (get().feeds[channelId] === undefined) {
      const cached = await loadChannelFeed(channelId);
      set((s) => ({ feeds: { ...s.feeds, [channelId]: s.feeds[channelId] ?? cached } }));
    }

    const head = get().heads[channelId] ?? null;
    const since = head ? head.seqNum : -1;

    const ack = await pubchannelPull(channelId, since);
    if (!ack.ok || !ack.posts) return;

    const sealed = ack.posts.map(normalizePullRow).filter((p): p is NonNullable<typeof p> => p !== null);
    const result = ingestChannelPosts(channelId, sealed, cek, makeSignerResolver(identity), head);
    if (result.posts.length === 0) return;

    // Chain verification runs over ALL posts (the head must advance past a
    // banned author's links); only the feed projection drops them.
    const bannedHere = new Set(get().banned[channelId] ?? []);
    const fresh = result.posts
      .filter((p) => !bannedHere.has(p.post.from))
      .map((p) => postToFeed(p, channelId));
    set((s) => ({
      feeds: { ...s.feeds, [channelId]: mergeFeedPosts(s.feeds[channelId] ?? [], fresh) },
      heads: { ...s.heads, [channelId]: result.head },
    }));
    if (result.head) void saveChannelHead(channelId, result.head).catch(() => {});
    void saveChannelFeed(channelId, get().feeds[channelId] ?? []).catch(() => {});

    // Notify only on DELTA refreshes (since >= 0): the initial history pull of
    // a just-joined/just-opened channel must not fire a burst of notifications.
    if (since >= 0) {
      const name = get().subscribed.find((c) => c.channelId === channelId)?.name ?? channelId;
      notifyNewPosts(channelId, name, fresh, identity.aegisId);
    }
  },

  async syncSubscribedForBackground(identity) {
    // Ensure the subscribed list + persisted heads are hydrated (headless cold
    // launch runs no React effects). Idempotent when already hydrated.
    if (!get().hydrated) {
      try { await get().hydrateSubscribed(); } catch { /* offline manifest fetch — sync what we can */ }
    }
    const channels = get().subscribed;
    let fresh = 0;
    for (const c of channels) {
      const before = get().heads[c.channelId]?.seqNum ?? -1;
      try {
        // loadFeed pulls the delta (since = persisted head) and, when since >= 0,
        // fires the same mute-aware local notification as a live post. A cold
        // launch with a restored head therefore notifies; a first-ever pull
        // (no head) stays silent, exactly like the foreground behavior.
        await get().loadFeed(c.channelId, identity);
      } catch { /* one channel failing must not abort the others */ }
      const after = get().heads[c.channelId]?.seqNum ?? -1;
      if (after > before) fresh += after - before;
    }
    return fresh;
  },

  async sendPost(channelId, body, identity, senderName, media) {
    const cek = await getChannelCEK(channelId);
    if (!cek) return { ok: false, error: 'not_subscribed' };
    const deliveryToken = await getChannelDeliveryToken(channelId);
    if (!deliveryToken) return { ok: false, error: 'no_delivery_token' };

    const head = get().heads[channelId] ?? null;
    const wireBody = encodePostBody(body, senderName, media);
    const sealed = buildAndSealPost(
      channelId,
      { from: identity.aegisId, body: wireBody, ts: Date.now() },
      head,
      identity.signingSecretKey,
      cek,
    );

    const ack = await pubchannelPost(channelId, sealed.wire.ciphertext, sealed.wire.nonce, deliveryToken);
    if (!ack.ok) return { ok: false, error: ack.error };

    const optimistic: FeedPost = {
      id: `${channelId}:${sealed.seqNum}`,
      from: identity.aegisId,
      body,
      senderName: senderName ?? null,
      media: media ?? null,
      ts: Date.now(),
      seqNum: sealed.seqNum,
    };
    set((s) => ({
      feeds: { ...s.feeds, [channelId]: [...(s.feeds[channelId] ?? []), optimistic] },
      heads: { ...s.heads, [channelId]: sealed.newHead },
    }));
    void saveChannelHead(channelId, sealed.newHead).catch(() => {});
    void persistFeed(channelId, get);
    return { ok: true };
  },

  attachLive(identity) {
    const resolver = makeSignerResolver(identity);
    const offMsg = onPubchannelMsg((e) => {
      void (async () => {
        const cek = await getChannelCEK(e.channelId);
        if (!cek) return;
        const head = get().heads[e.channelId] ?? null;
        const result = ingestChannelPosts(
          e.channelId,
          [{ seqNum: e.seqNum, ciphertext: e.ciphertext, nonce: e.nonce }],
          cek,
          resolver,
          head,
        );
        if (result.posts.length === 0) return; // failed auth/chain — dropped
        const bannedHere = new Set(get().banned[e.channelId] ?? []);
        const fresh = result.posts
          .filter((p) => !bannedHere.has(p.post.from))
          .map((p) => postToFeed(p, e.channelId));
        set((s) => ({
          feeds: { ...s.feeds, [e.channelId]: mergeFeedPosts(s.feeds[e.channelId] ?? [], fresh) },
          heads: { ...s.heads, [e.channelId]: result.head },
        }));
        if (result.head) void saveChannelHead(e.channelId, result.head).catch(() => {});
        void persistFeed(e.channelId, get);
        const name = get().subscribed.find((c) => c.channelId === e.channelId)?.name ?? e.channelId;
        notifyNewPosts(e.channelId, name, fresh, identity.aegisId);
      })();
    });
    const offDelete = onPubchannelDelete((e) => {
      // Owner-signed deletion (relay-verified). Drop the post locally; the
      // chain head is NOT rewound — later posts still link past the gap.
      set((s) => ({
        feeds: {
          ...s.feeds,
          [e.channelId]: (s.feeds[e.channelId] ?? []).filter((p) => p.seqNum !== e.seqNum),
        },
      }));
      void persistFeed(e.channelId, get);
    });
    const offBan = onPubchannelBan((e) => {
      void (async () => {
        // Trust only a signature-verified ban record: the signing key is the
        // channel pubkey pinned from the VERIFIED manifest at join/hydrate time
        // — never anything relay-supplied (golden rule #7).
        const summary = get().subscribed.find((c) => c.channelId === e.channelId);
        if (!summary?.channelEd25519PubB64) return;
        let channelPub: Uint8Array;
        let sig: Uint8Array;
        try {
          channelPub = decodeBase64(summary.channelEd25519PubB64);
          sig = decodeBase64(e.banSig);
        } catch {
          return;
        }
        if (!verifyBan(e.channelId, e.banRecord, sig, channelPub)) return;
        const record = parseBanRecord(e.banRecord, e.channelId);
        if (!record) return;

        if (record.banned === identity.aegisId) {
          // We were banned: drop keys + local state (kick).
          await get().removeChannel(e.channelId);
          return;
        }
        const next = Array.from(new Set([...(get().banned[e.channelId] ?? []), record.banned]));
        try {
          await saveBannedMembers(e.channelId, next);
        } catch (err) {
          logger.warn(`[channels] ban persist failed: ${(err as Error).message}`);
        }
        set((s) => ({
          banned: { ...s.banned, [e.channelId]: next },
          feeds: {
            ...s.feeds,
            [e.channelId]: (s.feeds[e.channelId] ?? []).filter((p) => p.from !== record.banned),
          },
        }));
        void persistFeed(e.channelId, get);
      })();
    });
    const offTomb = onPubchannelTombstone((e) => {
      void get().removeChannel(e.channelId);
    });
    return () => { offMsg(); offDelete(); offBan(); offTomb(); };
  },

  async removeChannel(channelId) {
    await deleteChannelSecrets(channelId);
    try {
      const { deleteChannelFeed } = require('../db/local') as typeof import('../db/local');
      await deleteChannelFeed(channelId);
    } catch { /* best-effort cache cleanup */ }
    set((s) => {
      const feeds = { ...s.feeds }; delete feeds[channelId];
      const heads = { ...s.heads }; delete heads[channelId];
      const banned = { ...s.banned }; delete banned[channelId];
      return {
        subscribed: s.subscribed.filter((c) => c.channelId !== channelId),
        feeds,
        heads,
        banned,
      };
    });
  },

  // ── Phase 4: owner admin + approval-gated joins ────────────────────────────

  async updateChannelInfo(channelId, updates) {
    const sk = await getChannelSigningKey(channelId);
    if (!sk) return { ok: false, error: 'not_owner' };

    // Rebuild from the CURRENT manifest so unrelated fields (avatar, pins,
    // contentKeyHash) survive the edit; bump manifestSeq (relay enforces >).
    let blob: string;
    try {
      ({ signed_manifest_blob: blob } = await getPublicChannelManifest(channelId));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'manifest_fetch_failed' };
    }
    const current = parseAndVerifyManifest(blob);
    if (!current || current.channelId !== channelId) return { ok: false, error: 'bad_manifest' };

    const name = (updates.name ?? current.name).trim();
    const description = (updates.description ?? current.description).trim();
    if (!name) return { ok: false, error: 'empty_name' };

    let channelType = current.channelType;
    if (updates.channelType !== undefined) {
      const idx = CHANNEL_TYPE_NAMES.indexOf(updates.channelType);
      if (idx < 0) return { ok: false, error: 'bad_channel_type' };
      channelType = idx as 0 | 1 | 2 | 3;
    }

    const next = { ...current, name, description, channelType, manifestSeq: current.manifestSeq + 1 };
    const sig = signManifest(next, sk);
    try {
      await updatePublicChannelManifest(channelId, serializeSignedManifest(next, sig));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'update_failed' };
    }
    set((s) => ({
      subscribed: s.subscribed.map((c) =>
        c.channelId === channelId ? { ...c, name, description, channelType: manifestType(channelType) } : c,
      ),
    }));
    // Keep the display cache in step with the renamed manifest.
    const updated = get().subscribed.find((c) => c.channelId === channelId);
    if (updated) {
      void saveChannelMeta(channelId, toChannelMeta(updated)).catch(() => {});
    }
    return { ok: true };
  },

  async deletePost(channelId, seqNum) {
    const sk = await getChannelSigningKey(channelId);
    if (!sk) return { ok: false, error: 'not_owner' };
    const sig = signDelete(channelId, seqNum, sk);
    const ack = await pubchannelDelete(channelId, seqNum, encodeBase64(sig));
    if (!ack.ok) return { ok: false, error: ack.error };
    set((s) => ({
      feeds: {
        ...s.feeds,
        [channelId]: (s.feeds[channelId] ?? []).filter((p) => p.seqNum !== seqNum),
      },
    }));
    return { ok: true };
  },

  async banMember(channelId, memberAegisId) {
    const sk = await getChannelSigningKey(channelId);
    if (!sk) return { ok: false, error: 'not_owner' };
    if (!memberAegisId) return { ok: false, error: 'bad_member' };

    // Ban record per docs §10.4 step 1 — signed with the channel key; the relay
    // verifies against the stored manifest and fans the record out opaquely.
    const record: BanRecord = { banned: memberAegisId, ts: Date.now(), channelId };
    const recordStr = JSON.stringify(record);
    const sig = signBan(channelId, recordStr, sk);
    try {
      const ack = await pubchannelBan(channelId, recordStr, encodeBase64(sig));
      if (!ack.ok) return { ok: false, error: ack.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'ban_failed' };
    }

    // Apply locally: persist the list + purge the member's posts. (The owner's
    // own fan-out echo is a no-op re-add thanks to the Set.)
    const next = Array.from(new Set([...(get().banned[channelId] ?? []), memberAegisId]));
    try {
      await saveBannedMembers(channelId, next);
    } catch (e) {
      logger.warn(`[channels] ban persist failed: ${(e as Error).message}`);
    }
    set((s) => ({
      banned: { ...s.banned, [channelId]: next },
      feeds: {
        ...s.feeds,
        [channelId]: (s.feeds[channelId] ?? []).filter((p) => p.from !== memberAegisId),
      },
    }));
    return { ok: true };
  },

  async listPendingJoins(channelId) {
    const sk = await getChannelSigningKey(channelId);
    if (!sk) return { ok: false, error: 'not_owner' };
    const ts = Date.now();
    const sig = signPendingList(channelId, ts, sk);
    try {
      const ack = await pubchannelPending(channelId, ts, encodeBase64(sig));
      if (!ack.ok) return { ok: false, error: ack.error };
      return { ok: true, pending: ack.pending ?? [] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'pending_failed' };
    }
  },

  async answerJoinRequest(channelId, joinEpkB64, approve) {
    const sk = await getChannelSigningKey(channelId);
    if (!sk) return { ok: false, error: 'not_owner' };

    let envelope = '';
    if (approve) {
      const capability = await getChannelCapability(channelId);
      if (!capability) return { ok: false, error: 'no_capability' };
      try {
        envelope = JSON.stringify(sealApprovalCapability(capability, joinEpkB64, channelId));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'seal_failed' };
      }
    }
    const ts = Date.now();
    const sig = signApprove(channelId, joinEpkB64, ts, sk);
    try {
      const ack = await pubchannelApprove(channelId, joinEpkB64, envelope, ts, encodeBase64(sig));
      return ack.ok ? { ok: true } : { ok: false, error: ack.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'approve_failed' };
    }
  },

  async checkApprovals(identity) {
    for (const app of get().pendingApplications) {
      let status: string | undefined;
      let envelopeStr: string | undefined;
      try {
        const ack = await pubchannelCheckApproval(app.channelId, app.epkB64);
        if (!ack.ok) continue; // rate_limited / transient — retry next tick
        status = ack.status;
        envelopeStr = ack.envelope;
      } catch {
        continue;
      }

      if (status === 'not_found') {
        // Rejected or expired: drop the application (fail closed, no retry loop).
        await deleteJoinRequest(app.channelId);
        set((s) => ({ pendingApplications: s.pendingApplications.filter((a) => a.channelId !== app.channelId) }));
        continue;
      }
      if (status !== 'approved' || !envelopeStr) continue;

      const stored = await getJoinRequest(app.channelId);
      if (!stored) continue;
      let capability: Uint8Array | null = null;
      try {
        const envelope = JSON.parse(envelopeStr) as ApprovalEnvelope;
        capability = openApprovalCapability(envelope, decodeBase64(stored.eskB64), app.channelId);
      } catch {
        capability = null;
      }
      if (!capability) {
        logger.warn(`[channels] approval envelope failed to open for ${app.channelId.slice(0, 8)}…`);
        continue; // never join with an unverified capability
      }

      // Complete the join exactly like a capability-carrying invite (§10.1).
      const deliveryToken = deriveChannelDeliveryToken(capability, app.channelId);
      const ack = await pubchannelJoin(app.channelId, deliveryToken);
      if (!ack.ok || !ack.contentKeyEnvelope) continue;
      let env: { ivB64: string; wrappedB64: string };
      try {
        env = JSON.parse(ack.contentKeyEnvelope) as { ivB64: string; wrappedB64: string };
      } catch { continue; }
      const cek = unwrapCEK(env.ivB64, env.wrappedB64, capability, app.channelId);
      if (!cek) continue;
      const manifest = ack.manifest ? parseAndVerifyManifest(ack.manifest) : null;
      if (!manifest || manifest.channelId !== app.channelId) continue;
      if (manifest.contentKeyHash && !bytesEqual(sha256(cek), manifest.contentKeyHash)) continue;

      await saveChannelSecrets(app.channelId, { cek, capability });
      await deleteJoinRequest(app.channelId);
      set((s) => ({
        pendingApplications: s.pendingApplications.filter((a) => a.channelId !== app.channelId),
        subscribed: s.subscribed.some((c) => c.channelId === app.channelId)
          ? s.subscribed
          : [...s.subscribed, {
              channelId: app.channelId,
              name: manifest.name,
              description: manifest.description,
              channelType: manifestType(manifest.channelType),
              owned: false,
              avatarHash: manifest.avatarHash,
              channelEd25519PubB64: encodeBase64(manifest.channelEd25519Pub),
            }],
      }));
      await get().loadFeed(app.channelId, identity);
    }
  },
}));
