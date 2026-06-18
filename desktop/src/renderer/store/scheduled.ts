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
import type { GroupPostMeta } from '../utils/groupPost';

const STORAGE_KEY = 'aegis.scheduled.desktop.v1';
const GROUP_POSTS_KEY = 'aegis.scheduled.grouposts.v1';

export interface ScheduledItem {
  id: string;
  toContactId: string;
  toContactName: string;
  text: string;
  sendAt: number;
}

/**
 * Scheduled group post — fired at sendAt by the App runner.
 *
 * Diferencia con mobile: aquí persistimos el plaintext en localStorage (igual
 * que el ScheduledItem 1:1 ya existente). No replicamos el cifrado at-rest
 * del store mobile; ese diseño existe porque mobile no tiene un keystore
 * cifrado por defecto. Electron persiste localStorage en el perfil de usuario
 * del SO, así que es comparable al SecureStore mobile en término de blast
 * radius. El cifrado E2EE de transporte sigue siendo idéntico (sendGroupMessage
 * → Double Ratchet por miembro en el momento exacto del envío).
 *
 * Si una imagen va con el post, va como data: URI inline en `imageDataUrl`
 * (el path file:// de mobile no aplica en renderer). En el momento de envío
 * el post se reescribe como `[image:data:…][post:flags]Texto`.
 */
export interface ScheduledGroupPost {
  id: string;
  groupId: string;
  groupName: string;
  text: string;
  options: GroupPostMeta;
  /** Optional EXIF-stripped image, embedded as data: URI. */
  imageDataUrl?: string;
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

// ── Group posts ──────────────────────────────────────────────────────────────

export function loadGroupPosts(): ScheduledGroupPost[] {
  try {
    const raw = localStorage.getItem(GROUP_POSTS_KEY);
    return raw ? (JSON.parse(raw) as ScheduledGroupPost[]) : [];
  } catch {
    return [];
  }
}

export function saveGroupPosts(items: ScheduledGroupPost[]): void {
  try {
    localStorage.setItem(GROUP_POSTS_KEY, JSON.stringify(items));
  } catch {/* ignore quota / serialization errors */}
}

let deliveringGroupPosts = false;

/**
 * Fire every due group post: rebuild the body with the marker, prepend image
 * inline if present, and call sendGroupMessage. Failures stay queued (next tick
 * retries). Permission gate is enforced at the UI; we still drop posts whose
 * group disappeared.
 */
export async function deliverDueGroupPosts(identity: Identity): Promise<number> {
  if (deliveringGroupPosts) return 0;
  const due = loadGroupPosts().filter((p) => p.sendAt <= Date.now());
  if (due.length === 0) return 0;

  deliveringGroupPosts = true;
  try {
    const { sendGroupMessage } = await import('../socket/client');
    const { useGroups } = await import('./groups');
    const groups = useGroups.getState().groups;
    const { buildGroupPostBody } = await import('../utils/groupPost');
    const settled = new Set<string>();

    for (const post of due) {
      const group = groups.find((g) => g.id === post.groupId);
      if (!group) { settled.add(post.id); continue; }
      try {
        const text = buildGroupPostBody(post.text, post.options);
        const plaintext = post.imageDataUrl
          ? `[image:${post.imageDataUrl}]${text}`
          : text;
        await sendGroupMessage({ identity, groupId: post.groupId, plaintext });
        settled.add(post.id);
      } catch {
        // Keep queued — next tick retries.
      }
    }

    if (settled.size > 0) {
      saveGroupPosts(loadGroupPosts().filter((p) => !settled.has(p.id)));
    }
    return settled.size;
  } finally {
    deliveringGroupPosts = false;
  }
}

/**
 * Permission gate: only the group owner (adminId) or a moderator may schedule
 * announcement posts. Pure function — same shape as the mobile counterpart so
 * the UI gate and the fire-time re-check share one definition.
 */
export function canScheduleGroupPost(
  group: { adminId?: string; moderators?: string[] } | undefined | null,
  myAegisId: string | undefined | null,
): boolean {
  if (!group || !myAegisId) return false;
  if (group.adminId === myAegisId) return true;
  return group.moderators?.includes(myAegisId) ?? false;
}
