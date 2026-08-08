/**
 * iOS VoIP push (PushKit) — ring the app even when it is fully killed.
 *
 * Flow when the callee's app is not running:
 *   1. Relay sends a VoIP push (APNs, `apns-push-type: voip`) to the device.
 *   2. iOS launches the app in the background and hands the push to our native
 *      PKPushRegistry delegate (AegisVoipPush, injected by plugins/withIosVoip.js).
 *   3. That delegate reports the call to CallKit *synchronously, natively* —
 *      Apple's platform rule, and the only thing that can work here since JS is
 *      not running yet. The phone rings.
 *   4. The app's socket reconnects, receives the real (sealed) `call:invite`,
 *      and the normal in-app flow takes over — same callId, deduped.
 *
 * ── Why there is no library here ──────────────────────────────────────────────
 * `react-native-voip-push-notification` (3.3.3, still the latest) emits its
 * events over the OLD RN bridge. Under the New Architecture (bridgeless) that
 * path is gone, so the token callback died with doesNotRecognizeSelector →
 * SIGABRT ~2 s after launch (confirmed on iOS 16.7 from a TestFlight .ips,
 * PRs #279/#280). Our native module never emits anything to JS: the push is
 * handled entirely in native code, and JS PULLS the token from here. That is
 * what makes this safe.
 *
 * ── Zero-metadata ─────────────────────────────────────────────────────────────
 * The VoIP payload carries a random `callId` (a UUID that reveals nothing) plus
 * a coarse `media` hint so CallKit picks the right UI. No sender, no recipient,
 * no content. The relay never sees who is calling whom.
 *
 * ── Security ──────────────────────────────────────────────────────────────────
 * The VoIP token is registered ONLY over the authenticated Socket.IO channel
 * (`voip:register`, after the Ed25519 challenge-response), NEVER via an
 * unauthenticated HTTP endpoint. Knowing an aegisId must not let anyone bind a
 * push token to it (security golden rule #3).
 */
import { Platform, NativeModules } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { logger } from '../utils/logger';
import { IS_EXPO_GO } from '../runtime';
import { markNativelyDisplayed } from './callkeep';

/** Last token we got the relay to ACK, so we don't re-register every auth. */
const VOIP_TOKEN_SENT_KEY = 'aegis.voipToken.sent';

// Native module is iOS-only and absent from Expo Go.
const VOIP_ENABLED = Platform.OS === 'ios' && !IS_EXPO_GO;

/** The pull-only native surface (see plugins/withIosVoip.js). */
interface AegisVoipPushModule {
  /** VoIP device token as lowercase hex, or null if not registered yet. */
  getToken(): Promise<string | null>;
  /** callId already reported to CallKit natively this launch, or null. */
  getLastReportedCallId(): Promise<string | null>;
  /** Re-arm PushKit registration (the AppDelegate already does it at launch). */
  ensureRegistered(): void;
}

function voipModule(): AegisVoipPushModule | null {
  if (!VOIP_ENABLED) return null;
  const mod = (NativeModules as Record<string, unknown>)['AegisVoipPush'];
  return (mod as AegisVoipPushModule | undefined) ?? null;
}

/**
 * Set up PushKit. The AppDelegate already registered at launch (it must, for a
 * cold start caused BY a call push); this re-arms it defensively and reconciles
 * the call CallKit may ALREADY be showing before JS was alive.
 * Idempotent; call once at app start. No-op on Android / Expo Go.
 */
export function registerVoIPToken(): void {
  const mod = voipModule();
  if (!mod) return;

  try {
    mod.ensureRegistered();
  } catch (e) {
    logger.warn('[voip] ensureRegistered failed', e);
  }

  void (async () => {
    try {
      // If this launch was caused by a VoIP push, CallKit is ALREADY showing
      // that call. Tell the JS layer so the socket's later call:invite doesn't
      // report the same UUID to CallKit a second time.
      const reported = await mod.getLastReportedCallId();
      if (reported) markNativelyDisplayed(reported);
    } catch (e) {
      logger.warn('[voip] lastReportedCallId failed', e);
    }
    // The socket may not be authenticated yet; flushVoipToken no-ops then and
    // client.ts calls it again after every auth.
    await flushVoipToken();
  })();
}

/**
 * Register the VoIP token with the relay over the authenticated socket, if it
 * changed since the last ACKed registration. Called at start-up and after every
 * socket auth (client.ts), so a token that arrived before the socket was ready
 * still gets registered on connect.
 */
export async function flushVoipToken(): Promise<void> {
  const mod = voipModule();
  if (!mod) return;
  try {
    const token = await mod.getToken();
    if (!token) return; // PushKit hasn't handed us a token yet — retry next auth

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
