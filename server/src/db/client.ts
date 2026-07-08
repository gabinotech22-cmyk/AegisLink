/**
 * AegisLink — Database client
 *
 * Selects backend based on DATABASE_URL:
 *   - postgres://...  → PostgreSQL via `pg` (production)
 *   - anything else   → SQLite via node:sqlite (development / default)
 *
 * All exported repo methods are async so callers work identically
 * regardless of which backend is active.
 */

// ── SQLite backend ── (getSqlite / closeSqlite / schema → ./sqlite, M4 split)
import { getSqlite, closeSqlite } from './sqlite';

// ── PostgreSQL backend ── (getPool / closePg / schema → ./pg, M4 split)
import { closePg, initPgSchema } from './pg';

// ── DB init (called once at startup) ─────────────────────────────────────────

let _initialized = false;

export async function initDb(): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  if (USE_PG) {
    await initPgSchema();
  } else {
    getSqlite(); // bootstraps schema synchronously
  }
}

/**
 * Close the active database backend and reset module state.
 *
 * Tests use a per-file in-memory SQLite via the lazy `sqlite` singleton — a
 * native `node:sqlite` handle — and, for Postgres, a pooled connection. Left
 * open, these outlive the Jest test file: a handle accessed after the
 * environment is torn down surfaces as "import after teardown" / `ENOENT
 * 'sqlite'` and cascades into unrelated suites. Registered as a global
 * `afterAll` (see jest.setup.ts) so it runs after each file's own teardown.
 * Idempotent and safe to call when nothing is open.
 */
export async function closeDb(): Promise<void> {
  _initialized = false;
  closeSqlite();
  await closePg();
}

// ── Query dispatch (USE_PG / dbRun / dbAll / dbGet / pgPopOpk → ./driver, M4 split)
import { USE_PG, dbRun, dbAll, dbGet, pgPopOpk } from './driver';

// ── Exported interfaces & repos ───────────────────────────────────────────────

// ── Row types & constants → ./types (M4 split) ──────────────────────────────
export * from './types';
import {
  IdentityRow, MessageRow, PushTokenRow, VoipTokenRow, SignedPreKeyRow, OneTimePreKeyRow,
  PqSignedPreKeyRow, LinkedDeviceRow, RevokedDIDHashRow, LightningInvoiceRow,
  SubscriptionRow, MESSAGE_TTL_MS,
} from './types';

// ── identityRepo ──────────────────────────────────────────────────────────────

export const identityRepo = {
  async get(aegisId: string): Promise<IdentityRow | undefined> {
    return dbGet<IdentityRow>(
      `SELECT aegis_id, public_key_b64, signing_public_key_b64, created_at FROM identities WHERE aegis_id = ?`,
      [aegisId]
    );
  },
  async insert(row: IdentityRow): Promise<void> {
    await dbRun(
      `INSERT INTO identities (aegis_id, public_key_b64, signing_public_key_b64, created_at) VALUES (?, ?, ?, ?)`,
      [row.aegis_id, row.public_key_b64, row.signing_public_key_b64, row.created_at]
    );
  },
  /**
   * B-2: account deletion. Removes every relay-side trace of `aegisId` — the
   * identity row plus all server-held material keyed to it: prekeys (SPK/OPK/PQ),
   * queued inbound messages and group-key distributions (by recipient), push +
   * delivery tokens, and linked-device records. Sealed-sender means the relay
   * never learns who SENT a message, so outbound copies cannot (and need not) be
   * targeted — only the user's own inbound queue and published material.
   *
   * Deletes run sequentially and are idempotent: a partial failure leaves the
   * rest deletable on retry. Work/enterprise membership is intentionally out of
   * scope (separate org-invariant concerns).
   */
  async deleteAccount(aegisId: string): Promise<void> {
    await dbRun(`DELETE FROM messages WHERE recipient = ?`, [aegisId]);
    await dbRun(`DELETE FROM sender_key_dist_queue WHERE recipient = ?`, [aegisId]);
    await dbRun(`DELETE FROM prekeys_onetime WHERE aegis_id = ?`, [aegisId]);
    await dbRun(`DELETE FROM prekeys_signed WHERE aegis_id = ?`, [aegisId]);
    await dbRun(`DELETE FROM prekeys_pq_signed WHERE aegis_id = ?`, [aegisId]);
    await dbRun(`DELETE FROM push_tokens WHERE aegis_id = ?`, [aegisId]);
    await dbRun(`DELETE FROM voip_tokens WHERE aegis_id = ?`, [aegisId]);
    await dbRun(`DELETE FROM delivery_tokens WHERE aegis_id = ?`, [aegisId]);
    await dbRun(`DELETE FROM linked_devices WHERE aegis_id = ?`, [aegisId]);
    await dbRun(`DELETE FROM identities WHERE aegis_id = ?`, [aegisId]);
  },
};

// ── deliveryTokenRepo ─────────────────────────────────────────────────────────

/**
 * Sealed-sender delivery-token store (Phase 1). The relay persists ONLY the
 * hash of a recipient's delivery token; the raw token is shared sender↔recipient
 * over the E2EE X3DH channel and never reaches the relay at rest. A sender
 * presents the raw token to submit a sealed envelope; the relay verifies it
 * against this hash without learning who the sender is.
 * See docs/SEALED-SENDER-ARCHITECTURE.md §3.3.
 */
export const deliveryTokenRepo = {
  /** Register or rotate the recipient's token hash. Upsert keyed by aegisId. */
  async set(aegisId: string, tokenHashB64: string, updatedAt: number): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO delivery_tokens (aegis_id, token_hash_b64, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(aegis_id) DO UPDATE SET token_hash_b64 = EXCLUDED.token_hash_b64, updated_at = EXCLUDED.updated_at`,
        [aegisId, tokenHashB64, updatedAt]
      );
    } else {
      await dbRun(
        `INSERT INTO delivery_tokens (aegis_id, token_hash_b64, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(aegis_id) DO UPDATE SET token_hash_b64 = excluded.token_hash_b64, updated_at = excluded.updated_at`,
        [aegisId, tokenHashB64, updatedAt]
      );
    }
  },
  /** Fetch the stored token hash for a recipient, or undefined if none registered. */
  async getHash(aegisId: string): Promise<string | undefined> {
    const row = await dbGet<{ token_hash_b64: string }>(
      `SELECT token_hash_b64 FROM delivery_tokens WHERE aegis_id = ?`,
      [aegisId]
    );
    return row?.token_hash_b64;
  },
};

// ── messageRepo ───────────────────────────────────────────────────────────────

/**
 * Floor for the per-message drain cap. A queued message is hard-deleted once
 * this many distinct devices have drained it OR the cap derived from the
 * recipient's device count is reached — whichever is higher.
 */
const MIN_DRAIN_CAP = 2;

/**
 * Effective drain cap for a recipient (B-1). Scales to `1 primary + active
 * linked devices` so multi-device users (>2 devices) never lose a queued
 * message before every device pulls it, with `MIN_DRAIN_CAP` as a floor.
 * The cap can only ever rise above the old fixed 2, so this change extends a
 * row's lifetime at worst — it can never cause under-delivery. Overcounting
 * (e.g. if the primary is also tracked in linked_devices) is benign: the row
 * simply lives until its TTL instead of being freed a little earlier.
 */
async function drainCapFor(recipient: string): Promise<number> {
  const linked = await devicesRepo.countActive(recipient);
  return Math.max(MIN_DRAIN_CAP, 1 + linked);
}

/**
 * Parse a `drained_by` TEXT column into a validated `string[]` (M-3). The column
 * is JSON-in-TEXT with no DB-level shape guarantee, so a corrupted or non-array
 * payload must degrade to an empty list rather than throw on the downstream
 * `.includes()` / `.push()`. Non-string array elements are dropped.
 */
export function parseDrainedBy(text: string | null | undefined): string[] {
  if (!text) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === 'string');
}

/** Maximum queued messages per recipient — prevents disk exhaustion attacks. */
export const MAX_QUEUED_PER_RECIPIENT = 500;

export const messageRepo = {
  async enqueue(row: Omit<MessageRow, 'drained_by'>): Promise<{ ok: boolean; reason?: string }> {
    const expiresAt = row.expires_at > 0 ? row.expires_at : row.created_at + MESSAGE_TTL_MS;
    // Enforce per-recipient queue limit before inserting.
    const countRow = await dbGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM messages WHERE recipient = ? AND (expires_at = 0 OR expires_at > ?)`,
      [row.recipient, Date.now()]
    );
    if (countRow && countRow.n >= MAX_QUEUED_PER_RECIPIENT) {
      return { ok: false, reason: 'queue_full' };
    }
    await dbRun(
      `INSERT INTO messages (id, recipient, ciphertext_b64, nonce_b64, created_at, expires_at, drained_by, sender_pub_b64, epk_b64) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [row.id, row.recipient, row.ciphertext_b64, row.nonce_b64, row.created_at, expiresAt, row.sender_pub_b64 ?? null, row.epk_b64 ?? null]
    );
    return { ok: true };
  },

  /**
   * Fetch messages not yet drained by `deviceId` (or all messages when
   * `deviceId` is undefined for backward compatibility).
   */
  async drainFor(recipient: string, deviceId?: string): Promise<MessageRow[]> {
    const now = Date.now();
    const rows = await dbAll<MessageRow>(
      `SELECT id, recipient, ciphertext_b64, nonce_b64, created_at, expires_at, drained_by, sender_pub_b64, epk_b64
       FROM messages WHERE recipient = ? AND (expires_at = 0 OR expires_at > ?)
       ORDER BY created_at ASC`,
      [recipient, now]
    );
    if (!deviceId) return rows;
    return rows.filter((row) => !parseDrainedBy(row.drained_by).includes(deviceId));
  },

  /**
   * Mark a message as drained by `deviceId`. Deletes the row when the recipient's
   * full set of devices has drained it (see drainCapFor) or the caller provides
   * no deviceId (legacy path).
   */
  async delete(id: string, deviceId?: string): Promise<void> {
    if (!deviceId) {
      await dbRun(`DELETE FROM messages WHERE id = ?`, [id]);
      return;
    }
    const row = await dbGet<Pick<MessageRow, 'recipient' | 'drained_by'>>(
      `SELECT recipient, drained_by FROM messages WHERE id = ?`,
      [id]
    );
    if (!row) return;
    const drained = parseDrainedBy(row.drained_by);
    if (!drained.includes(deviceId)) drained.push(deviceId);
    if (drained.length >= await drainCapFor(row.recipient)) {
      await dbRun(`DELETE FROM messages WHERE id = ?`, [id]);
    } else {
      await dbRun(`UPDATE messages SET drained_by = ? WHERE id = ?`, [JSON.stringify(drained), id]);
    }
  },

  async purgeExpired(): Promise<number> {
    const result = await dbRun(`DELETE FROM messages WHERE expires_at > 0 AND expires_at <= ?`, [Date.now()]);
    return result.changes;
  },
};

// ── senderKeyDistRepo ─────────────────────────────────────────────────────────
// Queues sealed SenderKey distributions for offline group members. The relay
// never reads the key material — ciphertextB64 / nonceB64 are opaque blobs
// forwarded verbatim, identical to how messageRepo works. The actual SenderKey
// travels only inside the sealed ciphertextB64; no raw key material is ever
// stored or transited in cleartext (C-3 fix). The only
// routing field the relay inspects is `recipient` (aegisId). `group_id` and
// `sender_aegis_id` travel inside the blob on-wire from the client; they are
// stored here only so the drain path can reconstruct the correct `group:rekey_dist`
// wire payload without reading encrypted content.
//
// Zero-metadata note: storing `sender_aegis_id` here could theoretically reveal
// a sender→recipient edge. We accept this under the same rationale as
// `sender_pub_b64` on init messages in messageRepo (FND-05 exception): without it
// the recipient cannot identify which group the distribution belongs to or verify
// the sender, making the offline re-key useless. The field is purged together with
// the row as soon as all devices drain it.

export interface SenderKeyDistRow {
  id: string;
  recipient: string;
  group_id: string;
  sender_aegis_id: string;
  ciphertext_b64: string;
  nonce_b64: string;
  iteration: number;
  created_at: number;
  expires_at: number;
  /** JSON-serialized string[]. Device IDs that have already drained this distribution. */
  drained_by: string;
}

export const senderKeyDistRepo = {
  async enqueue(row: Omit<SenderKeyDistRow, 'drained_by'>): Promise<{ ok: boolean; reason?: string }> {
    const expiresAt = row.expires_at > 0 ? row.expires_at : row.created_at + MESSAGE_TTL_MS;
    // Enforce per-recipient queue limit — reuses the same constant as messageRepo.
    const countRow = await dbGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM sender_key_dist_queue WHERE recipient = ? AND (expires_at = 0 OR expires_at > ?)`,
      [row.recipient, Date.now()]
    );
    if (countRow && countRow.n >= MAX_QUEUED_PER_RECIPIENT) {
      return { ok: false, reason: 'queue_full' };
    }
    await dbRun(
      `INSERT INTO sender_key_dist_queue
         (id, recipient, group_id, sender_aegis_id, ciphertext_b64, nonce_b64, iteration, created_at, expires_at, drained_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
      [row.id, row.recipient, row.group_id, row.sender_aegis_id,
       row.ciphertext_b64, row.nonce_b64,
       row.iteration, row.created_at, expiresAt]
    );
    return { ok: true };
  },

  /**
   * Fetch distributions not yet drained by `deviceId`.
   * When `deviceId` is undefined (legacy single-device path) all un-expired rows
   * for the recipient are returned — matches the messageRepo behaviour.
   */
  async drainFor(recipient: string, deviceId?: string): Promise<SenderKeyDistRow[]> {
    const now = Date.now();
    const rows = await dbAll<SenderKeyDistRow>(
      `SELECT id, recipient, group_id, sender_aegis_id, ciphertext_b64, nonce_b64, iteration,
              created_at, expires_at, drained_by
       FROM sender_key_dist_queue
       WHERE recipient = ? AND (expires_at = 0 OR expires_at > ?)
       ORDER BY created_at ASC`,
      [recipient, now]
    );
    if (!deviceId) return rows;
    return rows.filter((row) => !parseDrainedBy(row.drained_by).includes(deviceId));
  },

  /**
   * Mark a distribution as drained by `deviceId`. Deletes the row when the
   * recipient's full set of devices has drained it — mirrors messageRepo.delete
   * exactly (shared drainCapFor / parseDrainedBy).
   */
  async delete(id: string, deviceId?: string): Promise<void> {
    if (!deviceId) {
      await dbRun(`DELETE FROM sender_key_dist_queue WHERE id = ?`, [id]);
      return;
    }
    const row = await dbGet<Pick<SenderKeyDistRow, 'recipient' | 'drained_by'>>(
      `SELECT recipient, drained_by FROM sender_key_dist_queue WHERE id = ?`,
      [id]
    );
    if (!row) return;
    const drained = parseDrainedBy(row.drained_by);
    if (!drained.includes(deviceId)) drained.push(deviceId);
    if (drained.length >= await drainCapFor(row.recipient)) {
      await dbRun(`DELETE FROM sender_key_dist_queue WHERE id = ?`, [id]);
    } else {
      await dbRun(`UPDATE sender_key_dist_queue SET drained_by = ? WHERE id = ?`, [JSON.stringify(drained), id]);
    }
  },

  async purgeExpired(): Promise<number> {
    const result = await dbRun(
      `DELETE FROM sender_key_dist_queue WHERE expires_at > 0 AND expires_at <= ?`,
      [Date.now()]
    );
    return result.changes;
  },
};

// ── pushRepo ──────────────────────────────────────────────────────────────────

export const pushRepo = {
  async upsert(row: PushTokenRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO push_tokens (aegis_id, expo_token, platform, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(aegis_id, expo_token) DO UPDATE SET platform = EXCLUDED.platform, updated_at = EXCLUDED.updated_at`,
        [row.aegis_id, row.expo_token, row.platform, row.updated_at]
      );
    } else {
      await dbRun(
        `INSERT INTO push_tokens (aegis_id, expo_token, platform, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(aegis_id, expo_token) DO UPDATE SET platform = excluded.platform, updated_at = excluded.updated_at`,
        [row.aegis_id, row.expo_token, row.platform, row.updated_at]
      );
    }
  },
  async forRecipient(aegisId: string): Promise<PushTokenRow[]> {
    return dbAll<PushTokenRow>(
      `SELECT aegis_id, expo_token, platform, updated_at FROM push_tokens WHERE aegis_id = ?`,
      [aegisId]
    );
  },
  async delete(token: string): Promise<void> {
    await dbRun(`DELETE FROM push_tokens WHERE expo_token = ?`, [token]);
  },
};

// ── voipTokenRepo ─────────────────────────────────────────────────────────────
// iOS VoIP (PushKit) tokens. Written only via the authenticated socket
// (voip:register); read by the APNs VoIP sender (push/apns-voip.ts).

export const voipTokenRepo = {
  async upsert(row: VoipTokenRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO voip_tokens (aegis_id, voip_token, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(aegis_id, voip_token) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [row.aegis_id, row.voip_token, row.updated_at]
      );
    } else {
      await dbRun(
        `INSERT INTO voip_tokens (aegis_id, voip_token, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(aegis_id, voip_token) DO UPDATE SET updated_at = excluded.updated_at`,
        [row.aegis_id, row.voip_token, row.updated_at]
      );
    }
  },
  async forRecipient(aegisId: string): Promise<VoipTokenRow[]> {
    return dbAll<VoipTokenRow>(
      `SELECT aegis_id, voip_token, updated_at FROM voip_tokens WHERE aegis_id = ?`,
      [aegisId]
    );
  },
  async delete(token: string): Promise<void> {
    await dbRun(`DELETE FROM voip_tokens WHERE voip_token = ?`, [token]);
  },
};

// ── prekeysRepo ───────────────────────────────────────────────────────────────

export const prekeysRepo = {
  async upsertSigned(row: SignedPreKeyRow): Promise<void> {
    const deviceId = row.device_id || 'default';
    if (USE_PG) {
      await dbRun(
        `INSERT INTO prekeys_signed (aegis_id, device_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id, device_id) DO UPDATE SET key_id = EXCLUDED.key_id, public_key_b64 = EXCLUDED.public_key_b64, signature_b64 = EXCLUDED.signature_b64, created_at = EXCLUDED.created_at`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
      );
    } else {
      await dbRun(
        `INSERT INTO prekeys_signed (aegis_id, device_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id, device_id) DO UPDATE SET key_id = excluded.key_id, public_key_b64 = excluded.public_key_b64, signature_b64 = excluded.signature_b64, created_at = excluded.created_at`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
      );
    }
  },
  /**
   * PQXDH (v2): upsert the signed PQ prekey (ML-KEM-768). Mirrors upsertSigned's
   * pattern exactly — one row per (aegis_id, device_id), overwritten on rotation.
   * Optional table: absent rows simply mean the device hasn't published one yet
   * (v1-only client), which getBundle/getBundles tolerate by returning `null`.
   */
  async upsertPqSigned(row: PqSignedPreKeyRow): Promise<void> {
    const deviceId = row.device_id || 'default';
    if (USE_PG) {
      await dbRun(
        `INSERT INTO prekeys_pq_signed (aegis_id, device_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id, device_id) DO UPDATE SET key_id = EXCLUDED.key_id, public_key_b64 = EXCLUDED.public_key_b64, signature_b64 = EXCLUDED.signature_b64, created_at = EXCLUDED.created_at`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
      );
    } else {
      await dbRun(
        `INSERT INTO prekeys_pq_signed (aegis_id, device_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id, device_id) DO UPDATE SET key_id = excluded.key_id, public_key_b64 = excluded.public_key_b64, signature_b64 = excluded.signature_b64, created_at = excluded.created_at`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
      );
    }
  },
  async insertOneTime(row: OneTimePreKeyRow): Promise<void> {
    const deviceId = row.device_id || 'default';
    if (USE_PG) {
      await dbRun(
        `INSERT INTO prekeys_onetime (aegis_id, device_id, key_id, public_key_b64, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id, device_id, key_id) DO NOTHING`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.created_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO prekeys_onetime (aegis_id, device_id, key_id, public_key_b64, created_at) VALUES (?, ?, ?, ?, ?)`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.created_at]
      );
    }
  },
  /** Count remaining OPKs for a specific device (per-device pool, M-2). */
  async countOneTime(aegisId: string, deviceId = 'default'): Promise<number> {
    const row = await dbGet<{ count: string | number }>(
      `SELECT COUNT(*) as count FROM prekeys_onetime WHERE aegis_id = ? AND device_id = ?`,
      [aegisId, deviceId]
    );
    return row ? Number(row.count) : 0;
  },
  async getBundle(aegisId: string): Promise<{
    signingPublicKeyB64: string;
    signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
    oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
    pqSignedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string } | null;
  } | null> {
    const bundles = await this.getBundles(aegisId);
    return bundles.length > 0 ? bundles[0] : null;
  },

  /**
   * Fetch an X3DH prekey bundle per device registered under `aegisId`.
   * Each bundle includes a `device_id` field so the caller can address
   * messages to specific devices (multi-device X3DH).
   *
   * One-time prekeys are consumed atomically — one OPK per device per call.
   */
  async getBundles(aegisId: string): Promise<Array<{
    device_id: string;
    signingPublicKeyB64: string;
    signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
    oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
    pqSignedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string } | null;
  }>> {
    const spkRows = await dbAll<{ device_id: string; key_id: number; public_key_b64: string; signature_b64: string }>(
      `SELECT device_id, key_id, public_key_b64, signature_b64 FROM prekeys_signed WHERE aegis_id = ?`,
      [aegisId]
    );
    if (spkRows.length === 0) return [];

    const identity = await dbGet<{ signing_public_key_b64: string }>(
      `SELECT signing_public_key_b64 FROM identities WHERE aegis_id = ?`,
      [aegisId]
    );
    const signingPublicKeyB64 = identity?.signing_public_key_b64 ?? '';
    if (signingPublicKeyB64 === '') return [];

    // PQXDH (v2): fetch per-device PQ signed prekeys in one query, keyed by
    // device_id, so the per-device loop below can attach them (or `null` for
    // v1-only devices) without an extra query per device.
    const pqRows = await dbAll<{ device_id: string; key_id: number; public_key_b64: string; signature_b64: string }>(
      `SELECT device_id, key_id, public_key_b64, signature_b64 FROM prekeys_pq_signed WHERE aegis_id = ?`,
      [aegisId]
    );
    const pqByDevice = new Map<string, { keyId: number; publicKeyB64: string; signatureB64: string }>();
    for (const pq of pqRows) {
      pqByDevice.set(pq.device_id, { keyId: pq.key_id, publicKeyB64: pq.public_key_b64, signatureB64: pq.signature_b64 });
    }

    const result: Array<{
      device_id: string;
      signingPublicKeyB64: string;
      signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
      oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
      pqSignedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string } | null;
    }> = [];

    for (const spk of spkRows) {
      // Pop one OPK for THIS device atomically (M-2: per-device pool — an OPK
      // from another device would carry a secret this device doesn't hold).
      let opk: { key_id: number; public_key_b64: string } | undefined;
      if (USE_PG) {
        opk = await pgPopOpk(aegisId, spk.device_id);
      } else {
        const db = getSqlite()!;
        const found = db.prepare(
          `SELECT key_id, public_key_b64 FROM prekeys_onetime WHERE aegis_id = ? AND device_id = ? ORDER BY key_id ASC LIMIT 1`
        ).get(aegisId, spk.device_id) as { key_id: number; public_key_b64: string } | undefined;
        if (found) {
          db.prepare(`DELETE FROM prekeys_onetime WHERE aegis_id = ? AND device_id = ? AND key_id = ?`).run(aegisId, spk.device_id, found.key_id);
          opk = found;
        }
      }

      result.push({
        device_id: spk.device_id,
        pqSignedPreKey: pqByDevice.get(spk.device_id) ?? null,
        signingPublicKeyB64,
        signedPreKey: {
          keyId: spk.key_id,
          publicKeyB64: spk.public_key_b64,
          signatureB64: spk.signature_b64,
        },
        oneTimePreKey: opk ? { keyId: opk.key_id, publicKeyB64: opk.public_key_b64 } : null,
      });
    }

    return result;
  },
};

// ── devicesRepo ───────────────────────────────────────────────────────────────

export const devicesRepo = {
  async upsert(row: Omit<LinkedDeviceRow, 'revoked'>): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO linked_devices (device_id, aegis_id, device_pub_key, device_name, platform, linked_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(device_id) DO UPDATE SET linked_at = EXCLUDED.linked_at, revoked = 0`,
        [row.device_id, row.aegis_id, row.device_pub_key, row.device_name, row.platform, row.linked_at]
      );
    } else {
      await dbRun(
        `INSERT INTO linked_devices (device_id, aegis_id, device_pub_key, device_name, platform, linked_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(device_id) DO UPDATE SET linked_at = excluded.linked_at, revoked = 0`,
        [row.device_id, row.aegis_id, row.device_pub_key, row.device_name, row.platform, row.linked_at]
      );
    }
  },
  async listActive(aegisId: string): Promise<LinkedDeviceRow[]> {
    return dbAll<LinkedDeviceRow>(
      `SELECT device_id, aegis_id, device_pub_key, device_name, platform, linked_at, revoked
       FROM linked_devices WHERE aegis_id = ? AND revoked = 0`,
      [aegisId]
    );
  },
  /** Count of active (non-revoked) linked devices — used to size the drain cap (B-1). */
  async countActive(aegisId: string): Promise<number> {
    const row = await dbGet<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM linked_devices WHERE aegis_id = ? AND revoked = 0`,
      [aegisId]
    );
    return row ? Number(row.n) : 0;
  },
  async revoke(deviceId: string, aegisId: string): Promise<boolean> {
    const result = await dbRun(
      `UPDATE linked_devices SET revoked = 1 WHERE device_id = ? AND aegis_id = ?`,
      [deviceId, aegisId]
    );
    return result.changes > 0;
  },
  async isRevoked(deviceId: string): Promise<boolean> {
    const row = await dbGet<{ revoked: number }>(
      `SELECT revoked FROM linked_devices WHERE device_id = ? LIMIT 1`,
      [deviceId]
    );
    return row !== undefined && row.revoked === 1;
  },
};

// ── web3Repo ──────────────────────────────────────────────────────────────────

export const web3Repo = {
  async insertRevocation(row: RevokedDIDHashRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO revoked_did_hashes (did_hash, revoked_at, signature_b64, signing_pub_key) VALUES (?, ?, ?, ?)
         ON CONFLICT(did_hash) DO NOTHING`,
        [row.did_hash, row.revoked_at, row.signature_b64, row.signing_pub_key]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO revoked_did_hashes (did_hash, revoked_at, signature_b64, signing_pub_key) VALUES (?, ?, ?, ?)`,
        [row.did_hash, row.revoked_at, row.signature_b64, row.signing_pub_key]
      );
    }
  },
  async isRevoked(didHash: string): Promise<boolean> {
    const row = await dbGet<{ did_hash: string }>(
      `SELECT did_hash FROM revoked_did_hashes WHERE did_hash = ? LIMIT 1`,
      [didHash]
    );
    return row !== undefined;
  },
  async insertInvoice(row: Omit<LightningInvoiceRow, 'paid'>): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO lightning_invoices (payment_hash, bolt11, amount_sats, plan_days, created_at, expires_at, paid) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(payment_hash) DO NOTHING`,
        [row.payment_hash, row.bolt11, row.amount_sats, row.plan_days, row.created_at, row.expires_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO lightning_invoices (payment_hash, bolt11, amount_sats, plan_days, created_at, expires_at, paid) VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [row.payment_hash, row.bolt11, row.amount_sats, row.plan_days, row.created_at, row.expires_at]
      );
    }
  },
  async getInvoice(paymentHash: string): Promise<LightningInvoiceRow | undefined> {
    return dbGet<LightningInvoiceRow>(
      `SELECT payment_hash, bolt11, amount_sats, plan_days, created_at, expires_at, paid FROM lightning_invoices WHERE payment_hash = ?`,
      [paymentHash]
    );
  },
  async markInvoicePaid(paymentHash: string): Promise<void> {
    await dbRun(`UPDATE lightning_invoices SET paid = 1 WHERE payment_hash = ?`, [paymentHash]);
  },
  async insertSubscription(row: SubscriptionRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO subscriptions (payment_hash, plan_days, activated_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(payment_hash) DO UPDATE SET plan_days = EXCLUDED.plan_days, activated_at = EXCLUDED.activated_at, expires_at = EXCLUDED.expires_at`,
        [row.payment_hash, row.plan_days, row.activated_at, row.expires_at]
      );
    } else {
      await dbRun(
        `INSERT OR REPLACE INTO subscriptions (payment_hash, plan_days, activated_at, expires_at) VALUES (?, ?, ?, ?)`,
        [row.payment_hash, row.plan_days, row.activated_at, row.expires_at]
      );
    }
  },
  async getSubscription(paymentHash: string): Promise<SubscriptionRow | undefined> {
    return dbGet<SubscriptionRow>(
      `SELECT payment_hash, plan_days, activated_at, expires_at FROM subscriptions WHERE payment_hash = ?`,
      [paymentHash]
    );
  },
};

// NOTE: the server-side poll repo (`pollsRepo`) and the `/polls` HTTP endpoint
// were REMOVED in the 2026-06 audit (A-8). Poll votes travel exclusively inside
// E2EE group messages (`[vote:...]`) and are tallied client-side, so the relay
// never sees a vote. The old HTTP path was unused by every client, was
// ballot-stuffable (client-supplied voterHash) and leaked vote metadata to the
// server — removing it is the zero-metadata-correct fix. The `poll_votes` table
// DDL is likewise gone; any pre-existing empty table is harmless.

// ── Work repos → ./repos/work (M4 split) ─────────────────────────────────────
export * from './repos/work';
// ── backupRepo ────────────────────────────────────────────────────────────────
// Stores one encrypted backup blob per user.
// The key is SHA-256(aegisId) so the aegisId itself never appears in the DB row.
// The envelope column is the raw JSON string of the BackupEnvelope — opaque to
// the server (server never parses its fields beyond treating it as text).

export interface BackupRow {
  id_hash: string;
  envelope: string;
  updated_at: number;
}

export const backupRepo = {
  async upsert(idHash: string, envelope: string): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO backups (id_hash, envelope, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id_hash) DO UPDATE SET envelope = EXCLUDED.envelope, updated_at = EXCLUDED.updated_at`,
        [idHash, envelope, Date.now()]
      );
    } else {
      await dbRun(
        `INSERT INTO backups (id_hash, envelope, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id_hash) DO UPDATE SET envelope = excluded.envelope, updated_at = excluded.updated_at`,
        [idHash, envelope, Date.now()]
      );
    }
  },
  async get(idHash: string): Promise<BackupRow | undefined> {
    return dbGet<BackupRow>(
      `SELECT id_hash, envelope, updated_at FROM backups WHERE id_hash = ?`,
      [idHash]
    );
  },
  async delete(idHash: string): Promise<boolean> {
    const result = await dbRun(`DELETE FROM backups WHERE id_hash = ?`, [idHash]);
    return result.changes > 0;
  },
};

// ── Public Channel repos (Phase 1, docs/SEALED-PUBLIC-CHANNELS.md) ──────────

export interface PublicChannelRow {
  channel_id: string;
  signed_manifest_blob: string;
  delivery_token_hash_b64: string;
  channel_type: string;
  /** Wrapped CEK (JSON {ivB64,wrappedB64}) a joiner unwraps with the capability; '' if none. */
  content_key_envelope: string;
  created_at: number;
  /** Blob store ID of the channel's public avatar (Slice 2). Null when no avatar is set. */
  avatar_blob_id: string | null;
}

export interface PublicChannelPostRow {
  id: string;
  channel_id: string;
  seq_num: number;
  ciphertext_b64: string;
  nonce_b64: string;
  post_hash_b64: string;
  created_at: number;
  expires_at: number;
}

export interface PublicChannelPendingJoinRow {
  join_pubkey_b64: string;
  channel_id: string;
  created_at: number;
  expires_at: number;
  /** Phase 4: owner-sealed capability envelope (opaque). Null until approved. */
  approval_envelope?: string | null;
}

/** Maximum pending join requests per channel (approval-gated). */
const MAX_PENDING_JOINS_PER_CHANNEL = 256;
/** Pending join TTL: 24 hours in ms. */
const PENDING_JOIN_TTL_MS = 24 * 60 * 60 * 1000;

export const publicChannelRepo = {
  async create(row: PublicChannelRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO public_channels (channel_id, signed_manifest_blob, delivery_token_hash_b64, channel_type, content_key_envelope, created_at, avatar_blob_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO NOTHING`,
        [row.channel_id, row.signed_manifest_blob, row.delivery_token_hash_b64, row.channel_type, row.content_key_envelope, row.created_at, row.avatar_blob_id ?? null]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO public_channels (channel_id, signed_manifest_blob, delivery_token_hash_b64, channel_type, content_key_envelope, created_at, avatar_blob_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.channel_id, row.signed_manifest_blob, row.delivery_token_hash_b64, row.channel_type, row.content_key_envelope, row.created_at, row.avatar_blob_id ?? null]
      );
    }
  },

  async get(channelId: string): Promise<PublicChannelRow | undefined> {
    return dbGet<PublicChannelRow>(
      `SELECT channel_id, signed_manifest_blob, delivery_token_hash_b64, channel_type, content_key_envelope, created_at, avatar_blob_id FROM public_channels WHERE channel_id = ?`,
      [channelId]
    );
  },

  async list(): Promise<PublicChannelRow[]> {
    return dbAll<PublicChannelRow>(
      `SELECT channel_id, signed_manifest_blob, delivery_token_hash_b64, channel_type, content_key_envelope, created_at, avatar_blob_id FROM public_channels ORDER BY created_at DESC`
    );
  },

  async updateManifest(channelId: string, signedManifestBlob: string, channelType?: string): Promise<boolean> {
    const result = channelType !== undefined
      ? await dbRun(
          `UPDATE public_channels SET signed_manifest_blob = ?, channel_type = ? WHERE channel_id = ?`,
          [signedManifestBlob, channelType, channelId]
        )
      : await dbRun(
          `UPDATE public_channels SET signed_manifest_blob = ? WHERE channel_id = ?`,
          [signedManifestBlob, channelId]
        );
    return result.changes > 0;
  },

  async setDeliveryTokenHash(channelId: string, tokenHashB64: string): Promise<boolean> {
    const result = await dbRun(
      `UPDATE public_channels SET delivery_token_hash_b64 = ? WHERE channel_id = ?`,
      [tokenHashB64, channelId]
    );
    return result.changes > 0;
  },

  /** Slice 2 — associate a blob store avatar with a channel. Null clears it. */
  async setAvatarBlobId(channelId: string, blobId: string | null): Promise<boolean> {
    const result = await dbRun(
      `UPDATE public_channels SET avatar_blob_id = ? WHERE channel_id = ?`,
      [blobId, channelId]
    );
    return result.changes > 0;
  },

  /**
   * Slice 2 — return the set of all blob IDs currently referenced as channel
   * avatars. Used by the blob store TTL cleanup to exempt pinned avatars from
   * deletion. The set is small (one entry per channel with an avatar) so
   * fetching all rows is fine.
   */
  async listPinnedAvatarBlobIds(): Promise<Set<string>> {
    const rows = await dbAll<{ avatar_blob_id: string }>(
      `SELECT avatar_blob_id FROM public_channels WHERE avatar_blob_id IS NOT NULL`,
    );
    return new Set(rows.map((r) => r.avatar_blob_id));
  },

  /** Slice 2 — read the avatar blob ID for a channel. */
  async getAvatarBlobId(channelId: string): Promise<string | null> {
    const row = await dbGet<{ avatar_blob_id: string | null }>(
      `SELECT avatar_blob_id FROM public_channels WHERE channel_id = ?`,
      [channelId]
    );
    return row?.avatar_blob_id ?? null;
  },

  async delete(channelId: string): Promise<boolean> {
    // Also delete associated posts and pending joins
    await dbRun(`DELETE FROM public_channel_posts WHERE channel_id = ?`, [channelId]);
    await dbRun(`DELETE FROM public_channel_pending_joins WHERE channel_id = ?`, [channelId]);
    const result = await dbRun(`DELETE FROM public_channels WHERE channel_id = ?`, [channelId]);
    return result.changes > 0;
  },
};

export const publicChannelPostRepo = {
  async append(row: PublicChannelPostRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO public_channel_posts (id, channel_id, seq_num, ciphertext_b64, nonce_b64, post_hash_b64, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [row.id, row.channel_id, row.seq_num, row.ciphertext_b64, row.nonce_b64, row.post_hash_b64, row.created_at, row.expires_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO public_channel_posts (id, channel_id, seq_num, ciphertext_b64, nonce_b64, post_hash_b64, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.channel_id, row.seq_num, row.ciphertext_b64, row.nonce_b64, row.post_hash_b64, row.created_at, row.expires_at]
      );
    }
  },

  async listSince(channelId: string, sinceSeqNum: number, limit = 100): Promise<PublicChannelPostRow[]> {
    return dbAll<PublicChannelPostRow>(
      `SELECT id, channel_id, seq_num, ciphertext_b64, nonce_b64, post_hash_b64, created_at, expires_at
       FROM public_channel_posts
       WHERE channel_id = ? AND seq_num > ?
       ORDER BY seq_num ASC LIMIT ?`,
      [channelId, sinceSeqNum, limit]
    );
  },

  async deleteBySeq(channelId: string, seqNum: number): Promise<boolean> {
    const result = await dbRun(
      `DELETE FROM public_channel_posts WHERE channel_id = ? AND seq_num = ?`,
      [channelId, seqNum]
    );
    return result.changes > 0;
  },

  async highestSeq(channelId: string): Promise<number> {
    const row = await dbGet<{ max_seq: number | null }>(
      `SELECT MAX(seq_num) AS max_seq FROM public_channel_posts WHERE channel_id = ?`,
      [channelId]
    );
    return row?.max_seq ?? -1;
  },
};

export const publicChannelJoinRepo = {
  async enqueue(joinPubkeyB64: string, channelId: string): Promise<{ ok: boolean; reason?: string }> {
    // Check cap
    const countRow = await dbGet<{ n: number }>(
      `SELECT COUNT(*) AS n FROM public_channel_pending_joins WHERE channel_id = ?`,
      [channelId]
    );
    if (countRow && Number(countRow.n) >= MAX_PENDING_JOINS_PER_CHANNEL) {
      return { ok: false, reason: 'pending_cap_reached' };
    }
    const now = Date.now();
    if (USE_PG) {
      await dbRun(
        `INSERT INTO public_channel_pending_joins (join_pubkey_b64, channel_id, created_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(join_pubkey_b64, channel_id) DO NOTHING`,
        [joinPubkeyB64, channelId, now, now + PENDING_JOIN_TTL_MS]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO public_channel_pending_joins (join_pubkey_b64, channel_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        [joinPubkeyB64, channelId, now, now + PENDING_JOIN_TTL_MS]
      );
    }
    return { ok: true };
  },

  async listForChannel(channelId: string): Promise<PublicChannelPendingJoinRow[]> {
    return dbAll<PublicChannelPendingJoinRow>(
      `SELECT join_pubkey_b64, channel_id, created_at, expires_at, approval_envelope
       FROM public_channel_pending_joins
       WHERE channel_id = ? AND expires_at > ?
       ORDER BY created_at ASC`,
      [channelId, Date.now()]
    );
  },

  async remove(joinPubkeyB64: string, channelId: string): Promise<boolean> {
    const result = await dbRun(
      `DELETE FROM public_channel_pending_joins WHERE join_pubkey_b64 = ? AND channel_id = ?`,
      [joinPubkeyB64, channelId]
    );
    return result.changes > 0;
  },

  /** Phase 4: attach the owner-sealed capability envelope to a pending join. */
  async setApprovalEnvelope(joinPubkeyB64: string, channelId: string, envelope: string): Promise<boolean> {
    const result = await dbRun(
      `UPDATE public_channel_pending_joins SET approval_envelope = ? WHERE join_pubkey_b64 = ? AND channel_id = ?`,
      [envelope, joinPubkeyB64, channelId]
    );
    return result.changes > 0;
  },

  /** Phase 4: one pending row (applicant poll). */
  async get(joinPubkeyB64: string, channelId: string): Promise<(PublicChannelPendingJoinRow & { approval_envelope?: string | null }) | undefined> {
    return dbGet<PublicChannelPendingJoinRow & { approval_envelope?: string | null }>(
      `SELECT join_pubkey_b64, channel_id, created_at, expires_at, approval_envelope
       FROM public_channel_pending_joins
       WHERE join_pubkey_b64 = ? AND channel_id = ? AND expires_at > ?`,
      [joinPubkeyB64, channelId, Date.now()]
    );
  },

  async pruneExpired(): Promise<number> {
    const result = await dbRun(
      `DELETE FROM public_channel_pending_joins WHERE expires_at > 0 AND expires_at <= ?`,
      [Date.now()]
    );
    return result.changes;
  },
};
