/**
 * Native telecom integration (react-native-callkeep).
 *
 *  • iOS  → ENABLED. CallKit is mandatory: Apple kills any app that receives a
 *    PushKit (VoIP) push without immediately reporting the call to CallKit, and
 *    App Review rejects PushKit-without-CallKit apps outright (since iOS 13). So
 *    the moment we want VoIP wake-ups (app killed → ring), CallKit is not
 *    optional. See src/calls/voip-push.ts.
 *
 *  • Android → DISABLED (unchanged, deliberate). Two reasons, both still valid:
 *      1. Privacy: registering an Android telecom PhoneAccount /
 *         ConnectionService surfaces calls in the OS call log — exactly the
 *         metadata trail AegisLink promises never to leave.
 *      2. Stability: on Android 14+ `registerPhoneAccount()` throws an
 *         uncatchable native SecurityException that crashes the app on launch.
 *    Android keeps handling calls entirely in-app (useCall store + heads-up push).
 *
 * ── Zero-metadata on iOS ──────────────────────────────────────────────────────
 * CallKit *does* draw a system call UI (full-screen incoming, lock-screen), but
 * we feed it NOTHING identifying:
 *   • `includesCallsInRecents: false` keeps every call OUT of the iOS Recents /
 *     system call history. Nothing is written to the OS call log.
 *   • The handle + caller name shown are GENERIC constants — never the peer's
 *     aegisId or contact name. The real identity stays sealed in the encrypted
 *     `call:invite` and is only surfaced by the in-app UI after the socket
 *     reconnects. The OS learns "a call happened", never "with whom".
 *
 * These functions are safe to call unconditionally from the call-signalling code
 * (socket/calls.ts): on Android and on non-native runtimes they are no-ops.
 */
import { Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import { logger } from '../utils/logger';
import { IS_EXPO_GO } from '../runtime';

// Native CallKit is only available on a real iOS build (not Expo Go, which lacks
// the native module and would throw on setup()).
const CALLKIT_ENABLED = Platform.OS === 'ios' && !IS_EXPO_GO;

/**
 * Generic, non-identifying labels shown on the native iOS call UI and lock
 * screen. We deliberately NEVER pass the caller's aegisId or contact name to
 * CallKit — that would leak identity into the OS layer (Recents, lock screen,
 * Siri suggestions). Zero metadata: the OS sees a call, never who it is with.
 */
const GENERIC_HANDLE = 'aegislink';
const GENERIC_CALLER = 'Llamada cifrada · E2EE';

let _setupDone = false;
let _listenersBound = false;

/** UUIDs we have already handed to CallKit — dedupe so a PushKit wake-up and the
 *  subsequent socket `call:invite` (same callId) don't display twice. */
const _displayed = new Set<string>();

/**
 * Initialise CallKit (iOS only). Idempotent. Called once at app start after the
 * identity is loaded (App.tsx). On Android / Expo Go this returns immediately.
 */
export function initCallKeep(): void {
  if (!CALLKIT_ENABLED || _setupDone) return;
  _setupDone = true;

  RNCallKeep.setup({
    ios: {
      appName: 'AegisLink',
      supportsVideo: true,
      maximumCallGroups: '1',
      maximumCallsPerCallGroup: '1',
      // The single most important privacy switch: never write calls to the iOS
      // system call history (Recents). Zero metadata at the OS layer.
      includesCallsInRecents: false,
    },
    // Android block is required by the type but never exercised — setup() is
    // guarded to iOS above, so no PhoneAccount / ConnectionService is registered.
    android: {
      alertTitle: '',
      alertDescription: '',
      cancelButton: '',
      okButton: '',
      additionalPermissions: [],
    },
  })
    .then(() => bindListeners())
    .catch((e) => logger.warn('[callkeep] setup failed', e));
}

/**
 * Bridge CallKit's native actions (green "answer", red "decline/end", mute
 * toggle on the system UI / lock screen) back into the app's call flow.
 */
function bindListeners(): void {
  if (_listenersBound) return;
  _listenersBound = true;

  RNCallKeep.addEventListener('answerCall', () => {
    // User accepted from the native iOS call UI (possibly from a killed state,
    // driven by a PushKit wake-up). Drive the same path as the in-app Accept.
    try {
      const { acceptCall } = require('../socket/calls') as typeof import('../socket/calls');
      void acceptCall();
    } catch (e) {
      logger.warn('[callkeep] answerCall bridge failed', e);
    }
  });

  RNCallKeep.addEventListener('endCall', () => {
    // User tapped decline/end on the native UI. Signal the peer + tear down.
    try {
      const { endCall } = require('../socket/calls') as typeof import('../socket/calls');
      endCall('hangup');
    } catch (e) {
      logger.warn('[callkeep] endCall bridge failed', e);
    }
  });

  RNCallKeep.addEventListener('didPerformSetMutedCallAction', ({ muted }) => {
    // User toggled mute from the native call UI. Sync app state, but only if it
    // actually differs — toggleMute() re-applies to CallKit, so guarding avoids
    // a feedback loop with setNativeMuted().
    try {
      const { useCall } = require('../store/call') as typeof import('../store/call');
      if (useCall.getState().muted === muted) return;
      const { toggleMute } = require('../socket/calls') as typeof import('../socket/calls');
      toggleMute();
    } catch (e) {
      logger.warn('[callkeep] mute bridge failed', e);
    }
  });

  RNCallKeep.addEventListener('didActivateAudioSession', () => {
    // CallKit owns the AVAudioSession lifecycle when a call is active. Once it
    // activates the session, ensure our WebRTC audio tracks are live (they may
    // have been created before the session was ready). react-native-webrtc
    // handles the category/mode; we only re-assert track enablement here.
    try {
      const { useCall } = require('../store/call') as typeof import('../store/call');
      const { activePeer, muted } = useCall.getState();
      const stream = activePeer?.localStream;
      if (stream) {
        for (const track of stream.getAudioTracks()) track.enabled = !muted;
      }
    } catch (e) {
      logger.warn('[callkeep] audio session bridge failed', e);
    }
  });
}

/**
 * Show the native incoming-call UI. On iOS this is REQUIRED immediately after a
 * PushKit wake-up (Apple platform rule). `handle`/`name` from the caller are
 * intentionally ignored — we always display generic, non-identifying labels so
 * no identity reaches the OS. Idempotent per callId.
 */
export function displayIncomingCall(
  callId: string,
  _handle: string,
  _name: string,
  isVideo: boolean,
): void {
  if (!CALLKIT_ENABLED) return;
  if (_displayed.has(callId)) return;
  _displayed.add(callId);
  try {
    RNCallKeep.displayIncomingCall(callId, GENERIC_HANDLE, GENERIC_CALLER, 'generic', isVideo);
  } catch (e) {
    _displayed.delete(callId);
    logger.warn('[callkeep] displayIncomingCall failed', e);
  }
}

/** Mark the CallKit call as connected (call answered + media flowing). */
export function reportCallConnected(callId: string): void {
  if (!CALLKIT_ENABLED) return;
  try {
    RNCallKeep.setCurrentCallActive(callId);
  } catch (e) {
    logger.warn('[callkeep] setCurrentCallActive failed', e);
  }
}

/** Dismiss the native call UI (call ended locally or remotely). */
export function endNativeCall(callId: string): void {
  _displayed.delete(callId);
  if (!CALLKIT_ENABLED) return;
  try {
    RNCallKeep.endCall(callId);
  } catch (e) {
    logger.warn('[callkeep] endCall failed', e);
  }
}

/** Reflect the app's mute state on the native call UI. */
export function setNativeMuted(callId: string, muted: boolean): void {
  if (!CALLKIT_ENABLED) return;
  try {
    RNCallKeep.setMutedCall(callId, muted);
  } catch (e) {
    logger.warn('[callkeep] setMutedCall failed', e);
  }
}
