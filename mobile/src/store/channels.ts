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
import { decodeBase64 } from 'tweetnacl-util';
import type { Identity } from '../crypto/identity';
import { useContacts } from './contacts';
import { listPublicChannels, type PublicChannelType } from '../api/publicChannels';
import {
  pubchannelJoin,
  pubchannelPost,
  pubchannelPull,
  onPubchannelMsg,
  onPubchannelTombstone,
} from '../socket/publicChannels';
import {
  parseAndVerifyManifest,
  ingestChannelPosts,
  buildAndSealPost,
  normalizePullRow,
  type ChainHead,
  type SignerResolver,
} from '../channels/channelService';
import {
  saveChannelSecrets,
  getChannelCEK,
  getChannelDeliveryToken,
  isChannelOwned,
  deleteChannel as deleteChannelSecrets,
} from '../crypto/publicChannelStore';

const CHANNEL_TYPE_NAMES: PublicChannelType[] = ['open', 'readonly', 'moderated', 'approval'];

/** A verified directory entry — name/type extracted from a signature-checked manifest. */
export interface DirectoryEntry {
  channelId: string;
  name: string;
  description: string;
  channelType: PublicChannelType;
}

/** A channel we hold secrets for (appears in the subscribed list). */
export interface ChannelSummary {
  channelId: string;
  name: string;
  channelType: PublicChannelType;
  owned: boolean;
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
        });
      }
      set({ directory: verified });
    } finally {
      set({ loadingDirectory: false });
    }
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
