/**
 * Headless JS task backing the persistent call-wake foreground service.
 *
 * AegisWakeService (native, HeadlessJsTaskService) runs this task named
 * "AegisCallWake" whenever it (re)starts — on the user opting in, on a
 * START_STICKY restart, or from the boot receiver after a reboot. The task
 * hydrates identity, connects the relay socket over Tor and attaches the call
 * handlers, then returns a promise that stays pending so the service (and thus
 * the socket) keeps running. The persistent foreground notification keeps the
 * process resident; when the JS promise never resolves the service stays up
 * (native onHeadlessJsTaskFinish is a no-op).
 *
 * Duress: like the push wake path, NEVER connect while duress/decoy mode is
 * active — a connect would leak to the relay that panic mode is on.
 * Registration is a no-op unless the native task-registration API exists (i.e.
 * a prebuilt app, not Expo Go / jest).
 */
import { AppRegistry } from 'react-native';
import { logger } from '../utils/logger';

export const CALL_WAKE_TASK = 'AegisCallWake';

/** Connect + attach handlers, then hold the runtime open indefinitely. */
async function runCallWake(): Promise<void> {
  const { useIdentity } = require('../store/identity') as typeof import('../store/identity');

  // Cold headless start: hydrate preferences (duress gate) then identity,
  // mirroring the foreground boot order (same as backgroundReconnect).
  let duressActive = false;
  try {
    const { usePreferences } = require('../store/preferences') as {
      usePreferences: { getState: () => { duressActive?: boolean; hydrate?: () => Promise<void> } };
    };
    const prefs = usePreferences.getState();
    if (prefs.hydrate) await prefs.hydrate();
    duressActive = usePreferences.getState().duressActive === true;
  } catch { /* preferences unavailable — treat as no duress */ }
  if (duressActive) return; // never connect under duress

  const idState = useIdentity.getState();
  if (!idState.hydrated && idState.hydrate) {
    try { await idState.hydrate(); } catch { /* fall through — checked below */ }
  }
  const identity = useIdentity.getState().identity;
  if (!identity) return; // not registered yet — nothing to keep alive

  try {
    const client = require('../socket/client') as typeof import('../socket/client');
    if (!client.isConnected()) client.connect(identity);
    client.connectMailboxForIdentity(identity);
  } catch (e) {
    if (__DEV__) logger.warn('[callWake] connect failed:', (e as Error).message);
    return;
  }

  // Keep the headless task "running" so the foreground service stays up. The
  // socket lives on the JS runtime the foreground notification keeps resident;
  // teardown happens natively via ACTION_STOP (stopCallWakeService), which kills
  // the process/task — we do not need to resolve this ourselves.
  await new Promise<void>(() => { /* intentionally never resolves */ });
}

let _registered = false;

/** Register the headless task. Call once at module load (index.ts). */
export function registerCallWakeTask(): void {
  if (_registered) return;
  // AppRegistry.registerHeadlessTask exists in the RN runtime; guard for the
  // jest/Expo Go environments where the native side never invokes it anyway.
  if (typeof AppRegistry.registerHeadlessTask !== 'function') return;
  _registered = true;
  AppRegistry.registerHeadlessTask(CALL_WAKE_TASK, () => runCallWake);
}
