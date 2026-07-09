/**
 * iOS VoIP push (PushKit) — wake the app to ring even when fully killed.
 *
 * Flow when the callee's app is not running:
 *   1. Relay sends a VoIP push (APNs, `apns-push-type: voip`) to the device.
 *   2. iOS launches the app in the background and delivers it here.
 *   3. We MUST report the call to CallKit *synchronously* in the `notification`
 *      handler (Apple platform rule — failing to do so makes iOS kill the app
 *      and, repeated, revoke the VoIP entitlement). `displayIncomingCall` does
 *      exactly that. See src/calls/callkeep.ts.
 *   4. The app's socket reconnects, receives the real (sealed) `call:invite`,
 *      and the normal in-app call flow takes over — same callId, deduped.
 *
 * ── Zero-metadata ─────────────────────────────────────────────────────────────
 * The VoIP push payload carries a random `callId` (a UUID that reveals nothing)
 * plus a coarse `media` hint ('audio' | 'video', so CallKit picks the right UI).
 * Nothing identifying: no sender, no recipient, no content. The relay never sees
 * who is calling whom; that stays sealed inside `call:invite`.
 *
 * ── Security ──────────────────────────────────────────────────────────────────
 * The VoIP token is registered ONLY over the authenticated Socket.IO channel
 * (`voip:register`, after the Ed25519 challenge-response), NEVER via an
 * unauthenticated HTTP endpoint. Knowing an aegisId must not let anyone bind a
 * push token to it (security golden rule #3).
 *
 * The native module (@react-native-voip-push-notification) is loaded via dynamic
 * require: it is iOS-only and absent from Expo Go / Android bundles, so a static
 * import would break those builds.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { logger } from '../utils/logger';
import { IS_EXPO_GO } from '../runtime';
import { displayIncomingCall } from './callkeep';

const VOIP_TOKEN_KEY = 'aegis.voipToken';
const VOIP_TOKEN_SENT_KEY = 'aegis.voipToken.sent';

// VoIP push is DISABLED until the native AppDelegate wiring is re-enabled via an
// Objective-C bridging header (see withIosVoip.js — withAppDelegateVoip is not
// applied because Swift can't import the ObjC pod). Without that native wiring,
// calling the library's JS registerVoipToken() still triggers native PushKit
// registration, and its success callback hits an unrecognized selector →
// -[PKPushRegistry voipRegistrationSucceededWithDeviceToken:] → SIGABRT crash
// right after identity generation (confirmed on iOS 16.7, TestFlight build 12).
// VoIP push isn't live yet anyway (the relay APNS_* key is unset). Flip
// VOIP_NATIVE_WIRED to true together with the withIosVoip bridging-header work.
const VOIP_NATIVE_WIRED: boolean = false;
const VOIP_ENABLED = VOIP_NATIVE_WIRED && Platform.OS === 'ios' && !IS_EXPO_GO;

/** Minimal shape of the native module we depend on (dynamically required). */
interface VoipPushModule {
  registerVoipToken(): void;
  onVoipNotificationCompleted(uuid: string): void;
  addEventListener(type: 'register', handler: (token: string) => void): void;
  addEventListener(type: 'notification', handler: (payload: VoipPayload) => void): void;
  addEventListener(
    type: 'didLoadWithEvents',
    handler: (events: Array<{ name: string; data: unknown }>) => void,
  ): void;
}

/** The custom aps payload we send from the relay — intentionally minimal. */
interface VoipPayload {
  callId?: string;
  /** Present only so CallKit can pick the right UI; optional by design. */
  media?: 'audio' | 'video';
  /** iOS-supplied completion handle for onVoipNotificationCompleted. */
  uuid?: string;
}

let _listenersBound = false;

function loadModule(): VoipPushModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-voip-push-notification');
    return (mod?.default ?? mod) as VoipPushModule;
  } catch {
    // Package not installed (Expo Go / Android / not yet added) — silent no-op.
    return null;
  }
}

function newUuid(): string {
  try {
    const Crypto = require('expo-crypto') as typeof import('expo-crypto');
    return Crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** Report an incoming VoIP push to CallKit immediately (Apple requirement). */
function handleVoipPayload(payload: VoipPayload): void {
  const callId = payload.callId ?? newUuid();
  // Generic labels are enforced inside displayIncomingCall — nothing
  // identifying is passed here regardless.
  displayIncomingCall(callId, '', '', payload.media === 'video');
}

/**
 * Set up PushKit: register the VoIP token (over the authenticated socket) and
 * wire incoming VoIP pushes to CallKit. Idempotent; call once at app start.
 * No-op on Android / Expo Go.
 */
export function registerVoIPToken(): void {
  if (!VOIP_ENABLED || _listenersBound) return;
  const VoipPushNotification = loadModule();
  if (!VoipPushNotification) return;
  _listenersBound = true;

  VoipPushNotification.addEventListener('register', (token: string) => {
    void (async () => {
      try {
        await SecureStore.setItemAsync(VOIP_TOKEN_KEY, token);
        await flushVoipToken();
      } catch (e) {
        logger.warn('[voip] token cache failed', e);
      }
    })();
  });

  VoipPushNotification.addEventListener('notification', (payload: VoipPayload) => {
    // MUST happen synchronously, before returning, or iOS terminates the app.
    handleVoipPayload(payload);
    if (payload.uuid) {
      try {
        VoipPushNotification.onVoipNotificationCompleted(payload.uuid);
      } catch {
        /* best-effort completion signal */
      }
    }
  });

  // Cold start: the app was launched *by* a VoIP push before JS listeners were
  // attached. Replay the queued register/notification events now.
  VoipPushNotification.addEventListener('didLoadWithEvents', (events) => {
    for (const evt of events) {
      if (evt.name === 'RNVoipPushRemoteNotificationsRegisteredEvent') {
        const token = evt.data as string;
        void SecureStore.setItemAsync(VOIP_TOKEN_KEY, token).then(() => flushVoipToken());
      } else if (evt.name === 'RNVoipPushRemoteNotificationReceivedEvent') {
        handleVoipPayload(evt.data as VoipPayload);
      }
    }
  });

  try {
    VoipPushNotification.registerVoipToken();
  } catch (e) {
    logger.warn('[voip] registerVoipToken failed', e);
  }
}

/**
 * Emit the cached VoIP token to the relay over the authenticated socket, if it
 * changed since the last successful registration. Called both when a fresh
 * token arrives and after every socket auth (client.ts), so a token obtained
 * before the socket was ready still gets registered on connect.
 */
export async function flushVoipToken(): Promise<void> {
  if (!VOIP_ENABLED) return;
  try {
    const token = await SecureStore.getItemAsync(VOIP_TOKEN_KEY);
    if (!token) return;

    const { getSocket, isConnected } = require('../socket/client') as typeof import('../socket/client');
    if (!isConnected()) return;
    const socket = getSocket();
    if (!socket) return;

    const sent = await SecureStore.getItemAsync(VOIP_TOKEN_SENT_KEY);
    if (sent === token) return; // already registered this exact token

    // Wait for the relay to ACK the write before caching as "sent". A
    // fire-and-forget emit that gets dropped (or a silent server-side write
    // failure) would otherwise set VOIP_TOKEN_SENT_KEY permanently and block
    // re-registration of a valid token. On no-ack we leave it unsent so the
    // next socket auth (client.ts calls flushVoipToken again) retries.
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const timer = setTimeout(() => done(false), 8_000);
      socket.emit('voip:register', { token, platform: 'ios' }, (res: { ok?: boolean } | undefined) => {
        clearTimeout(timer);
        done(res?.ok === true);
      });
    });
    if (ok) await SecureStore.setItemAsync(VOIP_TOKEN_SENT_KEY, token);
  } catch (e) {
    logger.warn('[voip] flush failed', e);
  }
}
