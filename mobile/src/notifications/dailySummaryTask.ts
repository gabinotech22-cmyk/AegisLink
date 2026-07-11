import * as Notifications from 'expo-notifications';
import { logger } from '../utils/logger';
import { ss } from '../utils/secureStore';
import { tAsync } from '../i18n';
import type { StoredContact } from '../db/contacts';

export const DAILY_SUMMARY_TASK = 'aegis.daily-summary';

export async function runDailySummary(): Promise<boolean> {
  try {
    const { usePreferences } = require('../store/preferences') as typeof import('../store/preferences');
    const prefs = usePreferences.getState();
    if (prefs.hydrate) await prefs.hydrate();
    if (!prefs.notifSummary) return false;
    
    // Check if we already ran today
    const now = new Date();
    if (now.getHours() < 19 || (now.getHours() === 19 && now.getMinutes() < 30)) {
      return false; // too early
    }
    // Dedup key must match the local-time gate above (not UTC) — otherwise near
    // midnight UTC the gate (local hour) and the dedup key (UTC date) can point
    // at different calendar days and the task fires twice, or never, per day.
    const todayString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const lastRun = await ss.get('lastDailySummary');
    if (lastRun === todayString) return false; // already ran today

    // Run summary
    let total = 0;
    let names: string[] = [];
    const { withDb } = require('../db/local') as typeof import('../db/local');
    await withDb(async (db) => {
      // Get messages from today
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const startTs = startOfDay.getTime();
      
      const res = await db.getAllAsync<{ sender_id: string; c: number }>(`
        SELECT chat_id as sender_id, COUNT(*) as c
        FROM messages
        WHERE created_at >= ? AND direction = 'in'
        GROUP BY chat_id
      `, [startTs]);

      if (res && res.length > 0) {
        const { useContacts } = require('../store/contacts') as typeof import('../store/contacts');
        await useContacts.getState().hydrate();
        const contacts = useContacts.getState().contacts;
        
        for (const r of res) {
          total += r.c;
          const contact = contacts.find((c: StoredContact) => c.aegisId === r.sender_id);
          names.push(contact ? contact.name : r.sender_id);
        }
      }
    });

    if (total > 0) {
      const namesStr = names.slice(0, 3).join(', ') + (names.length > 3 ? '...' : '');
      const body = await tAsync('notif.dailySummaryBody', { count: total, names: namesStr });

      await Notifications.scheduleNotificationAsync({
        content: {
          title: await tAsync('notif.dailySummaryTitle'),
          body: body,
          sound: prefs.notifSound ? 'default' : undefined,
          priority: Notifications.AndroidNotificationPriority.DEFAULT,
        },
        trigger: null,
      });
    }

    await ss.set('lastDailySummary', todayString);
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
