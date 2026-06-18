/**
 * AegisLink — Desktop local DB (renderer side)
 *
 * Safe facade that delegates all operations to window.aegis.db.*
 * running securely inside the Electron main process.
 */

import '../crypto/ipc-types';

const db = () => window.aegis.db;
const secureStorage = () => window.aegis.secureStorage;

let activeSlot = 'self';

export function getActiveDbSlot(): string {
  return activeSlot;
}

export function getSecretKeySlot(slot = activeSlot): string {
  return slot === 'self' ? 'aegis.secretKey.b64' : `aegis.${slot}.secretKey.b64`;
}

export function getSignSecretKeySlot(slot = activeSlot): string {
  return slot === 'self' ? 'aegis.signSecretKey.b64' : `aegis.${slot}.signSecretKey.b64`;
}

export function setActiveDbSlot(slot: string): void {
  activeSlot = slot;
}

export async function closeActiveDatabase(): Promise<void> {
  // Owned by the main process
}

export async function deleteIdentitySlot(slot: string): Promise<void> {
  await secureStorage().delete(getSecretKeySlot(slot)).catch(() => {});
  await secureStorage().delete(getSignSecretKeySlot(slot)).catch(() => {});

  const prefKeys = [
    'displayName',
    'avatarColor',
    'avatarImage',
    'profileStatus',
  ];
  for (const pk of prefKeys) {
    await secureStorage().delete(`aegis.${slot}.${pk}`).catch(() => {});
  }
}

// ─── Identity ────────────────────────────────────────────────────────────────

export interface StoredIdentity {
  aegisId: string;
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  createdAt: number;
}

export async function saveIdentity(v: StoredIdentity): Promise<void> {
  await secureStorage().set(getSecretKeySlot(), v.secretKeyB64);
  await secureStorage().set(getSignSecretKeySlot(), v.signingSecretKeyB64);
  await db().saveIdentity(activeSlot, v);
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  const secretKeyB64 = await secureStorage().get(getSecretKeySlot());
  const signingSecretKeyB64 = await secureStorage().get(getSignSecretKeySlot());
  if (!secretKeyB64 || !signingSecretKeyB64) return null;
  const row = await db().loadIdentity(activeSlot);
  if (!row) return null;
  return {
    ...row,
    secretKeyB64,
    signingSecretKeyB64
  };
}

export async function clearIdentity(): Promise<void> {
  await secureStorage().delete(getSecretKeySlot());
  await secureStorage().delete(getSignSecretKeySlot());
  await db().clearIdentity();
}

// ─── Contacts ────────────────────────────────────────────────────────────────

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
  mutedUntil?: number | null;
  zeroTrust?: boolean;
  status?: string;
  blocked?: boolean;
  archived?: boolean;
  profile?: 'personal' | 'work';
}

export async function saveContact(c: StoredContact): Promise<void> {
  await db().saveContact(c);
}

export async function loadContacts(profile?: 'personal' | 'work'): Promise<StoredContact[]> {
  return await db().loadContacts(profile);
}

export async function getContact(aegisId: string): Promise<StoredContact | null> {
  return await db().getContact(aegisId);
}

export async function deleteContactMessages(chatId: string): Promise<void> {
  await db().deleteContactMessages(chatId);
}

export async function deleteContactRatchetSession(aegisId: string): Promise<void> {
  await db().deleteContactRatchetSession(aegisId);
}

export async function deleteContact(aegisId: string): Promise<void> {
  await db().deleteContact(aegisId);
}

// ─── DB encryption at-rest (identity pass-through since encrypt/decrypt is in Main) ───

export async function encryptBody(body: string): Promise<string> {
  return body;
}

export async function decryptBody(encryptedBody: string): Promise<string> {
  return encryptedBody;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'image' | 'audio' | 'file' | 'poll' | 'location' | 'view_once';

export interface MessageReactions {
  [emoji: string]: string[];
}

export interface StoredMessage {
  id: string;
  chatId: string;
  direction: 'in' | 'out';
  body: string;
  createdAt: number;
  type?: MessageType;
  mediaUri?: string | null;
  replyToId?: string | null;
  reactions?: MessageReactions;
  starred?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  deliveryStatus?: 'sent' | 'delivered' | 'read';
  expiresAt?: number | null;
}

export async function saveMessage(m: StoredMessage): Promise<void> {
  await db().saveMessage(activeSlot, m);
}

export async function updateMessageDelivery(id: string, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  await db().updateMessageDelivery(id, status);
}

export async function loadMessagesByChat(chatId: string): Promise<StoredMessage[]> {
  return await db().loadMessagesByChat(activeSlot, chatId);
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  return await db().getMessage(activeSlot, id);
}

export async function setMessagePinned(id: string, pinned: boolean): Promise<void> {
  await db().setMessagePinned(id, pinned);
}

export async function getPinnedMessage(chatId: string): Promise<StoredMessage | null> {
  return await db().getPinnedMessage(activeSlot, chatId);
}

export async function setMessageStarred(id: string, starred: boolean): Promise<void> {
  await db().setMessageStarred(id, starred);
}

export async function setMessageDeleted(id: string): Promise<void> {
  await db().setMessageDeleted(activeSlot, id);
}

export async function setMessageReactions(id: string, reactions: MessageReactions): Promise<void> {
  await db().setMessageReactions(id, reactions);
}

export async function lastMessageByChat(chatId: string): Promise<StoredMessage | null> {
  return await db().lastMessageByChat(activeSlot, chatId);
}

// ─── Double Ratchet sessions ─────────────────────────────────────────────────

export interface StoredRatchetSession {
  aegisId: string;
  stateJson: string;
}

export async function saveRatchetSession(aegisId: string, stateJson: string): Promise<void> {
  await db().saveRatchetSession(activeSlot, aegisId, stateJson);
}

export async function loadRatchetSession(aegisId: string): Promise<string | null> {
  return await db().loadRatchetSession(activeSlot, aegisId);
}

// ─── Groups ──────────────────────────────────────────────────────────────────

export interface StoredGroup {
  id: string;
  name: string;
  members: string[];
  createdAt: number;
  avatarColor?: string;
  avatarImage?: string;
  adminOnlyInvite?: boolean;
  moderateNewMembers?: boolean;
  adminId?: string;
  adminSig?: string;
  moderators?: string[];
  admins?: string[];
  permissions?: {
    onlyAdminsSend?: boolean;
    disableReactions?: boolean;
  };
}

export async function saveGroup(g: StoredGroup): Promise<void> {
  await db().saveGroup(g);
}

export async function loadGroups(): Promise<StoredGroup[]> {
  return await db().loadGroups();
}

export async function deleteGroup(id: string): Promise<void> {
  await db().deleteGroup(id);
}

export async function getGroup(id: string): Promise<StoredGroup | null> {
  return await db().getGroup(id);
}

// ─── Panic wipe ──────────────────────────────────────────────────────────────

export async function wipeDatabase(): Promise<void> {
  await secureStorage().delete(getSecretKeySlot());
  await secureStorage().delete(getSignSecretKeySlot());
  // Prekey secrets (SPK/OPK/PQSPK incl. the 2400-byte ML-KEM-768 PQSPK) live in
  // the keystore, NOT the SQL DB — the table wipe below would leave them intact.
  // Panic must leave nothing recoverable.
  await secureStorage().wipePrekeys().catch(() => {});
  await db().wipeDatabase(activeSlot);
  await secureStorage().delete('aegis.panic.v1').catch(() => {});
  await secureStorage().delete('aegis.preferences.v1').catch(() => {});
  await secureStorage().delete('aegis.polls.v1').catch(() => {});
}

// ─── Chat state (draft + unread) ─────────────────────────────────────────────

export async function getChatState(chatId: string): Promise<{ draft: string | null; unreadCount: number }> {
  return await db().getChatState(activeSlot, chatId);
}

export async function setChatDraft(chatId: string, draft: string | null): Promise<void> {
  await db().setChatDraft(activeSlot, chatId, draft);
}

export async function incrementUnread(chatId: string): Promise<void> {
  await db().incrementUnread(chatId);
}

export async function resetUnread(chatId: string): Promise<void> {
  await db().resetUnread(chatId);
}

export async function deleteChatState(chatId: string): Promise<void> {
  await db().deleteChatState(chatId);
}

export async function getAllUnreadCounts(): Promise<Record<string, number>> {
  return await db().getAllUnreadCounts();
}

// ─── Ephemeral cleanup ───────────────────────────────────────────────────────

export async function deleteExpiredMessages(timerSeconds: number): Promise<void> {
  await db().deleteExpiredMessages(timerSeconds);
}

// ─── Call history ────────────────────────────────────────────────────────────

export interface StoredCall {
  id: string;
  contactId: string;
  direction: 'in' | 'out';
  media: 'audio' | 'video';
  status: 'missed' | 'answered' | 'declined';
  startedAt: number;
  durationS: number;
}

export async function saveCall(c: StoredCall): Promise<void> {
  await db().saveCall(c);
}

export async function getCallHistory(contactId: string, limit = 50): Promise<StoredCall[]> {
  return await db().getCallHistory(contactId, limit);
}
