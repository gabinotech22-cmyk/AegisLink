import * as Notifications from 'expo-notifications';
import { logger } from '../utils/logger';
import { ss } from '../utils/secureStore';
import { tAsync } from '../i18n';
import { decideDailySummary, localDayKey } from './dailySummaryCore';

export const DAILY_SUMMARY_TASK = 'aegis.daily-summary';
const LAST_RUN_KEY = 'lastDailySummary';

/**
 * Show the daily digest if it is due (see dailySummaryCore for the rules:
 * opt-in, after 19:30, once a day, UNREAD counts, names only with previews).
 * Runs from the background-fetch task and from the foreground interval, so a
 * device where background fetch never fires still gets it while the app is
 * open. Returns true when a notification was shown.
 */
export async function runDailySummary(): Promise<boolean> {
  try {
    const { usePreferences } = require('../store/preferences') as typeof import('../store/preferences');
    const prefs = usePreferences.getState();
    if (prefs.hydrate) await prefs.hydrate();
    const { useMessages } = require('../store/messages') as typeof import('../store/messages');
    const { useContacts } = require('../store/contacts') as typeof import('../store/contacts');
    const { getAllUnreadCounts } = require('../db/local') as typeof import('../db/local');
    // Counters from the DB, not only the in-memory store: the background task
    // may run with the store cold.
    let unreadCounts: Record<string, number> = useMessages.getState().unreadCounts ?? {};
    try { unreadCounts = { ...unreadCounts, ...(await getAllUnreadCounts()) }; } catch { /* store counters only */ }
    let contacts = useContacts.getState().contacts;
    if (contacts.length === 0) { try { await useContacts.getState().hydrate(); contacts = useContacts.getState().contacts; } catch { /* names optional */ } }
    const { useGroups } = require('../store/groups') as typeof import('../store/groups');
    const groups = useGroups.getState().groups;

    const decision = decideDailySummary({
      enabled: prefs.notifSummary,
      previewOn: prefs.notifPreview,
      now: new Date(),
      lastRunDayKey: await ss.get(LAST_RUN_KEY),
      unreadCounts,
      nameOf: (chatId) => contacts.find((c) => c.aegisId === chatId)?.name ?? groups.find((g) => g.id === chatId)?.name ?? null,
    });
    if (!decision) return false;
    if (decision.markDone) await ss.set(LAST_RUN_KEY, localDayKey(new Date()));
    if (decision.count === 0) return false;

    const body = await tAsync(decision.key, { count: decision.count, names: decision.names.join(', ') });
    await Notifications.scheduleNotificationAsync({
      content: {
        title: await tAsync('notif.dailySummaryTitle'),
        body,
        sound: prefs.notifSound ? 'default' : undefined,
        priority: Notifications.AndroidNotificationPriority.DEFAULT,
      },
      trigger: null,
    });
    return true;
  } catch (e) {
    if (__DEV__) logger.warn('[daily-summary] failed:', e);
    return false;
  }
}

export async function registerDailySummaryTask(): Promise<void> {
  try {
    const BackgroundFetch = require('expo-background-fetch') as typeof import('expo-background-fetch');
    const TaskManager = require('expo-task-manager') as typeof import('expo-task-manager');
    const isRegistered = await TaskManager.isTaskRegisteredAsync(DAILY_SUMMARY_TASK);
    if (isRegistered) return;
    await BackgroundFetch.registerTaskAsync(DAILY_SUMMARY_TASK, {
      minimumInterval: 60 * 60, // check every hour
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (e) {
    if (__DEV__) logger.warn('[daily-summary] registration failed:', (e as Error).message);
  }
}

(function defineDailySummaryTask() {
  try {
    const TaskManager = require('expo-task-manager') as typeof import('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch') as typeof import('expo-background-fetch');
    if (TaskManager.isTaskDefined(DAILY_SUMMARY_TASK)) return;
    TaskManager.defineTask(DAILY_SUMMARY_TASK, async () => {
      try {
        const didRun = await runDailySummary();
        return didRun
          ? BackgroundFetch.BackgroundFetchResult.NewData
          : BackgroundFetch.BackgroundFetchResult.NoData;
      } catch {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });
  } catch { /* expo-task-manager unavailable */ }
})();
