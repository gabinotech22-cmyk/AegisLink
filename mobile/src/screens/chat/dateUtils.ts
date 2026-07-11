// Date/time formatting helpers for the chat screen (pure — no imports).

/** True when two timestamps fall on the same local calendar day. */
export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Day-separator label: Today / Yesterday / locale date (year only if not current). */
export function dayLabel(ts: number, todayLabel: string, yesterdayLabel: string): string {
  const now = Date.now();
  if (isSameLocalDay(ts, now)) return todayLabel;
  if (isSameLocalDay(ts, now - 86_400_000)) return yesterdayLabel;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' },
  );
}
