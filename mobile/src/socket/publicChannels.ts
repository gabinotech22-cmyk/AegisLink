/**
 * AegisLink — Sealed Public Channels socket client (Phase 2c, mobile)
 *
 * Thin, UI-agnostic transport over the relay's pubchannel:* events
 * (server/src/relay/handler.ts). The relay is a blind forwarder: NO `from` is
 * ever sent — the sender identity is sealed inside the encrypted post (golden
 * rule #4). This module only moves opaque base64 blobs + signatures; sealing,
 * opening, hashing and signing live in crypto/publicChannelKey. UI state and
 * persistence belong to later slices — keep this layer side-effect free beyond
 * the socket.
 *
 * Every relay event is feature-flagged server-side; with PUBLIC_CHANNELS off the
 * acks resolve to { ok: false, error: 'feature_disabled' }.
 */

import { getSocket } from './client';

const ACK_TIMEOUT_MS = 10_000;

export interface PubChannelAck {
  ok: boolean;
  error?: string;
}
export interface PubChannelJoinAck extends PubChannelAck {
  manifest?: string;
  /** Wrapped CEK envelope (JSON {ivB64,wrappedB64}) to unwrap with the capability. */
  contentKeyEnvelope?: string;
}
export interface PubChannelPullAck extends PubChannelAck {
  posts?: PubChannelPostWire[];
}

/** A persisted post as the relay returns it on pull/msg — ciphertext is opaque. */
export interface PubChannelPostWire {
  id?: string;
  channelId?: string;
  seqNum: number;
  ciphertext: string; // alias for ciphertext_b64 on live msg fan-out
  nonce: string;
  createdAt?: number;
  // pull returns DB rows with snake_case fields:
  ciphertext_b64?: string;
  nonce_b64?: string;
  seq_num?: number;
}

/** Live fan-out of a new post (no `from`). */
export interface PubChannelMsgEvent {
  channelId: string;
  seqNum: number;
  ciphertext: string;
  nonce: string;
  createdAt: number;
}

export interface PubChannelDeleteEvent { channelId: string; seqNum: number; }
export interface PubChannelBanEvent { channelId: string; banRecord: string; banSig: string; }
export interface PubChannelTombstoneEvent { channelId: string; ts: number; }

/** Emit an event and await its ack, rejecting if the socket is down or it times out. */
function emitWithAck<T extends PubChannelAck>(event: string, payload: unknown): Promise<T> {
  const socket = getSocket();
  if (!socket) return Promise.reject(new Error('socket_unavailable'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event}_timeout`)), ACK_TIMEOUT_MS);
    socket.emit(event, payload, (res: T | undefined) => {
      clearTimeout(timer);
      if (!res) reject(new Error(`${event}_no_ack`));
      else resolve(res);
    });
  });
}

// ── Membership ───────────────────────────────────────────────────────────────

/** Join an open channel by presenting the raw delivery token; returns the manifest. */
export function pubchannelJoin(channelId: string, deliveryToken: string): Promise<PubChannelJoinAck> {
  return emitWithAck<PubChannelJoinAck>('pubchannel:join', { channelId, deliveryToken });
}

/** Apply to an approval-gated channel with a join ephemeral pubkey (base64). */
export function pubchannelApply(channelId: string, joinEpk: string): Promise<PubChannelAck> {
  return emitWithAck<PubChannelAck>('pubchannel:apply', { channelId, joinEpk });
}

// ── Posting / reading ────────────────────────────────────────────────────────

/** Publish a sealed post. ciphertext/nonce come from sealChannelPost; relay assigns seqNum. */
export function pubchannelPost(
  channelId: string,
  ciphertext: string,
  nonce: string,
  deliveryToken: string,
): Promise<PubChannelAck> {
  return emitWithAck<PubChannelAck>('pubchannel:msg', { channelId, ciphertext, nonce, deliveryToken });
}

/** Pull posts with seqNum greater than sinceSeqNum (-1 for the full history page). */
export function pubchannelPull(channelId: string, sinceSeqNum: number): Promise<PubChannelPullAck> {
  return emitWithAck<PubChannelPullAck>('pubchannel:pull', { channelId, sinceSeqNum });
}

// ── Admin actions (signatures produced via crypto/publicChannelKey) ───────────

/** Delete a post by seqNum. `sig` = base64 signDelete(channelId, seqNum, ownerSecret). */
export function pubchannelDelete(channelId: string, seqNum: number, sig: string): Promise<PubChannelAck> {
  return emitWithAck<PubChannelAck>('pubchannel:delete', { channelId, seqNum, sig });
}

/** Ban (signed). `banSig` = base64 signBan(channelId, banRecord, ownerSecret). */
export function pubchannelBan(channelId: string, banRecord: string, banSig: string): Promise<PubChannelAck> {
  return emitWithAck<PubChannelAck>('pubchannel:ban', { channelId, banRecord, banSig });
}

/** Tombstone (signed) — permanently destroys the channel. */
export function pubchannelTombstone(channelId: string, ts: number, sig: string): Promise<PubChannelAck> {
  return emitWithAck<PubChannelAck>('pubchannel:tombstone', { channelId, ts, sig });
}

// ── Subscriptions ────────────────────────────────────────────────────────────
// Each returns an unsubscribe fn; no-op if the socket is unavailable.

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  const socket = getSocket();
  if (!socket) return () => {};
  socket.on(event, cb);
  return () => { socket.off(event, cb); };
}

export function onPubchannelMsg(cb: (e: PubChannelMsgEvent) => void): () => void {
  return subscribe<PubChannelMsgEvent>('pubchannel:msg', cb);
}
export function onPubchannelDelete(cb: (e: PubChannelDeleteEvent) => void): () => void {
  return subscribe<PubChannelDeleteEvent>('pubchannel:delete', cb);
}
export function onPubchannelBan(cb: (e: PubChannelBanEvent) => void): () => void {
  return subscribe<PubChannelBanEvent>('pubchannel:ban', cb);
}
export function onPubchannelTombstone(cb: (e: PubChannelTombstoneEvent) => void): () => void {
  return subscribe<PubChannelTombstoneEvent>('pubchannel:tombstone', cb);
}
