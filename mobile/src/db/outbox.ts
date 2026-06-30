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
};

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
  };
}

export async function enqueueOutboxJob(job: Omit<OutboxJob, 'attempts'>): Promise<void> {
  return withDb(async (d) => {
    const encryptedPayload = await encryptBody(job.payload);
    await d.runAsync(
      `INSERT OR REPLACE INTO outbox
         (job_id, msg_id, recipient_aegis_id, recipient_pubkey_b64, payload, kind, group_id, created_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
      `SELECT job_id, msg_id, recipient_aegis_id, recipient_pubkey_b64, payload, kind, group_id, created_at, attempts
       FROM outbox ORDER BY created_at ASC`,
    );
    return Promise.all(rows.map(rowToOutboxJob));
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

export async function countOutboxJobs(): Promise<number> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    return row?.n ?? 0;
  });
}
