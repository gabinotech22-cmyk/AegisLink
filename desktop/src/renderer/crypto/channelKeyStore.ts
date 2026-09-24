import { ss } from '../utils/secureStore';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { SenderKey } from './channelKey';

// ---------------------------------------------------------------------------
// Persistence for SenderKeys. Stored ONLY in expo-secure-store
// (Keychain / Keystore) — never SQLite, never AsyncStorage, never network.
// ---------------------------------------------------------------------------

const PREFIX = 'aegis.channelKey.v1';
// Tracks which (channelId, senderAegisId) pairs exist, since SecureStore has no
// key enumeration API.
const INDEX_PREFIX = 'aegis.channelKeyIndex.v1';

// SecureStore only allows [A-Za-z0-9._-] in item keys; ids may be standard
// base64 ('+', '/', trailing '='). Map to base64url without padding —
// injective for fixed-length ids and identity for already-safe strings.
function safeId(id: string): string {
  return id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function keyFor(channelId: string, senderAegisId: string): string {
  return `${PREFIX}.${safeId(channelId)}.${safeId(senderAegisId)}`;
}

function indexKeyFor(channelId: string): string {
  return `${INDEX_PREFIX}.${safeId(channelId)}`;
}

interface StoredSenderKey {
  chainKeyB64: string;
  iteration: number;
}

async function loadIndex(channelId: string): Promise<string[]> {
  const raw = await ss.get(indexKeyFor(channelId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function saveIndex(channelId: string, senders: string[]): Promise<void> {
  await ss.set(indexKeyFor(channelId), JSON.stringify(senders));
}

export async function saveSenderKey(
  channelId: string,
  senderAegisId: string,
  sk: SenderKey
): Promise<void> {
  const stored: StoredSenderKey = {
    chainKeyB64: encodeBase64(sk.chainKey),
    iteration: sk.iteration,
  };
  await ss.set(keyFor(channelId, senderAegisId), JSON.stringify(stored));

  const index = await loadIndex(channelId);
  if (!index.includes(senderAegisId)) {
    await saveIndex(channelId, [...index, senderAegisId]);
  }
}

export async function loadSenderKey(
  channelId: string,
  senderAegisId: string
): Promise<SenderKey | null> {
  const raw = await ss.get(keyFor(channelId, senderAegisId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSenderKey;
    const chainKey = decodeBase64(parsed.chainKeyB64);
    if (chainKey.length !== 32) return null;
    return { chainKey, iteration: parsed.iteration };
  } catch {
    return null;
  }
}

export async function deleteSenderKey(channelId: string, senderAegisId: string): Promise<void> {
  await ss.delete(keyFor(channelId, senderAegisId));
  const index = await loadIndex(channelId);
  const next = index.filter((s) => s !== senderAegisId);
  if (next.length !== index.length) {
    await saveIndex(channelId, next);
  }
}

export async function loadAllSenderKeysForChannel(
  channelId: string
): Promise<Map<string, SenderKey>> {
  const index = await loadIndex(channelId);
  const result = new Map<string, SenderKey>();
  for (const senderAegisId of index) {
    const sk = await loadSenderKey(channelId, senderAegisId);
    if (sk) result.set(senderAegisId, sk);
  }
  return result;
}

/**
 * Delete EVERY sender chain key for a channel plus its index — the
 * factory-reset path (purgeGlobalAppState). Per-channel because the store's
 * only enumeration is the per-channel sender index; the wipe caller walks the
 * group/channel ids it can still read before the DB rows die.
 */
export async function deleteAllSenderKeysForChannel(channelId: string): Promise<void> {
  const index = await loadIndex(channelId);
  for (const senderAegisId of index) {
    await ss.delete(keyFor(channelId, senderAegisId)).catch(() => {});
  }
  await ss.delete(indexKeyFor(channelId)).catch(() => {});
}
