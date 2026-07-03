/**
 * AegisLink — Sealed Public Channels secret store (Phase 2b, mobile)
 *
 * Persists ONLY the per-channel SECRETS in expo-secure-store (Keychain /
 * Keystore, hardware-bound, this-device-only — see utils/secureStore.ts):
 *
 *  - capability (32 bytes): the channel access secret shared via invite. Whoever
 *    holds it can derive the delivery token AND unwrap the CEK, so it never
 *    leaves the device and never hits SQLite/AsyncStorage/network.
 *  - CEK (32 bytes): the content encryption key, kept unwrapped for fast
 *    seal/open. Re-derivable from (capability, wrapped-CEK) but cached here.
 *  - signing secret (64 bytes): only for channels WE administer (created/owned).
 *    Its presence is what marks a channel as owned.
 *
 * Public, non-secret data (the signed manifest blob, channel name/type, post
 * history) is NOT stored here — it is reproducible/served by the relay and would
 * risk SecureStore's small per-item size limits. That lives in the
 * subscribed-channels list (a later slice).
 *
 * The delivery token is NOT persisted: it is derived on demand from the
 * capability (deriveChannelDeliveryToken), so there is one fewer secret at rest.
 *
 * SecureStore has no key-enumeration API, so a JSON index tracks which channels
 * we hold secrets for.
 */

import { ss } from '../utils/secureStore';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { deriveChannelDeliveryToken } from './publicChannelKey';

const CEK_PREFIX = 'aegis.pubchannel.cek.v1.';
const CAP_PREFIX = 'aegis.pubchannel.cap.v1.';
const SIGN_PREFIX = 'aegis.pubchannel.sign.v1.';
const HEAD_PREFIX = 'aegis.pubchannel.head.v1.';
const META_PREFIX = 'aegis.pubchannel.meta.v1.';
const INDEX_KEY = 'aegis.pubchannel.index.v1';

const KEY_BYTES = 32;
const SIGN_SECRET_BYTES = 64; // nacl.sign secret key length

export interface ChannelSecrets {
  cek: Uint8Array;        // 32 bytes
  capability: Uint8Array; // 32 bytes
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * SecureStore only allows [A-Za-z0-9._-] in item keys, but channelIds are
 * STANDARD base64 (may contain '+', '/' and trailing '='). Map them to the
 * base64url alphabet without padding — injective for fixed-length ids, so no
 * two channels can collide. The channelId itself (wire, manifests, HKDF
 * inputs) is untouched.
 */
function safeId(channelId: string): string {
  return channelId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cekKey(channelId: string): string { return CEK_PREFIX + safeId(channelId); }
function capKey(channelId: string): string { return CAP_PREFIX + safeId(channelId); }
function signKey(channelId: string): string { return SIGN_PREFIX + safeId(channelId); }
function headKey(channelId: string): string { return HEAD_PREFIX + safeId(channelId); }
function metaKey(channelId: string): string { return META_PREFIX + safeId(channelId); }

/** Decode a base64 secret and enforce its exact byte length, else null. */
function decodeFixed(b64: string | null, expectedLen: number): Uint8Array | null {
  if (!b64) return null;
  try {
    const bytes = decodeBase64(b64);
    return bytes.length === expectedLen ? bytes : null;
  } catch {
    return null;
  }
}

async function loadIndex(): Promise<string[]> {
  const raw = await ss.get(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function addToIndex(channelId: string): Promise<void> {
  const index = await loadIndex();
  if (!index.includes(channelId)) {
    await ss.set(INDEX_KEY, JSON.stringify([...index, channelId]));
  }
}

async function removeFromIndex(channelId: string): Promise<void> {
  const index = await loadIndex();
  const next = index.filter((c) => c !== channelId);
  if (next.length !== index.length) {
    await ss.set(INDEX_KEY, JSON.stringify(next));
  }
}

// ── channel secrets (CEK + capability) ───────────────────────────────────────

/** Persist a channel's CEK + capability. Both must be exactly 32 bytes. */
export async function saveChannelSecrets(channelId: string, secrets: ChannelSecrets): Promise<void> {
  if (secrets.cek.length !== KEY_BYTES) throw new Error('saveChannelSecrets: CEK must be 32 bytes');
  if (secrets.capability.length !== KEY_BYTES) throw new Error('saveChannelSecrets: capability must be 32 bytes');
  await ss.set(cekKey(channelId), encodeBase64(secrets.cek));
  await ss.set(capKey(channelId), encodeBase64(secrets.capability));
  await addToIndex(channelId);
}

/** A channel's CEK, or null if we don't hold it (or it's malformed). */
export async function getChannelCEK(channelId: string): Promise<Uint8Array | null> {
  return decodeFixed(await ss.get(cekKey(channelId)), KEY_BYTES);
}

/** A channel's capability, or null if we don't hold it. */
export async function getChannelCapability(channelId: string): Promise<Uint8Array | null> {
  return decodeFixed(await ss.get(capKey(channelId)), KEY_BYTES);
}

/**
 * The raw delivery token to present on join/post, derived on demand from the
 * stored capability. Null if we don't hold the capability.
 */
export async function getChannelDeliveryToken(channelId: string): Promise<string | null> {
  const capability = await getChannelCapability(channelId);
  if (!capability) return null;
  return deriveChannelDeliveryToken(capability, channelId);
}

// ── owned-channel signing key ────────────────────────────────────────────────

/** Persist the Ed25519 signing secret for a channel we administer (64 bytes). */
export async function saveChannelSigningKey(channelId: string, signingSecret: Uint8Array): Promise<void> {
  if (signingSecret.length !== SIGN_SECRET_BYTES) {
    throw new Error('saveChannelSigningKey: signing secret must be 64 bytes');
  }
  await ss.set(signKey(channelId), encodeBase64(signingSecret));
  await addToIndex(channelId);
}

/** The channel signing secret if we own this channel, else null. */
export async function getChannelSigningKey(channelId: string): Promise<Uint8Array | null> {
  return decodeFixed(await ss.get(signKey(channelId)), SIGN_SECRET_BYTES);
}

/** Whether we hold admin signing authority for this channel. */
export async function isChannelOwned(channelId: string): Promise<boolean> {
  return (await getChannelSigningKey(channelId)) !== null;
}

// ── approval-gated join requests (Phase 4) ──────────────────────────────────
// The applicant's ephemeral X25519 secret must survive an app restart between
// apply and approval; it is a key, so it lives here (never SQLite/AsyncStorage).

const APPLY_PREFIX = 'aegis.pubchannel.applyesk.v1.';
const APPLY_INDEX_KEY = 'aegis.pubchannel.applyindex.v1';

export interface StoredJoinRequest {
  channelId: string;
  /** Channel name at apply time — display only. */
  name: string;
  epkB64: string;
  eskB64: string;
}

async function loadApplyIndex(): Promise<string[]> {
  const raw = await ss.get(APPLY_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveJoinRequest(req: StoredJoinRequest): Promise<void> {
  await ss.set(APPLY_PREFIX + safeId(req.channelId), JSON.stringify(req));
  const index = await loadApplyIndex();
  if (!index.includes(req.channelId)) {
    await ss.set(APPLY_INDEX_KEY, JSON.stringify([...index, req.channelId]));
  }
}

export async function getJoinRequest(channelId: string): Promise<StoredJoinRequest | null> {
  const raw = await ss.get(APPLY_PREFIX + safeId(channelId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredJoinRequest;
  } catch {
    return null;
  }
}

export async function listJoinRequests(): Promise<StoredJoinRequest[]> {
  const index = await loadApplyIndex();
  const out: StoredJoinRequest[] = [];
  for (const channelId of index) {
    const req = await getJoinRequest(channelId);
    if (req) out.push(req);
  }
  return out;
}

export async function deleteJoinRequest(channelId: string): Promise<void> {
  await ss.delete(APPLY_PREFIX + safeId(channelId));
  const index = await loadApplyIndex();
  const next = index.filter((c) => c !== channelId);
  if (next.length !== index.length) {
    await ss.set(APPLY_INDEX_KEY, JSON.stringify(next));
  }
}

// ── banned members (owner moderation + received ban records) ────────────────
// The roster/ban list is client-side only (docs §10.5): the relay never stores
// or learns it. Persisted here (not SQLite) so the list survives restarts
// without adding a new plaintext at-rest surface.

const BAN_PREFIX = 'aegis.pubchannel.banned.v1.';

function banKey(channelId: string): string { return BAN_PREFIX + safeId(channelId); }

/** Persist the full banned-aegisId list for a channel (overwrites). */
export async function saveBannedMembers(channelId: string, bannedAegisIds: string[]): Promise<void> {
  await ss.set(banKey(channelId), JSON.stringify(bannedAegisIds));
}

/** The banned-aegisId list for a channel ([] when none / malformed). */
export async function getBannedMembers(channelId: string): Promise<string[]> {
  const raw = await ss.get(banKey(channelId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Every channel we hold any secret for. */
export async function listChannelIds(): Promise<string[]> {
  return loadIndex();
}

// ── chain head (NON-secret, cached for delta detection) ──────────────────────
// The verified chain head { seqNum, postHash } is not key material — postHash is
// a hash of already-public ciphertext. It is persisted this-device-only so a
// cold launch (foreground OR a background-sync task) can resume with a DELTA
// pull (`since = head.seqNum`) instead of re-pulling the whole history, and so
// new posts can be detected + notified. Losing it only costs a full re-pull.

/** Persist the verified chain head for a channel. */
export async function saveChannelHead(channelId: string, head: { seqNum: number; postHash: Uint8Array }): Promise<void> {
  await ss.set(headKey(channelId), JSON.stringify({ seqNum: head.seqNum, postHashB64: encodeBase64(head.postHash) }));
}

/** The persisted chain head for a channel, or null if none/malformed. */
export async function getChannelHead(channelId: string): Promise<{ seqNum: number; postHash: Uint8Array } | null> {
  const raw = await ss.get(headKey(channelId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { seqNum?: unknown; postHashB64?: unknown };
    if (typeof parsed.seqNum !== 'number' || typeof parsed.postHashB64 !== 'string') return null;
    return { seqNum: parsed.seqNum, postHash: decodeBase64(parsed.postHashB64) };
  } catch {
    return null;
  }
}

// ── channel metadata (NON-secret, cached display info) ───────────────────────
// name/type/avatarHash come from the signed manifest, which the relay serves.
// Caching them this-device-only lets us keep LISTING a channel (with its real
// name) after a restart even when the manifest re-fetch fails on a flaky network
// — instead of dropping it to a nameless "Channels" fallback. Refreshed from the
// verified manifest whenever a fetch DOES succeed.

export interface ChannelMeta {
  name: string;
  description: string;
  channelType: string;
  avatarHash: string | null;
  channelEd25519PubB64: string | null;
}

/** Cache a channel's display metadata (from a verified manifest). */
export async function saveChannelMeta(channelId: string, meta: ChannelMeta): Promise<void> {
  await ss.set(metaKey(channelId), JSON.stringify(meta));
}

/** The cached display metadata for a channel, or null if none/malformed. */
export async function getChannelMeta(channelId: string): Promise<ChannelMeta | null> {
  const raw = await ss.get(metaKey(channelId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ChannelMeta>;
    if (typeof p.name !== 'string' || typeof p.channelType !== 'string') return null;
    return {
      name: p.name,
      description: typeof p.description === 'string' ? p.description : '',
      channelType: p.channelType,
      avatarHash: typeof p.avatarHash === 'string' ? p.avatarHash : null,
      channelEd25519PubB64: typeof p.channelEd25519PubB64 === 'string' ? p.channelEd25519PubB64 : null,
    };
  } catch {
    return null;
  }
}

/** Wipe ALL secrets for a channel (leave/tombstone/panic) and drop it from the index. */
export async function deleteChannel(channelId: string): Promise<void> {
  await ss.delete(cekKey(channelId));
  await ss.delete(capKey(channelId));
  await ss.delete(signKey(channelId));
  await ss.delete(banKey(channelId));
  await ss.delete(headKey(channelId));
  await ss.delete(metaKey(channelId));
  await removeFromIndex(channelId);
}

/** Wipe every channel secret we hold (panic mode / full reset). */
export async function deleteAllChannels(): Promise<void> {
  const index = await loadIndex();
  for (const channelId of index) {
    await ss.delete(cekKey(channelId));
    await ss.delete(capKey(channelId));
    await ss.delete(signKey(channelId));
    await ss.delete(banKey(channelId));
    await ss.delete(headKey(channelId));
    await ss.delete(metaKey(channelId));
  }
  await ss.delete(INDEX_KEY);
  // Panic also drops any in-flight approval join requests.
  const applyIndex = await loadApplyIndex();
  for (const channelId of applyIndex) {
    await ss.delete(APPLY_PREFIX + safeId(channelId));
  }
  await ss.delete(APPLY_INDEX_KEY);
}
