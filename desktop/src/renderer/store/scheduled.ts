/**
 * AegisLink Desktop — scheduled messages (local store + delivery runner).
 *
 * The Scheduled screen used to import sendMessage but never call it: items were
 * persisted to localStorage and counted down on screen, then silently dropped —
 * nothing was ever transmitted. This module owns the storage shape AND the
 * delivery logic so an app-wide runner (App.tsx) can fire due messages no
 * matter which screen is open.
 */

import { decodeBase64 } from 'tweetnacl-util';
import type { Identity } from '../crypto/identity';

const STORAGE_KEY = 'aegis.scheduled.desktop.v1';

export interface ScheduledItem {
  id: string;
  toContactId: string;
  toContactName: string;
  text: string;
  sendAt: number;
}

export function loadScheduled(): ScheduledItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ScheduledItem[]) : [];
  } catch {
    return [];
  }
}

export function saveScheduled(items: ScheduledItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore quota / serialization errors */
  }
}

// Re-entrancy guard: the App runner ticks every second, but a single delivery
// (X3DH session setup + relay round-trip) can take longer than one tick.
let delivering = false;

/**
 * Deliver every scheduled message whose time has come, then remove it from the
 * queue. Safe to call repeatedly on an interval. Returns how many were
 * delivered so the caller (or the open screen) can refresh.
 *
 * `sendMessage` already appends to the 1:1 chat and, when offline, enqueues for
 * later delivery without throwing — so a message we hand off is "delivered" from
 * the scheduler's point of view and must not be retried (that would double-send).
 * We only keep an item queued if sendMessage actually throws (e.g. a session
 * could not be established), so the next tick retries it.
 */
export async function deliverDueScheduled(identity: Identity): Promise<number> {
  if (delivering) return 0;
  const due = loadScheduled().filter((i) => i.sendAt <= Date.now());
  if (due.length === 0) return 0;

  delivering = true;
  try {
    const { sendMessage } = await import('../socket/client');
    const { useContacts } = await import('./contacts');
    const contacts = useContacts.getState().contacts;
    const settled = new Set<string>();

    for (const item of due) {
      const contact = contacts.find((c) => c.aegisId === item.toContactId);
      if (!contact) {
        // Recipient was removed — drop it so it can't wedge the queue forever.
        settled.add(item.id);
        continue;
      }
      try {
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: item.text,
        });
        settled.add(item.id);
      } catch {
        // Leave it queued; the next tick retries once a session is available.
      }
    }

    if (settled.size > 0) {
      saveScheduled(loadScheduled().filter((i) => !settled.has(i.id)));
    }
    return settled.size;
  } finally {
    delivering = false;
  }
}
