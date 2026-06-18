/**
 * In-call audio session + proximity wrapper (react-native-incall-manager).
 *
 * Why this exists, and why it is `require`-guarded:
 *   InCallManager is a native module — absent in Expo Go / unit tests / any JS
 *   runtime without the compiled binary. Every call site degrades gracefully
 *   (no-op) instead of throwing, mirroring the expo-av / expo-keep-awake guards
 *   elsewhere in the call stack.
 *
 * What `start({ media: 'audio' })` buys us for group voice channels:
 *   - Proximity sensor → the OS BLANKS the screen and IGNORES touches while the
 *     phone is at the ear (both iOS and Android). This is the real fix for "a
 *     cheek hangs up the call" — brightness-dimming alone never blocked touches.
 *   - A managed audio session routed to the earpiece by default (speaker is an
 *     explicit toggle), with the wake-lock the OS needs to keep audio flowing.
 *
 * Privacy note: InCallManager keeps NO logs and emits nothing over the network;
 * it only touches the local audio session and sensors.
 */

interface InCallManagerModule {
  start: (opts: { media: 'audio' | 'video'; auto?: boolean; ringback?: string }) => void;
  stop: (opts?: { busytone?: string }) => void;
  setForceSpeakerphoneOn: (flag: boolean) => void;
  setSpeakerphoneOn: (flag: boolean) => void;
  setKeepScreenOn: (flag: boolean) => void;
}

let _mod: InCallManagerModule | null | undefined;

function inCallManager(): InCallManagerModule | null {
  if (_mod !== undefined) return _mod;
  try {
    // Default export.
    const m = require('react-native-incall-manager') as { default: InCallManagerModule };
    _mod = m.default ?? (m as unknown as InCallManagerModule);
  } catch {
    _mod = null;
  }
  return _mod;
}

let _started = false;

/**
 * Begin an in-call session.
 *   - 'audio': earpiece route + proximity sensor ON (screen blanks at the ear).
 *   - 'video': speaker route + proximity sensor OFF (you're looking at the screen).
 * Idempotent — safe to call again if a second leg of the mesh connects.
 */
export function startInCallAudio(media: 'audio' | 'video' = 'audio'): void {
  const m = inCallManager();
  if (!m || _started) return;
  try {
    m.start({ media, auto: true });
    // Audio → earpiece by default (user can toggle speaker); video → speaker.
    m.setForceSpeakerphoneOn(media === 'video');
    _started = true;
  } catch {
    /* native call failed — leave _started false so a retry is possible */
  }
}

/** End the in-call session: releases proximity sensor, wake-lock, audio focus. */
export function stopInCallAudio(): void {
  const m = inCallManager();
  if (!m || !_started) return;
  try {
    m.stop();
  } catch {
    /* ignore */
  }
  _started = false;
}

/** Toggle the earpiece/speaker route for an active audio call. */
export function setInCallSpeaker(on: boolean): void {
  const m = inCallManager();
  if (!m) return;
  try {
    m.setForceSpeakerphoneOn(on);
  } catch {
    /* ignore */
  }
}
