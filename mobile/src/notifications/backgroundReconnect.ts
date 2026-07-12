import { logger } from '../utils/logger';
/**
 * Background notification task — wakes the socket from a killed/backgrounded
 * state WITHOUT leaking metadata.
 *
 * The relay only ever sends generic, zero-metadata wake-up pushes ({ kind:
 * 'wakeup' | 'call_wakeup' }). On their own those just paint an OS banner — the
 * JS runtime stays asleep, so nothing reconnects and no rich local notification
 * (e.g. a voice-channel "Unirse / Descartar") can be built on-device.
 *
 * This task closes that gap: when a wake-up push arrives, expo-notifications
 * spins up a short headless JS run; we hydrate the identity, reconnect the
 * relay socket and (re)attach the call handlers. The relay then re-delivers
 * whatever was queued, and an in-flight `group_call:channel` heartbeat lands
 * within one interval → groupCalls fires showGroupCallChannelNotification().
 *
 * Privacy: the push payload still carries NO group/call/sender identity. All of
 * that is resolved locally over the authenticated socket after we reconnect.
 *
 * Platform reality: reliable on Android (high-priority FCM data messages get a
 * background execution window). On iOS, `content-available` pushes are heavily
 * throttled by the OS and not guaranteed from a killed state — there the user
 * still falls back to tapping the banner.
 */

export const BG_NOTIFICATION_TASK = 'aegis.bg-notification';

// How long to keep the headless runtime alive so auth + queue drain complete and
// a voice-channel heartbeat (re-emitted ~every 20s) has a chance to arrive.
const HOLD_MS = 12_000;

/** Pull our `{ kind }` marker out of the various shapes expo/FCM may deliver. */
function extractKind(data: unknown): string | undefined {
  const d = data as Record<string, unknown> | undefined;
  if (!d) return undefined;
  // expo-notifications background task: { notification: { request: { content: { data } } } }
  // or, on Android data messages, the payload fields directly.
  const candidates: unknown[] = [
    d['kind'],
    (d['notification'] as { data?: Record<string, unknown> } | undefined)?.data?.['kind'],
    ((d['notification'] as { request?: { content?: { data?: Record<string, unknown> } } } | undefined)
      ?.request?.content?.data)?.['kind'],
    (d['body'] as Record<string, unknown> | undefined)?.['kind'],
  ];
  for (const c of candidates) if (typeof c === 'string') return c;
  return undefined;
}

/** Exported for tests. Also the function the background task invokes on wake. */
export async function wakeAndReconnect(): Promise<void> {
  const { useIdentity } = require('../store/identity') as typeof import('../store/identity');

  // Headless cold start: stores aren't hydrated yet. Hydrate preferences first
  // (duress flag) then identity, mirroring the foreground boot order.
  let duressActive = false;
  try {
    const { usePreferences } = require('../store/preferences') as { usePreferences: { getState: () => { duressActive?: boolean; hydrate?: () => Promise<void> } } };
    const prefs = usePreferences.getState();
    if (prefs.hydrate) await prefs.hydrate();
    duressActive = usePreferences.getState().duressActive === true;
  } catch { /* preferences store not ready — assume no duress */ }

  // Never connect with the panic/decoy identity — it would leak that panic mode
  // is active to the relay.
  if (duressActive) return;

  if (!useIdentity.getState().hydrated) {
    await useIdentity.getState().hydrate();
  }
  const identity = useIdentity.getState().identity;
  if (!identity) return;

  const client = require('../socket/client') as typeof import('../socket/client');
  if (!client.isConnected()) client.connect(identity);

  // Slice 2b: also drain the mailbox socket on background wake. client.connect()
  // already wires the mailbox internally on a fresh socket AND on the
  // "same identity, kick the dead handle" fast path (see connectMailboxForIdentity
  // in socket/client.ts) — this call is a deliberate, idempotent belt-and-suspenders
  // for the headless background task, whose module state may not match whatever
  // branch connect() took. connectMailboxForIdentity() itself no-ops unless
  // MAILBOX_ENABLED and reuses a live mailbox socket, so this is always safe to
  // call. The duress check above already gates this: we never reach here (and
  // therefore never open ANY socket, mailbox included) while duressActive.
  client.connectMailboxForIdentity(identity);

  // Re-attach call handlers so the heartbeat → local-notification path is wired
  // even though App's React effects never ran in this headless launch. Both are
  // idempotent (they off() before on()).
  try {
    const { WEBRTC_AVAILABLE } = require('../runtime') as typeof import('../runtime');
    if (WEBRTC_AVAILABLE) {
      const calls = require('../socket/calls') as typeof import('../socket/calls');
      const groupCalls = require('../socket/groupCalls') as typeof import('../socket/groupCalls');
      calls.attachCallHandlers();
      groupCalls.attachGroupCallHandlers();
    }
  } catch { /* webrtc/runtime not available — socket reconnect still drains messages */ }

  // Hold the runtime open briefly so auth completes and any in-flight heartbeat
  // can deliver its notification before the OS suspends us again.
  await new Promise<void>((resolve) => setTimeout(resolve, HOLD_MS));
}

// Define the task at MODULE LOAD so it exists before a headless launch fires it.
// (index.ts imports this module early, alongside the React entry point.)
(function defineBackgroundReconnectTask() {
  try {
    const TaskManager = require('expo-task-manager') as typeof import('expo-task-manager');
    if (TaskManager.isTaskDefined(BG_NOTIFICATION_TASK)) return;
    TaskManager.defineTask(BG_NOTIFICATION_TASK, async ({ data, error }: { data?: unknown; error?: unknown }) => {
      if (error) return;
      try {
        const kind = extractKind(data);
        // Our server only ever sends these two; ignore anything else.
        if (kind && kind !== 'wakeup' && kind !== 'call_wakeup') return;
        await wakeAndReconnect();
      } catch { /* best effort — never throw out of a background task */ }
    });
  } catch { /* expo-task-manager unavailable (Expo Go) — no background wake */ }
})();

/**
 * Route remote background notifications to BG_NOTIFICATION_TASK. Safe to call
 * repeatedly; registration is idempotent and persisted by the OS. Called from
 * registerForPush once notification permission is granted.
 */
export async function registerBackgroundReconnect(): Promise<void> {
  try {
    const Notifications = require('expo-notifications') as typeof import('expo-notifications');
    await Notifications.registerTaskAsync(BG_NOTIFICATION_TASK);
  } catch (e) {
    if (__DEV__) logger.warn('[push] background reconnect task registration failed:', (e as Error).message);
  }
}
