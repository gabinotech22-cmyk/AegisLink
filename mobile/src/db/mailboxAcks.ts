import { withDb, encryptBody, decryptBody } from './core';

/**
 * Durable pending-ack store for the stateless mailbox drain over Tor
 * (mailboxSocket.fetchMailboxOverTor).
 *
 * The stateless drain is at-least-once: it acks the envelope ids it persisted on
 * the NEXT fetch, so the relay never deletes a queued row before we've stored it.
 * That pending-ack list used to live only in an in-memory Map — if iOS killed the
 * backgrounded app between "persist envelopes" and "next fetch", the acks were
 * lost and the relay redelivered those rows on every later wake (bounded, but the
 * queue grew under a never-foreground + steady-inbound pattern). Persisting the
 * list here makes it survive process death.
 *
 * Envelope ids are opaque but still metadata, so we store them encrypted at rest
 * (encryptBody → only ciphertext on disk, zero-metadata, golden rule #10).
 *
 * Every function is FAIL-SOFT: a DB hiccup must never break the drain, so writes
 * swallow errors and the read returns [] on any failure. The drain then behaves
 * as it did before this store existed (in-memory cache only) rather than throwing.
 */

interface AckRow {
  ack_ids: string;
}

/** Persist (replace) the pending-ack id list for a mailbox. Fail-soft (no throw). */
export async function saveMailboxPendingAcks(mailboxId: string, ackIds: string[]): Promise<void> {
  if (!ackIds.length) return deleteMailboxPendingAcks(mailboxId);
  try {
    const enc = await encryptBody(JSON.stringify(ackIds));
    await withDb(async (d) => {
      await d.runAsync(
        'INSERT OR REPLACE INTO mailbox_pending_acks (mailbox_id, ack_ids, updated_at) VALUES (?, ?, ?)',
        mailboxId, enc, Date.now(),
      );
    });
  } catch {
    // Durability is best-effort: on a DB error the in-memory cache still carries
    // the acks for this session, and the bounded re-drain remains the fallback.
  }
}

/** Load the persisted pending-ack id list for a mailbox, or [] if none/corrupt. */
export async function loadMailboxPendingAcks(mailboxId: string): Promise<string[]> {
  try {
    const row = await withDb(async (d) =>
      d.getFirstAsync<AckRow>('SELECT ack_ids FROM mailbox_pending_acks WHERE mailbox_id = ?', mailboxId),
    );
    if (!row?.ack_ids) return [];
    const json = await decryptBody(row.ack_ids);
    if (!json || json === '[DECRYPTION_ERROR]') return [];
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Drop a mailbox's persisted pending acks (after the relay honored them). Fail-soft. */
export async function deleteMailboxPendingAcks(mailboxId: string): Promise<void> {
  try {
    await withDb(async (d) => {
      await d.runAsync('DELETE FROM mailbox_pending_acks WHERE mailbox_id = ?', mailboxId);
    });
  } catch {
    // Non-fatal: a stale row only causes a harmless re-ack of already-deleted ids
    // (the relay ignores unknown ids) on the next drain.
  }
}
