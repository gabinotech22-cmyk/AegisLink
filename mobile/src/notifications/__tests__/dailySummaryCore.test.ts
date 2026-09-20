import { decideDailySummary, isPastSummaryTime, localDayKey } from '../dailySummaryCore';

const at = (h: number, m = 0) => { const d = new Date(2026, 8, 20, h, m); return d; };
const names = (id: string) => ({ a: 'Ana', b: 'Bob', c: 'Cai', d: 'Dee' } as Record<string, string>)[id] ?? null;

describe('daily summary decision', () => {
  it('off by default → never', () => {
    expect(decideDailySummary({ enabled: false, previewOn: true, now: at(20), lastRunDayKey: null, unreadCounts: { a: 3 }, nameOf: names })).toBeNull();
  });

  it('only after 19:30 local, once per local day', () => {
    expect(isPastSummaryTime(at(19, 29))).toBe(false);
    expect(isPastSummaryTime(at(19, 30))).toBe(true);
    expect(decideDailySummary({ enabled: true, previewOn: false, now: at(19, 29), lastRunDayKey: null, unreadCounts: { a: 1 }, nameOf: names })).toBeNull();
    expect(decideDailySummary({ enabled: true, previewOn: false, now: at(20), lastRunDayKey: localDayKey(at(20)), unreadCounts: { a: 1 }, nameOf: names })).toBeNull();
  });

  it('counts UNREAD, not received; zero unread → nothing shown but the day is marked', () => {
    const d = decideDailySummary({ enabled: true, previewOn: true, now: at(20), lastRunDayKey: null, unreadCounts: { a: 0, b: 0 }, nameOf: names });
    expect(d).toEqual({ key: 'notif.dailySummaryBody', count: 0, names: [], markDone: true });
  });

  it('previews OFF → no names, whatever is unread', () => {
    const d = decideDailySummary({ enabled: true, previewOn: false, now: at(20), lastRunDayKey: null, unreadCounts: { a: 2, b: 5 }, nameOf: names });
    expect(d).toEqual({ key: 'notif.dailySummaryBody', count: 7, names: [], markDone: true });
  });

  it('previews ON → at most three names, busiest first, unknown ids skipped', () => {
    const d = decideDailySummary({ enabled: true, previewOn: true, now: at(20), lastRunDayKey: null, unreadCounts: { a: 1, b: 9, c: 4, d: 2, zz: 8 }, nameOf: names });
    expect(d).toEqual({ key: 'notif.dailySummaryNamesBody', count: 24, names: ['Bob', 'Cai', 'Dee'], markDone: true });
  });
});
