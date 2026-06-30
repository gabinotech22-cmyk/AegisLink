// Date/time formatting helpers for the chat screen (pure — no imports).
export function formatLastSeen(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) return 'Visto hace un momento';
  if (diffMin < 60) return `Visto hace ${diffMin}m`;
  if (diffHours < 24) return `Visto hace ${diffHours}h`;
  if (diffDays === 1) return 'Visto ayer';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `Visto el ${dd}/${mm}`;
}

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
