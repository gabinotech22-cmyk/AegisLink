/**
 * DIDManager.ts
 *
 * Caches the identity's DID: the did:key of its Ed25519 signing key.
 *
 * - Derived locally, no network (deriveDID.ts); cached in SecureStore under
 *   `aegis.did.v1.<aegisId>` so the Profile screen can show it. Onboarding and
 *   Profile derive it for every identity.
 * - The client never sends the DID anywhere unless the user shares it.
 *
 * Privacy — what a DID does and does not hide:
 *   - It reveals no real-world identity (no phone/email/name behind it).
 *   - It is NOT unlinkable from the aegisId: it encodes the same signing public
 *     key the relay stores for the identity and serves in the public prekey
 *     bundle (GET /prekeys/bundle/:aegisId), so anyone who knows an aegisId can
 *     compute its DID. Treat the DID as another public name of the identity.
 *   - When the owner deletes the account, the relay deactivates this DID
 *     (routes/identity.ts); the local cache is cleared by the wipe
 *     (db/core.ts purgeGlobalAppState → clearDID).
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
 * Clears the cached DID for an identity. Called by the wipe
 * (db/core.ts purgeGlobalAppState) on panic wipe / identity reset.
 */
export async function clearDID(profileId: string): Promise<void> {
  const storeKey = `${DID_STORE_KEY_PREFIX}${profileId}`;
  await ss.delete(storeKey);
}
