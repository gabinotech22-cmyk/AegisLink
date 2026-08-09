// ─── Persistent Outbox (Signal-style reliable delivery) ───────────────────────
//
// The outbox holds one job per (message, recipient) pair. The payload is the
// plaintext JSON object that will be ratchet-encrypted at drain time — we NEVER
// persist a pre-encrypted envelope so the Double Ratchet always advances
// monotonically. The payload is stored encrypted at rest via encryptBody
// (same key as message bodies) so plaintext never lands on disk unprotected.
//
// FIFO drain order is preserved by loading jobs sorted by created_at ASC and
// draining them in series (await each before the next).
//
// Retry scheduling lives in `next_attempt_at` (epoch ms): a failed job is parked
// until then, so a drain triggered by any source (reconnect, timer, foreground)
// skips jobs that are still backing off instead of hammering them. Durable on
// purpose — a backoff that resets on every app restart is not a backoff.
// See ./outboxBackoff for the schedule itself.

import { withDb, encryptBody, decryptBody } from './core';

export interface OutboxJob {
  jobId: string;
  msgId: string;
  recipientAegisId: string;
  recipientPubkeyB64: string;
  /** Decrypted payload JSON string — ratchet-encrypt this at drain time. */
  payload: string;
  kind: 'direct' | 'group';
  groupId: string | null;
  createdAt: number;
  attempts: number;
  /** Epoch ms before which this job must not be retried (0 = due now). */
  nextAttemptAt: number;
}

type OutboxRow = {
  job_id: string;
  msg_id: string;
  recipient_aegis_id: string;
  recipient_pubkey_b64: string;
  payload: string; // encrypted at rest
  kind: string;
  group_id: string | null;
  created_at: number;
  attempts: number;
  next_attempt_at: number | null;
};

/** Column list shared by every SELECT so a schema change touches one place. */
const OUTBOX_COLUMNS =
  'job_id, msg_id, recipient_aegis_id, recipient_pubkey_b64, payload, kind, group_id, created_at, attempts, next_attempt_at';

async function rowToOutboxJob(r: OutboxRow): Promise<OutboxJob> {
  return {
    jobId: r.job_id,
    msgId: r.msg_id,
    recipientAegisId: r.recipient_aegis_id,
    recipientPubkeyB64: r.recipient_pubkey_b64,
    payload: await decryptBody(r.payload),
    kind: r.kind as 'direct' | 'group',
    groupId: r.group_id,
    createdAt: r.created_at,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at ?? 0,
  };
}

export async function enqueueOutboxJob(job: Omit<OutboxJob, 'attempts' | 'nextAttemptAt'>): Promise<void> {
  return withDb(async (d) => {
    const encryptedPayload = await encryptBody(job.payload);
    await d.runAsync(
      `INSERT OR REPLACE INTO outbox
         (job_id, msg_id, recipient_aegis_id, recipient_pubkey_b64, payload, kind, group_id, created_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      job.jobId,
      job.msgId,
      job.recipientAegisId,
      job.recipientPubkeyB64,
      encryptedPayload,
      job.kind,
      job.groupId ?? null,
      job.createdAt,
    );
  });
}

export async function loadOutboxJobs(): Promise<OutboxJob[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox ORDER BY created_at ASC`,
    );
    return Promise.all(rows.map(rowToOutboxJob));
  });
}

/**
 * Jobs whose backoff has elapsed, FIFO. This is what a drain should use: a job
 * still inside its backoff window is skipped rather than retried, so a drain
 * triggered every few seconds cannot turn into a hot loop against the relay.
 */
export async function loadDueOutboxJobs(now: number): Promise<OutboxJob[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox
       WHERE next_attempt_at <= ? ORDER BY created_at ASC`,
      now,
    );
    return Promise.all(rows.map(rowToOutboxJob));
  });
}

/**
 * Epoch ms of the earliest job still waiting on its backoff, or null when the
 * outbox is empty. Lets the scheduler sleep exactly until there is work instead
 * of polling blindly.
 */
export async function nextOutboxDueAt(): Promise<number | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ due: number | null }>(
      'SELECT MIN(next_attempt_at) AS due FROM outbox',
    );
    return row?.due ?? null;
  });
}

export async function deleteOutboxJob(jobId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM outbox WHERE job_id = ?', jobId);
  });
}

export async function incrementOutboxAttempts(jobId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE outbox SET attempts = attempts + 1 WHERE job_id = ?', jobId);
  });
}

/**
 * Record a failed attempt AND park the job until `nextAttemptAt`. Atomic in one
 * statement so a crash between the two can never leave a job with a bumped
 * attempt count but no backoff (which would retry it immediately, forever).
 */
export async function markOutboxAttemptFailed(jobId: string, nextAttemptAt: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      'UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE job_id = ?',
      nextAttemptAt,
      jobId,
    );
  });
}

export async function countOutboxJobs(): Promise<number> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    return row?.n ?? 0;
  });
}
