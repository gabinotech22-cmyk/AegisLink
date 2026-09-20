/**
 * Daily summary on desktop: same rules as mobile (dailySummaryCore, byte-
 * identical), checked once a minute while the app runs. No background task on
 * desktop — the app either runs or it does not.
 */
import i18n from '../i18n';
import { logger } from '../utils/logger';
import { usePreferences } from '../store/preferences';
import { decideDailySummary, localDayKey } from './dailySummaryCore';

const DEV = import.meta.env.DEV;
const LAST_RUN_KEY = 'aegis.lastDailySummary';

function storage(): { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> } {
  return window.aegis.secureStorage;
}

/** Show the digest if due. Returns true when a notification was shown. */
export async function runDailySummary(): Promise<boolean> {
  try {
    const prefs = usePreferences.getState();
    const { useMessages } = await import('../store/messages');
    const { useContacts } = await import('../store/contacts');
    const { useGroups } = await import('../store/groups');
    const contacts = useContacts.getState().contacts;
    const groups = useGroups.getState().groups;
    const decision = decideDailySummary({
      enabled: prefs.notifSummary,
      previewOn: prefs.notifPreview,
      now: new Date(),
      lastRunDayKey: await storage().get(LAST_RUN_KEY),
      unreadCounts: useMessages.getState().unreadCounts,
      nameOf: (chatId) => contacts.find((c) => c.aegisId === chatId)?.name ?? groups.find((g) => g.id === chatId)?.name ?? null,
    });
    if (!decision) return false;
    if (decision.markDone) await storage().set(LAST_RUN_KEY, localDayKey(new Date()));
    if (decision.count === 0) return false;
    const body = i18n.t(decision.key, { count: decision.count, names: decision.names.join(', ') });
    // Names ride in the body only when previews are on (decideDailySummary),
    // and the main process only renders a body when `preview` is true.
    await window.aegis.notifications.show(i18n.t('notif.dailySummaryTitle'), body, {
      preview: true,
      silent: !prefs.notifSound,
    });
    return true;
  } catch (e) {
    if (DEV) logger.warn('[daily-summary] failed:', (e as Error).message);
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the once-a-minute check (idempotent). */
export function startDailySummaryTimer(): () => void {
  if (!timer) timer = setInterval(() => { void runDailySummary(); }, 60_000);
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}
