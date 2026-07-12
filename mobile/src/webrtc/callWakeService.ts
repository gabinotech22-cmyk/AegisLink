/**
 * Android persistent call-wake foreground service control.
 *
 * docs/FASE4-CALL-WAKE-DESIGN.md: to ring an incoming call with the app killed
 * WITHOUT Google/FCM, Android needs the app process kept resident by a
 * foreground service (iOS is forced onto VoIP/APNs and does not use this). This
 * wraps the native AegisWakeService (HeadlessJsTaskService, type=dataSync):
 * `startCallWakeService` posts the persistent notification and starts the
 * headless "AegisCallWake" task; `stopCallWakeService` tears it down.
 *
 * No-op on iOS and anywhere the native module is absent (Expo Go / tests). The
 * persistent notification + battery cost are the accepted trade-off of the
 * zero-Google design; gated behind the `callWakeService` preference so users can
 * turn it off.
 */
import { NativeModules, Platform } from 'react-native';

interface AegisWakeNative {
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
}

function native(): AegisWakeNative | null {
  if (Platform.OS !== 'android') return null;
  const m = (NativeModules as Record<string, unknown>).AegisWakeService;
  return (m as AegisWakeNative) ?? null;
}

let _running = false;

export function startCallWakeService(): void {
  const m = native();
  if (!m || _running) return;
  _running = true;
  m.start().catch(() => {
    // start failed (OEM restriction / missing permission) — allow a later retry.
    _running = false;
  });
}

export function stopCallWakeService(): void {
  const m = native();
  if (!m || !_running) return;
  _running = false;
  m.stop().catch(() => { /* ignore */ });
}

/** Test/introspection helper: whether we believe the service is running. */
export function isCallWakeServiceRunning(): boolean {
  return _running;
}
