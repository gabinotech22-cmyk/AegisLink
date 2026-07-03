import { logger } from '../utils/logger';

/**
 * Channel background-sync task — leak-free "push" for sealed public channels.
 *
 * The relay CANNOT push channel posts: it does not know which identities
 * subscribe to a channel, and building a channel→push-token table would be
 * exactly the subscriber-list metadata leak the zero-metadata rule bans
 * (see server/src/relay/handlers/publicChannels.ts §"NO offline push wake-up").
 *
 * Instead the DEVICE polls on its own schedule. On a background-fetch wake-up
 * (expo-background-fetch, OS-scheduled, no server involvement) we:
 *   1. hydrate identity (+preferences, honoring duress),
 *   2. reconnect the relay socket,
 *   3. delta-pull every subscribed channel and fire a mute-aware LOCAL
 *      notification for genuinely new posts.
 *
 * Zero metadata: the relay only sees anonymous `pubchannel:pull` reads for
 * opaque channelIds (public by definition); it never learns that THIS device
 * follows them beyond the read itself, and no push token is ever linked to a
 * channel. Delta detection uses the this-device-only persisted chain head.
 *
 * Platform reality: Android runs background fetch fairly reliably; iOS grants
 * BGAppRefresh windows opportunistically (often ~15+ min apart, never
 * guaranteed). This is a best-effort "catch-up" notification, not a real-time
 * banner — that tradeoff is inherent to staying leak-free.
 */

export const CHANNEL_SYNC_TASK = 'aegis.channel-sync';

// Keep the headless runtime alive long enough for socket auth + the pull
// round-trips to land before the OS suspends us again.
const HOLD_MS = 10_000;
const CONNECT_POLL_MS = 250;
const CONNECT_TIMEOUT_MS = 8_000;

/** Resolve once the relay socket reports connected, or after a timeout. */
async function waitForSocket(): Promise<boolean> {
  const client = require('../socket/client') as typeof import('../socket/client');
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (client.isConnected()) return true;
    await new Promise<void>((r) => setTimeout(r, CONNECT_POLL_MS));
  }
  return client.isConnected();
}

/** Hydrate, reconnect and delta-pull every subscribed channel. Best-effort. */
export async function runChannelBackgroundSync(): Promise<number> {
  // Duress guard: never touch the network with the panic/decoy identity.
  try {
    const { usePreferences } = require('../store/preferences') as {
      usePreferences: { getState: () => { duressActive?: boolean; hydrate?: () => Promise<void> } };
    };
    const prefs = usePreferences.getState();
    if (prefs.hydrate) await prefs.hydrate();
    if (usePreferences.getState().duressActive === true) return 0;
  } catch { /* preferences store not ready — assume no duress and continue */ }

  const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
  if (!useIdentity.getState().hydrated) await useIdentity.getState().hydrate();
  const identity = useIdentity.getState().identity;
  if (!identity) return 0;

  const client = require('../socket/client') as typeof import('../socket/client');
  if (!client.isConnected()) client.connect(identity);
  const connected = await waitForSocket();
  if (!connected) return 0;

  const { useChannels } = require('../store/channels') as typeof import('../store/channels');
  const fresh = await useChannels.getState().syncSubscribedForBackground(identity);

  // Brief hold so any in-flight pull acks settle before suspension.
  await new Promise<void>((r) => setTimeout(r, HOLD_MS));
  return fresh;
}

/**
 * Register the OS background-fetch task. Idempotent; the OS persists the
 * registration. Called from registerForPush once the app is ready (the task
 * needs no notification permission for the pull itself, but posting the local
 * notification does — same permission the app already requests).
 */
export async function registerChannelBackgroundSync(): Promise<void> {
  try {
    const BackgroundFetch = require('expo-background-fetch') as typeof import('expo-background-fetch');
    const TaskManager = require('expo-task-manager') as typeof import('expo-task-manager');
    const isRegistered = await TaskManager.isTaskRegisteredAsync(CHANNEL_SYNC_TASK);
    if (isRegistered) return;
    await BackgroundFetch.registerTaskAsync(CHANNEL_SYNC_TASK, {
      minimumInterval: 15 * 60, // seconds — OS enforces its own (often larger) floor
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (e) {
    if (__DEV__) logger.warn('[channels] background-sync registration failed:', (e as Error).message);
  }
}

// Define the task at MODULE LOAD so it exists before a headless launch fires it
// (index.ts / App.tsx import this module early, alongside the React entry).
(function defineChannelSyncTask() {
  try {
    const TaskManager = require('expo-task-manager') as typeof import('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch') as typeof import('expo-background-fetch');
    if (TaskManager.isTaskDefined(CHANNEL_SYNC_TASK)) return;
    TaskManager.defineTask(CHANNEL_SYNC_TASK, async () => {
      try {
        const fresh = await runChannelBackgroundSync();
        return fresh > 0
          ? BackgroundFetch.BackgroundFetchResult.NewData
          : BackgroundFetch.BackgroundFetchResult.NoData;
      } catch {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });
  } catch { /* expo-task-manager unavailable (Expo Go) — no background sync */ }
})();
