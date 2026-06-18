/**
 * Android foreground-service control for live calls.
 *
 * On Android 12+ a backgrounded app with an active mic/WebRTC session is killed
 * within seconds unless a foreground service (type = microphone) holds it alive
 * with a persistent notification. `startCallService` posts that notification;
 * `stopCallService` removes it. No-op on iOS (UIBackgroundModes voip/audio in
 * app.json already keeps audio alive there) and anywhere the native module is
 * absent (Expo Go / tests).
 */
import { NativeModules, Platform } from 'react-native';

interface AegisCallServiceNative {
  start: (title: string, text: string) => Promise<boolean>;
  stop: () => Promise<boolean>;
}

function native(): AegisCallServiceNative | null {
  if (Platform.OS !== 'android') return null;
  const m = (NativeModules as Record<string, unknown>).AegisCallService;
  return (m as AegisCallServiceNative) ?? null;
}

let _running = false;

export function startCallService(title: string, text: string): void {
  const m = native();
  if (!m || _running) return;
  _running = true;
  m.start(title, text).catch(() => {
    // start failed (e.g. permission/OEM restriction) — allow a later retry.
    _running = false;
  });
}

export function stopCallService(): void {
  const m = native();
  if (!m || !_running) return;
  _running = false;
  m.stop().catch(() => { /* ignore */ });
}
