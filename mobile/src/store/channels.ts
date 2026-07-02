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
  onPubchannelMsg,
  onPubchannelDelete,
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
} from '../channels/channelService';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  signTombstone,
  signAvatarSet,
  signDelete,
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
  sendPost: (channelId: string, body: string, identity: Identity, senderName?: string) => Promise<{ ok: boolean; error?: string }>;
  attachLive: (identity: Identity) => () => void;
  removeChannel: (channelId: string) => Promise<void>;

  // ── Phase 4: owner admin + approval-gated joins ────────────────────────────
  /** Waiting-for-approval applications (approval-gated channels). */
  pendingApplications: Array<{ channelId: string; name: string; epkB64: string }>;
  /** Owner: rename / edit description (re-signs the manifest, seq+1). */
  updateChannelInfo: (channelId: string, updates: { name?: string; description?: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Owner: delete a post for everyone (signed; relay fans out). */
  deletePost: (channelId: string, seqNum: number) => Promise<{ ok: boolean; error?: string }>;
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

function postToFeed(p: { post: { from: string; body: string; ts: number; seqNum: number } }, channelId: string): FeedPost {
  const { text, senderName } = openPostBody(p.post.body);
  return { id: `${channelId}:${p.post.seqNum}`, from: p.post.from, body: text, senderName, ts: p.post.ts, seqNum: p.post.seqNum };
}

export const useChannels = create<ChannelsState>((set, get) => ({
  directory: [],
  loadingDirectory: false,
  subscribed: [],
  hydrated: false,
  pendingApplications: [],
  feeds: {},
  heads: {},

  async hydrateSubscribed() {
    const ids = await listChannelIds();
    const known = new Set(get().subscribed.map((c) => c.channelId));
    const restored: ChannelSummary[] = [];
    for (const channelId of ids) {
      if (known.has(channelId)) continue;
      let blob: string;
      try {
        ({ signed_manifest_blob: blob } = await getPublicChannelManifest(channelId));
      } catch (e) {
        // Offline or tombstoned: keep the secrets, just skip listing for now —
        // the next hydrate retries. Deleting secrets on a fetch error would
        // destroy access on a flaky network.
        logger.warn(`[channels] hydrate: manifest fetch failed for ${channelId.slice(0, 8)}…: ${(e as Error).message}`);
        continue;
      }
      const manifest = parseAndVerifyManifest(blob);
      if (!manifest || manifest.channelId !== channelId) continue; // forged/corrupt → never trust
      if (deriveChannelId(manifest.channelEd25519Pub, manifest.salt) !== channelId) continue;
      restored.push({
        channelId,
        name: manifest.name,
        description: manifest.description,
        channelType: manifestType(manifest.channelType),
        owned: await isChannelOwned(channelId),
        avatarHash: manifest.avatarHash,
        channelEd25519PubB64: encodeBase64(manifest.channelEd25519Pub),
      });
    }
    // Restore in-flight approval applications too (they survive restarts in
    // SecureStore alongside their ephemeral secrets).
    const requests = await listJoinRequests();
    set((s) => ({
      hydrated: true,
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

    set((s) => ({
      subscribed: [...s.subscribed, {
        channelId: id.channelId,
        name: params.name,
        description: params.description,
        channelType: params.channelType,
        owned: true,
        avatarHash: params.avatarHash ?? null,
        channelEd25519PubB64: encodeBase64(id.channelEd25519Pub),
      }],
    }));

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
    set((s) => ({
      subscribed: s.subscribed.some((c) => c.channelId === parsed.channelId)
        ? s.subscribed
        : [...s.subscribed, {
            channelId: parsed.channelId,
            name: manifest.name,
            description: manifest.description,
            channelType: CHANNEL_TYPE_NAMES[manifest.channelType] ?? 'open',
            owned: false,
            avatarHash: manifest.avatarHash,
            channelEd25519PubB64: encodeBase64(manifest.channelEd25519Pub),
          }],
    }));
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
    return { ok: true };
  },

  async loadFeed(channelId, identity) {
    const cek = await getChannelCEK(channelId);
    if (!cek) return; // not subscribed / no key
    const head = get().heads[channelId] ?? null;
    const since = head ? head.seqNum : -1;

    const ack = await pubchannelPull(channelId, since);
    if (!ack.ok || !ack.posts) return;

    const sealed = ack.posts.map(normalizePullRow).filter((p): p is NonNullable<typeof p> => p !== null);
    const result = ingestChannelPosts(channelId, sealed, cek, makeSignerResolver(identity), head);
    if (result.posts.length === 0) return;

    const fresh = result.posts.map((p) => postToFeed(p, channelId));
    set((s) => ({
      feeds: { ...s.feeds, [channelId]: [...(s.feeds[channelId] ?? []), ...fresh] },
      heads: { ...s.heads, [channelId]: result.head },
    }));
  },

  async sendPost(channelId, body, identity, senderName) {
    const cek = await getChannelCEK(channelId);
    if (!cek) return { ok: false, error: 'not_subscribed' };
    const deliveryToken = await getChannelDeliveryToken(channelId);
    if (!deliveryToken) return { ok: false, error: 'no_delivery_token' };

    const head = get().heads[channelId] ?? null;
    const wireBody = encodePostBody(body, senderName);
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
      ts: Date.now(),
      seqNum: sealed.seqNum,
    };
    set((s) => ({
      feeds: { ...s.feeds, [channelId]: [...(s.feeds[channelId] ?? []), optimistic] },
      heads: { ...s.heads, [channelId]: sealed.newHead },
    }));
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
        const fresh = result.posts.map((p) => postToFeed(p, e.channelId));
        set((s) => ({
          feeds: { ...s.feeds, [e.channelId]: [...(s.feeds[e.channelId] ?? []), ...fresh] },
          heads: { ...s.heads, [e.channelId]: result.head },
        }));
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
    });
    const offTomb = onPubchannelTombstone((e) => {
      void get().removeChannel(e.channelId);
    });
    return () => { offMsg(); offDelete(); offTomb(); };
  },

  async removeChannel(channelId) {
    await deleteChannelSecrets(channelId);
    set((s) => {
      const feeds = { ...s.feeds }; delete feeds[channelId];
      const heads = { ...s.heads }; delete heads[channelId];
      return {
        subscribed: s.subscribed.filter((c) => c.channelId !== channelId),
        feeds,
        heads,
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

    const next = { ...current, name, description, manifestSeq: current.manifestSeq + 1 };
    const sig = signManifest(next, sk);
    try {
      await updatePublicChannelManifest(channelId, serializeSignedManifest(next, sig));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'update_failed' };
    }
    set((s) => ({
      subscribed: s.subscribed.map((c) =>
        c.channelId === channelId ? { ...c, name, description } : c,
      ),
    }));
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
