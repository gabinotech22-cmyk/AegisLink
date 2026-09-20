/**
 * Daily summary — the decision, pure, byte-identical mobile ↔ desktop.
 *
 * One local notification per day, after 19:30 local time, saying how many
 * messages are still UNREAD (not "received today": a conversation the user
 * already read is not news). Contact names appear only when the user turned
 * content previews ON — a lock screen must not learn who writes to you from
 * a digest when it is not allowed to learn it from the messages themselves.
 * Off by default (owner decision 2026-09-20); the user opts in.
 */
export const DAILY_SUMMARY_HOUR = 19;
export const DAILY_SUMMARY_MINUTE = 30;

/** Local calendar day key, so the "already ran today" gate and the time gate agree. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isPastSummaryTime(d: Date): boolean {
  return d.getHours() > DAILY_SUMMARY_HOUR || (d.getHours() === DAILY_SUMMARY_HOUR && d.getMinutes() >= DAILY_SUMMARY_MINUTE);
}

export interface SummaryDecision {
  /** i18n key to use: with or without names. */
  key: 'notif.dailySummaryBody' | 'notif.dailySummaryNamesBody';
  count: number;
  /** At most three display names, only when previews are on; else empty. */
  names: string[];
  /** true when the caller must persist today's key (a run happened or was skipped for good). */
  markDone: boolean;
}

/**
 * Decide whether to show the digest now. Returns null when nothing should be
 * shown (setting off, too early, already done today, nothing unread).
 */
export function decideDailySummary(input: {
  enabled: boolean;
  previewOn: boolean;
  now: Date;
  lastRunDayKey: string | null;
  /** chatId → unread count (the same counters the chat list shows). */
  unreadCounts: Record<string, number>;
  /** chatId → display name, for the names variant. */
  nameOf: (chatId: string) => string | null;
}): SummaryDecision | null {
  if (!input.enabled) return null;
  if (!isPastSummaryTime(input.now)) return null;
  const today = localDayKey(input.now);
  if (input.lastRunDayKey === today) return null;
  const entries = Object.entries(input.unreadCounts).filter(([, n]) => typeof n === 'number' && n > 0);
  const count = entries.reduce((acc, [, n]) => acc + n, 0);
  if (count === 0) return { key: 'notif.dailySummaryBody', count: 0, names: [], markDone: true };
  if (!input.previewOn) return { key: 'notif.dailySummaryBody', count, names: [], markDone: true };
  const names: string[] = [];
  for (const [chatId] of entries.sort((a, b) => b[1] - a[1])) {
    const n = input.nameOf(chatId);
    if (n && !names.includes(n)) names.push(n);
    if (names.length === 3) break;
  }
  return names.length > 0
    ? { key: 'notif.dailySummaryNamesBody', count, names, markDone: true }
    : { key: 'notif.dailySummaryBody', count, names: [], markDone: true };
}
