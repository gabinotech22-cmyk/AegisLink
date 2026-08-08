/**
 * Per-session guard against opening the same sealed envelope twice.
 *
 * The relay hands the SAME queued row to more than one delivery path on purpose:
 * the aegisId fallback queues a second copy when a mailbox ack is only `queued`
 * (see the send path in client.ts), the mailbox socket and the stateless drain
 * both read the same queue, and a row survives until a device acks it. So the
 * same envelope legitimately arrives twice — and once the two mailbox paths run
 * concurrently, routinely.
 *
 * The local dedupe (`INSERT OR REPLACE` in db/messages.ts) only runs AFTER
 * decryption, which is too late to help: the first pass consumes the ratchet
 * message key, so the second pass fails to decrypt and drags the session into
 * desync recovery over a message we already hold.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * In memory only, never persisted. The ids are relay-side random identifiers
 * that reveal nothing about sender, recipient or content, and they die with the
 * process — nothing new lands at rest (zero-metadata rule #10).
 *
 * ── At-least-once ───────────────────────────────────────────────────────────
 * An id is recorded only AFTER the message is durably persisted. A delivery that
 * throws is never recorded, so the relay's re-drain is processed normally rather
 * than silently swallowed.
 */

/**
 * How many recent envelope ids to remember. Comfortably larger than any single
 * drain (the relay caps a recipient's queue at 500) so a full backlog cannot
 * evict its own head mid-drain, while staying trivially small in memory.
 */
export const RECENT_ENVELOPE_CAP = 512;

const recentEnvelopeIds = new Set<string>();

/** True when this exact envelope has already been opened AND persisted. */
export function isEnvelopeAlreadyPersisted(id: string): boolean {
  return id.length > 0 && recentEnvelopeIds.has(id);
}

/**
 * Record an envelope as durably persisted. Call ONLY after the message is
 * committed — recording it earlier would suppress a legitimate retry.
 */
export function markEnvelopePersisted(id: string): void {
  if (!id) return;
  // Re-inserting an existing key does not refresh its position in a Set, so a
  // duplicate never disturbs the FIFO eviction order.
  if (recentEnvelopeIds.has(id)) return;
  recentEnvelopeIds.add(id);
  if (recentEnvelopeIds.size > RECENT_ENVELOPE_CAP) {
    // Set iteration order is insertion order, so the first entry is the oldest.
    const oldest = recentEnvelopeIds.values().next().value;
    if (oldest !== undefined) recentEnvelopeIds.delete(oldest);
  }
}

/**
 * Drop all remembered ids. Test helper only — deliberately NOT wired into
 * disconnect()/logout: disconnect also fires on an ordinary transport change
 * (e.g. toggling the Tor preference), and clearing there would re-admit exactly
 * the duplicate this guard exists to stop. The set dies with the process, which
 * is the only lifetime that matters for a same-session race.
 */
export function resetEnvelopeDedupe(): void {
  recentEnvelopeIds.clear();
}
