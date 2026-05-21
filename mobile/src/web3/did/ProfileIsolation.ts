/**
 * ProfileIsolation.ts
 *
 * Enforces DID isolation between AegisLink profiles (personal / work).
 *
 * Each profile has its own independent DID. The DIDs must never be
 * cross-correlated — they are derived from the same underlying keypair
 * but appear as separate identities to the outside world.
 *
 * This module provides helpers to manage per-profile DID state and
 * to prevent accidental leakage between profiles.
 */

import { getDID, getOrCreateDID, clearDID, type DIDRecord } from './DIDManager';

export type ProfileType = 'personal' | 'work';

/**
 * Returns a namespaced profile ID combining the aegisId and profile type.
 * This ensures the DID cache key is unique per (identity, profile) pair.
 */
export function profileScopedId(aegisId: string, profile: ProfileType): string {
  return `${aegisId}::${profile}`;
}

/**
 * Gets or creates the DID for the given profile.
 * The publicKey must match the signing public key for that profile's identity.
 */
export async function getOrCreateProfileDID(
  aegisId: string,
  profile: ProfileType,
  publicKey: Uint8Array
): Promise<DIDRecord> {
  const profileId = profileScopedId(aegisId, profile);
  return getOrCreateDID(profileId, publicKey);
}

/**
 * Returns the DID for a profile if it has already been derived, null otherwise.
 */
export async function getProfileDID(
  aegisId: string,
  profile: ProfileType
): Promise<DIDRecord | null> {
  const profileId = profileScopedId(aegisId, profile);
  return getDID(profileId);
}

/**
 * Clears the DID for a specific profile.
 * Call on profile switch, reset, or panic wipe.
 */
export async function clearProfileDID(
  aegisId: string,
  profile: ProfileType
): Promise<void> {
  const profileId = profileScopedId(aegisId, profile);
  await clearDID(profileId);
}

/**
 * Clears DIDs for all known profiles of a given aegisId.
 * Use during full identity wipe (panic mode / reset).
 */
export async function clearAllProfileDIDs(aegisId: string): Promise<void> {
  await Promise.all([
    clearProfileDID(aegisId, 'personal'),
    clearProfileDID(aegisId, 'work'),
  ]);
}

/**
 * Verifies that two DIDRecords belong to different profiles.
 * Returns true if they are isolated (different profile scoped IDs).
 * This is a guard check, not a cryptographic proof.
 */
export function assertProfilesIsolated(a: DIDRecord, b: DIDRecord): boolean {
  return a.profileId !== b.profileId && a.did !== b.did;
}
