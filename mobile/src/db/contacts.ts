import { withDb } from './core';

export interface StoredContact {
  aegisId: string;
  publicKeyB64: string;
  /**
   * What we show for this contact: the local `nickname` when set, otherwise the
   * `profileName` they announce, otherwise the Aegis ID. Read this everywhere;
   * write through setNickname / updateContactProfile so the two sources never
   * overwrite each other (the nickname typed at add-time used to be silently
   * replaced by the first profile_update).
   */
  name: string;
  /** Display name the contact announces in its E2EE profile (column `name`). */
  profileName?: string;
  /** Nickname chosen locally by the user; null/empty = none. Never sent. */
  nickname?: string | null;
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
  /**
   * Onion of the relay that hosts this contact's mailbox (federation F1).
   * null/undefined = official relay. Set from a v2 contact link or a
   * `profile_update.mailboxRelay`; every routing decision goes through it.
   */
  relayOnion?: string | null;
  /**
   * Capabilities the contact announced in its E2EE profile (net/caps.ts).
   * Absent/empty = pre-caps client: every transport behaves as before.
   */
  caps?: string[] | null;
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
  relay_onion: string | null;
  caps: string | null;
  nickname: string | null;
};

/** Effective display name: nickname → announced profile name → Aegis ID. */
export function effectiveContactName(c: { aegisId: string; profileName?: string; nickname?: string | null }): string {
  return c.nickname?.trim() || c.profileName?.trim() || c.aegisId;
}

function rowToContact(r: ContactRow): StoredContact {
  return {
    aegisId: r.aegis_id,
    publicKeyB64: r.public_key_b64,
    signingPublicKeyB64: r.signing_public_key_b64 || undefined,
    name: effectiveContactName({ aegisId: r.aegis_id, profileName: r.name, nickname: r.nickname }),
    profileName: r.name,
    nickname: r.nickname ?? null,
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
    relayOnion: r.relay_onion ?? null,
    caps: parseCaps(r.caps),
  };
}

function parseCaps(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export async function saveContact(c: StoredContact): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO contacts
       (aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending, relay_onion, caps, nickname)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.aegisId,
      c.publicKeyB64,
      c.signingPublicKeyB64 || "",
      // Column `name` is the announced profile name; a contact built without
      // one (legacy callers) has no nickname either, so its display name is it.
      c.profileName ?? c.name,
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
      c.pending ? 1 : 0,
      c.relayOnion ?? null,
      c.caps && c.caps.length > 0 ? JSON.stringify(c.caps) : null,
      c.nickname?.trim() || null
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
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending, relay_onion, caps, nickname FROM contacts WHERE profile = ? ORDER BY added_at DESC`,
          profile
        )
      : await d.getAllAsync<ContactRow>(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending, relay_onion, caps, nickname FROM contacts ORDER BY added_at DESC`
        );
    return rows.map(rowToContact);
  });
}

export async function getContact(aegisId: string): Promise<StoredContact | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<ContactRow>(
      `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden, pending, relay_onion, caps, nickname FROM contacts WHERE aegis_id = ?`,
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
