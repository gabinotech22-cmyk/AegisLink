/**
 * DIDManager.ts
 *
 * Manages a user's optional DID (Decentralized Identifier).
 *
 * - DID is derived locally from the Ed25519 signing key — no network required.
 * - DID is cached in expo-secure-store so it survives app restarts.
 * - A user who never calls DIDManager has zero DID footprint.
 * - The DID is NOT sent to the AegisLink relay — it is the user's choice
 *   to share it.
 *
 * Privacy contract:
 *   - DID is pseudonymous (derived from public key, unlinkable to real identity
 *     unless user explicitly shares it).
 *   - The server never receives the DID unless the user opts in.
 *   - No correlation between DID and aegisId is made on the server.
 */

import { ss } from '../../utils/secureStore';
import { deriveDIDFromPublicKey } from './deriveDID';

const DID_STORE_KEY_PREFIX = 'aegis.did.v1.';

export interface DIDRecord {
  did: string;
  profileId: string;
  derivedAt: number;
}

/**
 * Returns the cached DID for a profile, or derives and caches a new one.
 *
 * @param profileId - The aegisId string for the profile.
 * @param publicKey - The 32-byte Ed25519 signing public key for this profile.
 */
export async function getOrCreateDID(
  profileId: string,
  publicKey: Uint8Array
): Promise<DIDRecord> {
  const storeKey = `${DID_STORE_KEY_PREFIX}${profileId}`;
  const cached = await ss.get(storeKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as DIDRecord;
      if (parsed.did && parsed.profileId === profileId) {
        return parsed;
      }
    } catch {
      // Corrupt cache entry — fall through to re-derive.
    }
  }

  const did = deriveDIDFromPublicKey(publicKey);
  const record: DIDRecord = {
    did,
    profileId,
    derivedAt: Date.now(),
  };
  await ss.set(storeKey, JSON.stringify(record));
  return record;
}

/**
 * Returns the cached DID for a profile without creating one.
 * Returns null if no DID has been derived yet.
 */
export async function getDID(profileId: string): Promise<DIDRecord | null> {
  const storeKey = `${DID_STORE_KEY_PREFIX}${profileId}`;
  const cached = await ss.get(storeKey);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached) as DIDRecord;
    if (parsed.did && parsed.profileId === profileId) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Clears the cached DID for a profile.
 * Call this on identity reset / panic wipe.
 */
export async function clearDID(profileId: string): Promise<void> {
  const storeKey = `${DID_STORE_KEY_PREFIX}${profileId}`;
  await ss.delete(storeKey);
}
