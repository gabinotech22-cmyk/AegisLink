/**
 * B-3 — age-based Signed PreKey rotation: PURE decision helpers.
 *
 * These live in their own module (no `window.aegis`, no stores, no I/O) so the
 * desktop node-env vitest suite can import and test them directly — the socket
 * client module itself touches the preload bridge and is out of test scope.
 *
 * Behaviour mirrors mobile/src/socket/client.ts (isSignedPreKeyStale + the K=5
 * prune in uploadPreKeys); both platforms must stay in lockstep (regla #5).
 */

/**
 * Rotation cadence. Signal rotates the SPK ~weekly regardless of one-time-prekey
 * consumption, bounding how long a single SPK secret protects new sessions —
 * medium-term forward secrecy even for a device that never depletes its OPKs.
 */
export const SPK_ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Number of recent SPK secrets to retain for the grace window. K=5 keeps ≥28
 * days of decryptability at weekly cadence, covering the relay's 30-day queue
 * TTL so an initial message built against an older SPK still decrypts.
 */
export const SPK_RETAIN = 5;

/**
 * Pure rotation decision. A null stamp (pre-B-3 install) never rotates: the
 * caller backfills `now` so the age clock starts from first sighting — no
 * fleet-wide rotation storm on upgrade.
 */
export function spkRotationDecision(
  createdAt: number | null,
  now: number,
  intervalMs: number = SPK_ROTATION_INTERVAL_MS,
): { rotate: boolean; backfill: boolean } {
  if (createdAt === null) return { rotate: false, backfill: true };
  return { rotate: now - createdAt >= intervalMs, backfill: false };
}

/**
 * Given the freshly-minted SPK keyId, the keyId that falls out of the K-retain
 * window and must be deleted, or null if there is nothing old enough to prune.
 */
export function spkPruneTargetKeyId(nextSpkKeyId: number, retain: number = SPK_RETAIN): number | null {
  const stale = nextSpkKeyId - retain;
  return stale >= 1 ? stale : null;
}
