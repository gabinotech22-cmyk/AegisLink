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
import { listPublicChannels, registerPublicChannel, getPublicChannelManifest, setChannelAvatar, type PublicChannelType } from '../api/publicChannels';
import { uploadAvatarBlob, cacheLocalAvatar } from '../channels/channelAvatarCache';
import { logger } from '../utils/logger';
import {
  pubchannelJoin,
  pubchannelPost,
  pubchannelPull,
  pubchannelTombstone,
  onPubchannelMsg,
  onPubchannelTombstone,
} from '../socket/publicChannels';
import {
  parseAndVerifyManifest,
  ingestChannelPosts,
  buildAndSealPost,
  normalizePullRow,
  serializeSignedManifest,
  type ChainHead,
  type SignerResolver,
} from '../channels/channelService';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  signTombstone,
  signAvatarSet,
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
  getChannelDeliveryToken,
  isChannelOwned,
  deleteChannel as deleteChannelSecrets,
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
  channelType: PublicChannelType;
  owned: boolean;
  /** SHA-256 committed in the signed manifest, or null if no avatar. */
  avatarHash: Uint8Array | null;
}

/** A UI-facing, already-authenticated post. */
export interface FeedPost {
  id: string;
  from: string;
  body: string;
  ts: number;
  seqNum: number;
}

interface ChannelsState {
  directory: DirectoryEntry[];
  loadingDirectory: boolean;
  subscribed: ChannelSummary[];
  feeds: Record<string, FeedPost[]>;
  heads: Record<string, ChainHead | null>;

  loadDirectory: () => Promise<void>;
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
  joinViaInvite: (inviteUrl: string, identity: Identity) => Promise<{ ok: boolean; channelId?: string; error?: string }>;
  joinChannel: (channelId: string, capability: Uint8Array, cek: Uint8Array) => Promise<{ ok: boolean; error?: string }>;
  loadFeed: (channelId: string, identity: Identity) => Promise<void>;
  sendPost: (channelId: string, body: string, identity: Identity) => Promise<{ ok: boolean; error?: string }>;
  attachLive: (identity: Identity) => () => void;
  removeChannel: (channelId: string) => Promise<void>;
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
  return { id: `${channelId}:${p.post.seqNum}`, from: p.post.from, body: p.post.body, ts: p.post.ts, seqNum: p.post.seqNum };
}

export const useChannels = create<ChannelsState>((set, get) => ({
  directory: [],
  loadingDirectory: false,
  subscribed: [],
  feeds: {},
  heads: {},

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
        channelType: params.channelType,
        owned: true,
        avatarHash: params.avatarHash ?? null,
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
    // Approval-gated joins need the admin to deliver the capability (gap E / Phase 4).
    if (!parsed.capability) return { ok: false, error: 'approval_required' };

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
            channelType: CHANNEL_TYPE_NAMES[manifest.channelType] ?? 'open',
            owned: false,
            avatarHash: manifest.avatarHash,
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
      channelType: manifest ? manifestType(manifest.channelType) : 'open',
      owned: await isChannelOwned(channelId),
      avatarHash: manifest?.avatarHash ?? null,
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

  async sendPost(channelId, body, identity) {
    const cek = await getChannelCEK(channelId);
    if (!cek) return { ok: false, error: 'not_subscribed' };
    const deliveryToken = await getChannelDeliveryToken(channelId);
    if (!deliveryToken) return { ok: false, error: 'no_delivery_token' };

    const head = get().heads[channelId] ?? null;
    const sealed = buildAndSealPost(
      channelId,
      { from: identity.aegisId, body, ts: Date.now() },
      head,
      identity.signingSecretKey,
      cek,
    );

    const ack = await pubchannelPost(channelId, sealed.wire.ciphertext, sealed.wire.nonce, deliveryToken);
    if (!ack.ok) return { ok: false, error: ack.error };

    const optimistic: FeedPost = { id: `${channelId}:${sealed.seqNum}`, from: identity.aegisId, body, ts: Date.now(), seqNum: sealed.seqNum };
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
    const offTomb = onPubchannelTombstone((e) => {
      void get().removeChannel(e.channelId);
    });
    return () => { offMsg(); offTomb(); };
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
}));
