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
// TYPE-ONLY import — erased at compile time, so it never triggers a runtime
// `require` of the native module. See callKeep() below for why that matters.
import type RNCallKeepModule from 'react-native-callkeep';
import { logger } from '../utils/logger';
import { IS_EXPO_GO } from '../runtime';

type RNCallKeepType = typeof RNCallKeepModule;

// Native CallKit is only available on a real iOS build (not Expo Go, which lacks
// the native module and would throw on setup()).
const CALLKIT_ENABLED = Platform.OS === 'ios' && !IS_EXPO_GO;

/**
 * Lazily load react-native-callkeep — ONLY ever on a real iOS runtime.
 *
 * A STATIC `import` is fatal: the library's module init runs
 * `new NativeEventEmitter(NativeModules.RNCallKeep)` at load time, and under the
 * New Architecture (`newArchEnabled: true`) its Android native module fails
 * TurboModule parsing (it exports two @ReactMethods named "displayIncomingCall"),
 * which crashes the app on launch on Android — and throws "NativeEventEmitter
 * requires a non-null argument" under Jest. So we must never even `require` it
 * off iOS. Callers gate on CALLKIT_ENABLED first, so callKeep() only runs on iOS.
 *
 * The try/catch also degrades gracefully: if the module can't initialise (e.g. a
 * New-Arch incompatibility surfaces on iOS too — validate on the first EAS
 * build), CallKit is simply disabled rather than crashing the app.
 */
let _callKeep: RNCallKeepType | null | undefined;
function callKeep(): RNCallKeepType | null {
  if (_callKeep !== undefined) return _callKeep;
  try {
    _callKeep = (require('react-native-callkeep') as { default: RNCallKeepType }).default;
  } catch (e) {
    logger.warn('[callkeep] native module unavailable', e);
    _callKeep = null;
  }
  return _callKeep;
}

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
  const RNCallKeep = callKeep();
  if (!RNCallKeep) return;

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
    .then(() => {
      // Only latch _setupDone on success so a transient setup failure can be
      // retried on the next initCallKeep() (App.tsx re-runs on identity change).
      // CallKit is mandatory for VoIP wake-ups, so silent permanent disable
      // would break incoming-call ringing for the whole session.
      _setupDone = true;
      bindListeners(RNCallKeep);
    })
    .catch((e) => logger.warn('[callkeep] setup failed', e));
}

/**
 * Bridge CallKit's native actions (green "answer", red "decline/end", mute
 * toggle on the system UI / lock screen) back into the app's call flow.
 */
function bindListeners(RNCallKeep: RNCallKeepType): void {
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
 * True when CallKit is the platform's incoming-call surface on this runtime
 * (a real iOS build). Callers use it to pick exactly ONE ring surface: CallKit
 * where it exists, our own heads-up notification everywhere else (Android, where
 * CallKit is deliberately disabled, and Expo Go, which has no native module).
 * Showing both is what produced the "two competing call UIs" bug.
 */
export function isCallKitAvailable(): boolean {
  return CALLKIT_ENABLED && callKeep() !== null;
}

/**
 * True when CallKit currently owns the incoming-call UI for `callId` — i.e. we
 * reported this call to the system and it has not been torn down yet. When it is
 * true, the OS (not us) owns the audio session, so answering MUST go through
 * answerNativeCall(). See the audio note there.
 */
export function hasNativeCall(callId: string): boolean {
  return _displayed.has(callId);
}

/**
 * Record that NATIVE code already reported `callId` to CallKit — specifically,
 * the PushKit delegate that rang this call before JS was even alive (see
 * calls/voip-push.ts). Without this the socket's later `call:invite` for the
 * same call would report the same UUID to CallKit a second time, and the answer
 * would be routed against a call JS believes it never displayed.
 */
export function markNativelyDisplayed(callId: string): void {
  _displayed.add(callId);
}

/**
 * Tell CallKit the call was answered, when the user accepted from OUR UI rather
 * than from the system call UI.
 *
 * This is what makes the audio work. CallKit owns the AVAudioSession for any
 * call it is displaying, and it only activates that session when the
 * CXAnswerCallAction is FULFILLED — which happens inside the provider's
 * performAnswerCallAction, and nowhere else. Answering from our own screen while
 * CallKit still had the call "ringing" left the session inactive: WebRTC
 * connected, both sides showed an in-call UI, and NOBODY could hear anything.
 * (`setCurrentCallActive`, which we do call once media connects, maps to
 * reportOutgoingCall(connectedAt:) — it is for OUTGOING calls and never
 * activates anything, which is why outgoing calls were always audible and only
 * incoming ones were silent.)
 *
 * No-op when CallKit never displayed this call (foreground path: our screen rang
 * it, so our own audio session handling applies, exactly like an outgoing call).
 */
export function answerNativeCall(callId: string): void {
  if (!CALLKIT_ENABLED) return;
  if (!_displayed.has(callId)) return;
  const RNCallKeep = callKeep();
  if (!RNCallKeep) return;
  try {
    RNCallKeep.answerIncomingCall(callId);
  } catch (e) {
    logger.warn('[callkeep] answerIncomingCall failed', e);
  }
}

/**
 * Show the native incoming-call UI. On iOS this is REQUIRED immediately after a
 * PushKit wake-up (Apple platform rule). `handle`/`name` from the caller are
 * intentionally ignored — we always display generic, non-identifying labels so
 * no identity reaches the OS. Idempotent per callId.
 *
 * Only call this when the app is NOT in the foreground: with the app open our
 * own IncomingCallScreen is the ring surface, and reporting the call to CallKit
 * as well both duplicates the UI and hijacks the audio session (see
 * answerNativeCall). Enforced at the call site in socket/calls.ts.
 */
export function displayIncomingCall(
  callId: string,
  _handle: string,
  _name: string,
  isVideo: boolean,
): void {
  if (!CALLKIT_ENABLED) return;
  const RNCallKeep = callKeep();
  if (!RNCallKeep) return;
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
  const RNCallKeep = callKeep();
  if (!RNCallKeep) return;
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
  const RNCallKeep = callKeep();
  if (!RNCallKeep) return;
  try {
    RNCallKeep.endCall(callId);
  } catch (e) {
    logger.warn('[callkeep] endCall failed', e);
  }
}

/** Reflect the app's mute state on the native call UI. */
export function setNativeMuted(callId: string, muted: boolean): void {
  if (!CALLKIT_ENABLED) return;
  const RNCallKeep = callKeep();
  if (!RNCallKeep) return;
  try {
    RNCallKeep.setMutedCall(callId, muted);
  } catch (e) {
    logger.warn('[callkeep] setMutedCall failed', e);
  }
}
