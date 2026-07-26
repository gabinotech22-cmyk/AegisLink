/**
 * profileBroadcast.ts — pure helpers for the phantom-notification dedup guard.
 *
 * Extracted from client.ts so they can be unit-tested in node-env vitest (the
 * socket client module itself touches the window.aegis preload bridge and is out
 * of scope). Behaviour MUST match mobile/src/socket/client.ts byte-for-byte, so
 * the same profile produces the same fingerprint on both platforms.
 *
 * Background: a profile broadcast is a real E2EE envelope. To an OFFLINE contact
 * the relay queues it and fires the SAME generic "Nuevo mensaje cifrado" wake-up
 * push as a real message — but on open there is nothing to show (profile_update
 * is applied silently). Broadcasting on every auth:ok therefore spammed every
 * established contact with a phantom notification on each reconnect. The guard
 * skips the broadcast when the fingerprint is unchanged since the last one.
 */

/**
 * Cheap, stable fingerprint (FNV-1a 32-bit) of the broadcast-relevant profile
 * fields. NOT cryptographic — it only answers "did my own profile change since
 * the last broadcast?", so a rare collision would at worst defer ONE profile
 * refresh to a contact until the next real change (self-healing), never corrupt
 * anything.
 */
export function profileFingerprint(canonical: string): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV-1a 32-bit prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** SecureStore key holding the last successfully-broadcast profile fingerprint. */
export function profileBroadcastHashKey(aegisId: string): string {
  return `aegis.pbh.${aegisId}`;
}
