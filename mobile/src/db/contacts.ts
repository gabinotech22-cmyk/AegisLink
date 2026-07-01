import { withDb } from './core';

export interface StoredContact {
  aegisId: string;
  publicKeyB64: string;
  name: string;
  verified: boolean;
  addedAt: number;
  signingPublicKeyB64?: string;
  color?: string;
  avatarImage?: string | null;
  muted?: boolean;
  mutedUntil?: number | null; // 0 = forever, epoch ms = until, null = not muted
  zeroTrust?: boolean;
  status?: string;
  blocked?: boolean;
  archived?: boolean;
  profile?: 'personal' | 'work';
  lastSeenAt?: number;
  online?: boolean;
  pinned?: boolean;
  /** Chat removed from the list but contact kept; reappears on next message. */
  hidden?: boolean;
  /** Auto-added from an unknown incoming sender; awaiting accept/block/delete. */
  pending?: boolean;
}

type ContactRow = {
  aegis_id: string;
  public_key_b64: string;
  signing_public_key_b64: string | null;
  name: string;
  verified: number;
  added_at: number;
  color: string | null;
  avatar_image: string | null;
  muted: number;
  zero_trust: number;
  status: string | null;
  muted_until: number | null;
  blocked: number;
  archived: number;
  profile: string;
  pinned: number;
  last_seen_at: number | null;
  online: number;
  hidden: number;
  pending: number;
};

function rowToContact(r: ContactRow): StoredContact {
  return {
    aegisId: r.aegis_id,
    publicKeyB64: r.public_key_b64,
    signingPublicKeyB64: r.signing_public_key_b64 || undefined,
    name: r.name,
    verified: r.verified === 1,
    addedAt: r.added_at,
    color: r.color || undefined,
    avatarImage: r.avatar_image || null,
    muted: r.muted === 1,
    mutedUntil: r.muted_until ?? null,
    zeroTrust: r.zero_trust === 1,
    status: r.status ?? undefined,
    blocked: r.blocked === 1,
    archived: r.archived === 1,
    profile: (r.profile === 'work' ? 'work' : 'personal') as 'personal' | 'work',
    pinned: r.pinned === 1,
    lastSeenAt: r.last_seen_at ?? undefined,
    online: r.online === 1,
    hidden: r.hidden === 1,
    pending: r.pending === 1,
  };
}

export async function saveContact(c: StoredContact): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO contacts
       (aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.aegisId,
      c.publicKeyB64,
      c.signingPublicKeyB64 || "",
      c.name,
      c.verified ? 1 : 0,
      c.addedAt,
      c.color || null,
      c.avatarImage || null,
      c.muted ? 1 : 0,
      c.zeroTrust ? 1 : 0,
      c.status ?? null,
      c.mutedUntil ?? null,
      c.blocked ? 1 : 0,
      c.archived ? 1 : 0,
      c.profile ?? 'personal',
      c.pinned ? 1 : 0,
      c.lastSeenAt ?? null,
      c.online ? 1 : 0,
      c.hidden ? 1 : 0,
      c.pending ? 1 : 0
    );
  });
}

export async function pinContact(aegisId: string, pinned: boolean): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE contacts SET pinned = ? WHERE aegis_id = ?', pinned ? 1 : 0, aegisId);
  });
}

export async function loadContacts(profile?: 'personal' | 'work'): Promise<StoredContact[]> {
  return withDb(async (d) => {
    const rows = profile
      ? await d.getAllAsync<ContactRow>(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending FROM contacts WHERE profile = ? ORDER BY added_at DESC`,
          profile
        )
      : await d.getAllAsync<ContactRow>(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending FROM contacts ORDER BY added_at DESC`
        );
    return rows.map(rowToContact);
  });
}

export async function getContact(aegisId: string): Promise<StoredContact | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<ContactRow>(
      `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending FROM contacts WHERE aegis_id = ?`,
      aegisId
    );
    if (!row) return null;
    return rowToContact(row);
  });
}

export async function deleteContactMessages(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM messages WHERE chat_id = ?', chatId);
  });
}

export async function deleteContactRatchetSession(aegisId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM ratchet_sessions WHERE aegis_id = ?', aegisId);
  });
}

export async function deleteContact(aegisId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM contacts WHERE aegis_id = ?', aegisId);
  });
}
