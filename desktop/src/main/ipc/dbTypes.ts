/**
 * Typed shapes for the desktop main-process DB IPC layer (audit M5).
 *
 * Two families:
 *  - `*Input`  — payloads the renderer sends over IPC (camelCase). Already
 *    length-bounded by `assertMaxLen` in the handlers; typed here so a missing
 *    field is a compile error instead of a silent `undefined` write.
 *  - `*Row`    — rows read back from SQLite (snake_case columns). Used as the
 *    `Result` generic on `db.prepare<…, Row>()` so `.get()/.all()` are typed,
 *    which in turn type-checks the row→DTO mapping in each handler.
 *
 * These never cross the contextBridge as-is (the renderer sees the camelCase
 * DTOs the handlers return), so tightening them here is internal and safe.
 */

// ── Inputs (renderer → main) ──────────────────────────────────────────────────

export interface IdentityInput {
  aegisId: string;
  publicKeyB64: string;
  signingPublicKeyB64: string;
  createdAt: number;
}

export interface ContactInput {
  aegisId: string;
  publicKeyB64: string;
  signingPublicKeyB64?: string;
  name: string;
  verified?: boolean;
  addedAt: number;
  color?: string | null;
  avatarImage?: string | null;
  muted?: boolean;
  zeroTrust?: boolean;
  status?: string | null;
  mutedUntil?: number | null;
  blocked?: boolean;
  archived?: boolean;
  profile?: string;
}

export interface MessageInput {
  id: string;
  chatId: string;
  direction: string;
  body: string;
  createdAt: number;
  type?: string;
  mediaUri?: string | null;
  replyToId?: string | null;
  reactions?: unknown;
  starred?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  deliveryStatus?: string;
  expiresAt?: number | null;
}

export interface GroupInput {
  id: string;
  name: string;
  members?: unknown;
  createdAt: number;
  avatarColor?: string | null;
  avatarImage?: string | null;
  adminOnlyInvite?: boolean;
  moderateNewMembers?: boolean;
  adminId?: string | null;
  adminSig?: string | null;
}

export interface CallInput {
  id: string;
  contactId: string;
  direction: string;
  media: string;
  status: string;
  startedAt: number;
  durationS: number;
}

// ── Rows (SQLite → main) ──────────────────────────────────────────────────────

export interface IdentityRow {
  aegis_id: string;
  public_key_b64: string;
  signing_public_key_b64: string;
  created_at: number;
}

export interface ContactRow {
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
}

export interface MessageRow {
  id: string;
  chat_id: string;
  direction: string;
  body: string;
  created_at: number;
  type: string | null;
  media_uri: string | null;
  reply_to_id: string | null;
  reactions: string | null;
  starred: number;
  deleted: number;
  pinned: number;
  delivery_status: string | null;
  expires_at: number | null;
}

export type LastMessageRow = Pick<
  MessageRow,
  'id' | 'chat_id' | 'direction' | 'body' | 'created_at'
>;

export interface RatchetRow {
  state_json: string;
}

export interface GroupRow {
  id: string;
  name: string;
  members: string;
  created_at: number;
  avatar_color: string | null;
  avatar_image: string | null;
  admin_only_invite: number;
  moderate_new_members: number;
  admin_id: string | null;
  admin_sig: string | null;
}

export interface ChatStateRow {
  draft: string | null;
  unread_count: number;
}

export interface UnreadRow {
  chat_id: string;
  unread_count: number;
}

export interface CallRow {
  id: string;
  contact_id: string;
  direction: string;
  media: string;
  status: string;
  started_at: number;
  duration_s: number;
}
