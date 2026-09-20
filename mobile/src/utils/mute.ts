/**
 * Mute semantics — one place for "is this chat muted right now?".
 *
 * Byte-identical with desktop/src/renderer/utils/mute.ts.
 *
 * Contacts: `muted` + `mutedUntil` on the contact record. `mutedUntil` is
 * `0`/`null` for "always" and an epoch-ms deadline for a timed mute. Two
 * opposite bugs lived on the two platforms: mobile tested `mutedUntil &&
 * mutedUntil > now`, so "always" (0) never muted; desktop tested `muted ||
 * …`, so a timed mute never expired.
 *
 * Groups (and any other chat id): `preferences.mutedChats` lists the ids,
 * `preferences.mutedChatsUntil[id]` the deadline (absent/0 = always). Nothing
 * ever wrote `mutedChats` before this module — groups could not be muted.
 */

export interface MutableContact {
  muted?: boolean;
  mutedUntil?: number | null;
}

export interface MutePrefs {
  mutedChats: string[];
  mutedChatsUntil?: Record<string, number>;
}

/** Deadline → still muted at `now`? (0/null/undefined = always). */
export function muteActive(until: number | null | undefined, now: number): boolean {
  return !until || until > now;
}

export function isContactMutedNow(c: MutableContact | null | undefined, now: number): boolean {
  if (!c || c.muted !== true) return false;
  return muteActive(c.mutedUntil, now);
}

export function isChatMutedNow(prefs: MutePrefs | null | undefined, chatId: string, now: number): boolean {
  if (!prefs || !prefs.mutedChats.includes(chatId)) return false;
  return muteActive(prefs.mutedChatsUntil?.[chatId], now);
}

/** New preference values after muting / unmuting a chat id (groups). */
export function withChatMute(
  prefs: MutePrefs,
  chatId: string,
  muted: boolean,
  until: number | null = 0,
): { mutedChats: string[]; mutedChatsUntil: Record<string, number> } {
  const list = prefs.mutedChats.filter((id) => id !== chatId);
  const untilMap = { ...(prefs.mutedChatsUntil ?? {}) };
  delete untilMap[chatId];
  if (muted) {
    list.push(chatId);
    if (until && until > 0) untilMap[chatId] = until;
  }
  return { mutedChats: list, mutedChatsUntil: untilMap };
}
