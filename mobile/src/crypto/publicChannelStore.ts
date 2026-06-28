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
const INDEX_KEY = 'aegis.pubchannel.index.v1';

const KEY_BYTES = 32;
const SIGN_SECRET_BYTES = 64; // nacl.sign secret key length

export interface ChannelSecrets {
  cek: Uint8Array;        // 32 bytes
  capability: Uint8Array; // 32 bytes
}

// ── helpers ──────────────────────────────────────────────────────────────────

function cekKey(channelId: string): string { return CEK_PREFIX + channelId; }
function capKey(channelId: string): string { return CAP_PREFIX + channelId; }
function signKey(channelId: string): string { return SIGN_PREFIX + channelId; }

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

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Every channel we hold any secret for. */
export async function listChannelIds(): Promise<string[]> {
  return loadIndex();
}

/** Wipe ALL secrets for a channel (leave/tombstone/panic) and drop it from the index. */
export async function deleteChannel(channelId: string): Promise<void> {
  await ss.delete(cekKey(channelId));
  await ss.delete(capKey(channelId));
  await ss.delete(signKey(channelId));
  await removeFromIndex(channelId);
}

/** Wipe every channel secret we hold (panic mode / full reset). */
export async function deleteAllChannels(): Promise<void> {
  const index = await loadIndex();
  for (const channelId of index) {
    await ss.delete(cekKey(channelId));
    await ss.delete(capKey(channelId));
    await ss.delete(signKey(channelId));
  }
  await ss.delete(INDEX_KEY);
}
