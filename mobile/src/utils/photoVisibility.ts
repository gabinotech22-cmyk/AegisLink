/**
 * "Who sees my photo" (preferences.photoVis) — the policy the send paths apply.
 *
 * Byte-identical with desktop/src/renderer/utils/photoVisibility.ts.
 *
 * The profile photo rides inside E2EE payloads (`senderImage`). Until this
 * module existed the picker in Profile changed nothing: every recipient got
 * the photo. Now every site that puts `senderImage` on the wire asks here.
 *
 * `senderImageCleared` is the explicit "drop the photo you have of me" — a
 * bare `senderImage: null` means "no change" on the 1:1 paths (the photo is
 * only sent on the first message per session to keep envelopes small), so it
 * cannot double as a removal. Receivers apply: cleared → null, string → set,
 * null/absent → keep. Older clients ignore the flag and keep the old photo.
 */

export type PhotoVis = 'all' | 'contacts' | 'none';

export interface AvatarRecipient {
  /** Auto-added from an unknown incoming sender; not yet accepted. */
  pending?: boolean;
  blocked?: boolean;
}

/**
 * May our photo travel to this recipient? `recipient` is the contact record
 * when they are in our list, null when they are not (e.g. a group member we
 * only know through the group).
 */
export function mayShareAvatar(vis: PhotoVis, recipient: AvatarRecipient | null | undefined): boolean {
  if (vis === 'none') return false;
  if (vis === 'all') return true;
  return !!recipient && recipient.pending !== true && recipient.blocked !== true;
}

export interface AvatarFields {
  senderImage: string | null;
  senderImageCleared?: true;
}

/**
 * The avatar fields of a profile-bearing payload for one recipient.
 *
 * @param image   our photo as a data URI, or null when we have none
 * @param already true when this recipient got the photo earlier this session
 *                (first-message optimisation): nothing is repeated.
 */
export function avatarFieldsFor(
  vis: PhotoVis,
  recipient: AvatarRecipient | null | undefined,
  image: string | null,
  already = false,
): AvatarFields {
  if (already) return { senderImage: null };
  if (image && mayShareAvatar(vis, recipient)) return { senderImage: image };
  // Either we have no photo or this recipient may not see it: say so, so a
  // photo we removed (or restricted) disappears from their device too.
  return { senderImage: null, senderImageCleared: true };
}

/** What a receiver should store: null = clear, string = set, undefined = keep. */
export function receivedAvatar(payload: { senderImage?: string | null; senderImageCleared?: boolean }): string | null | undefined {
  if (payload.senderImageCleared === true) return null;
  return typeof payload.senderImage === 'string' && payload.senderImage ? payload.senderImage : undefined;
}
