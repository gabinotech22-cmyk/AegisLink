/**
 * AegisLink — Mailbox root store (sealed-sender Fase 4, mobile)
 *
 * Owns the client side of blind mailbox IDs (docs/SEALED-SENDER-ARCHITECTURE.md
 * §3.4). Mirrors deliveryToken.ts:
 *  - our OWN 32-byte mailbox root: generated once, persisted in SecureStore,
 *    shared with contacts over E2EE (profile_update). Whoever holds it can derive
 *    every epoch's mailbox id for us, so it is a secret → SecureStore.
 *  - CONTACTS' roots: the roots contacts shared with us, persisted per contact so
 *    we can compute the recipient's current mailbox id when addressing a message.
 *
 * Rotation is automatic: the per-epoch mailbox is derived from (root, epoch), so
 * sharing the root once is enough — no per-epoch re-sharing.
 */

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { currentMailbox, deriveMailbox, type Mailbox } from './mailbox';

const OWN_ROOT_SLOT = 'aegis.mailboxRoot.self';
const CONTACT_SLOT_PREFIX = 'aegis.mailboxRoot.peer.';
const LAST_CONNECT_EPOCH_SLOT = 'aegis.mailboxRoot.lastEpoch';

/** Mailbox root length (bytes). */
const ROOT_BYTES = 32;

function peerSlot(aegisId: string): string {
  return CONTACT_SLOT_PREFIX + aegisId;
}

function isValidRootB64(rootB64: string): Uint8Array | null {
  try {
    const bytes = decodeBase64(rootB64);
    return bytes.length === ROOT_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Our own mailbox root, generating + persisting it on first use. The raw value is
 * a secret (whoever holds it can derive our mailbox for any epoch) → SecureStore.
 */
export async function getOwnMailboxRoot(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(OWN_ROOT_SLOT);
  if (existing) {
    const valid = isValidRootB64(existing);
    if (valid) return valid;
  }
  const fresh = nacl.randomBytes(ROOT_BYTES);
  await SecureStore.setItemAsync(OWN_ROOT_SLOT, encodeBase64(fresh));
  return fresh;
}

/** Base64 of our own root, for sharing with a contact over E2EE. */
export async function getOwnMailboxRootB64(): Promise<string> {
  return encodeBase64(await getOwnMailboxRoot());
}

/** Persist a contact's mailbox root (received over E2EE). Ignores malformed input. */
export async function setContactMailboxRoot(aegisId: string, rootB64: string): Promise<void> {
  if (typeof rootB64 !== 'string' || !isValidRootB64(rootB64)) return;
  await SecureStore.setItemAsync(peerSlot(aegisId), rootB64);
}

/** A contact's mailbox root, or null if they haven't shared one yet. */
export async function getContactMailboxRoot(aegisId: string): Promise<Uint8Array | null> {
  const v = await SecureStore.getItemAsync(peerSlot(aegisId));
  return v ? isValidRootB64(v) : null;
}

/** Our current-epoch mailbox (routing id + auth keypair). */
export async function getOwnCurrentMailbox(nowMs: number): Promise<Mailbox> {
  return currentMailbox(await getOwnMailboxRoot(), nowMs);
}

/**
 * Our mailboxes for an explicit set of epochs (Slice 5b catch-up binds). Used to
 * re-bind + drain past-epoch queues we may have been offline across, since the
 * routing id rotates per epoch but the offline queue retains up to MESSAGE_TTL.
 */
export async function getOwnMailboxesForEpochs(epochs: number[]): Promise<Mailbox[]> {
  const root = await getOwnMailboxRoot();
  return epochs.map((e) => deriveMailbox(root, e));
}

/**
 * The highest epoch we last connected/drained, or null if never. Drives the
 * catch-up window on the next connect so messages queued under intervening
 * epochs (while offline across a boundary) still drain. Not secret (a plain
 * integer) but kept in the same store for simplicity.
 */
export async function getLastMailboxConnectEpoch(): Promise<number | null> {
  const v = await SecureStore.getItemAsync(LAST_CONNECT_EPOCH_SLOT);
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Persist the highest epoch we've connected/drained (see getLastMailboxConnectEpoch). */
export async function setLastMailboxConnectEpoch(epoch: number): Promise<void> {
  if (!Number.isInteger(epoch) || epoch < 0) return;
  await SecureStore.setItemAsync(LAST_CONNECT_EPOCH_SLOT, String(epoch));
}

/**
 * A contact's current-epoch mailbox id (base64) to address an envelope to, or
 * null if we don't hold their root yet (→ caller falls back to aegisId transport).
 */
export async function getContactCurrentMailboxId(aegisId: string, nowMs: number): Promise<string | null> {
  const root = await getContactMailboxRoot(aegisId);
  if (!root) return null;
  return currentMailbox(root, nowMs).mailboxIdB64;
}
