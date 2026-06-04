/**
 * Native telecom integration (react-native-callkeep) — DISABLED.
 *
 * AegisLink deliberately does NOT register a system PhoneAccount /
 * ConnectionService. Two reasons:
 *
 *  1. Privacy (core principle: zero metadata). CallKeep registers the app with
 *     Android's telecom framework, which can surface calls in the OS call log
 *     and expose call events to the system — exactly the kind of metadata trail
 *     AegisLink promises never to leave.
 *
 *  2. Stability. On Android 14+ `RNCallKeep.setup()` → `registerPhoneAccount()`
 *     throws an uncatchable native `SecurityException`
 *     (BIND_TELECOM_CONNECTION_SERVICE) that crashes the whole app on launch.
 *
 * Incoming/active calls are handled entirely by the in-app UI, driven by the
 * call store (`useCall.startIncoming` in socket/calls.ts) plus a heads-up push
 * notification when the app is backgrounded. These functions are kept as no-ops
 * so the call signalling code can call them unconditionally without branching.
 */

/** No-op: native telecom integration is intentionally disabled. */
export function initCallKeep(): void {
  /* intentionally empty — see file header */
}

/** No-op: incoming calls are shown by the in-app UI (useCall store) + push. */
export function displayIncomingCall(
  _callId: string,
  _handle: string,
  _name: string,
  _isVideo: boolean,
): void {
  /* intentionally empty */
}

/** No-op: call state is reflected by the in-app UI. */
export function reportCallConnected(_callId: string): void {
  /* intentionally empty */
}

/** No-op: hang-up is handled in-app. */
export function endNativeCall(_callId: string): void {
  /* intentionally empty */
}

/** No-op: mute is reflected by the in-app UI. */
export function setNativeMuted(_callId: string, _muted: boolean): void {
  /* intentionally empty */
}
