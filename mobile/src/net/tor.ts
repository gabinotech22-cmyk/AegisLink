/**
 * AegisLink — embedded Tor bridge (sealed-sender Fase 4 Tier 2, mobile).
 *
 * Thin JS wrapper over the native `AegisTor` module (plugins/withTorEmbedded.js),
 * which embeds Guardian Project's C-Tor so the mailbox transport can route over
 * Tor without Orbot. See docs/FASE4-TOR-EMBEDDED-IMPL.md.
 *
 * Scope: F1 — Tor lifecycle (start / status / stop / bootstrap events). The F2
 * socket.io-over-SOCKS transport (`TorSioSocket`) lands here next, backed by the
 * same native module's generic socket bridge.
 *
 * The native module is ONLY present in a prebuilt release/dev-client APK — never
 * in Expo Go. Every accessor fails soft (Tor unavailable → state 'off') so the
 * app degrades to the aegisId transport instead of crashing, matching the
 * fail-closed posture of MAILBOX_ENABLED (config.ts).
 */
import { NativeModules, NativeEventEmitter, type EmitterSubscription } from 'react-native';
import { logger } from '../utils/logger';

export type TorState = 'off' | 'starting' | 'stopping' | 'on';

export interface TorStatus {
  /** Current Tor process state. */
  state: TorState;
  /** Local SOCKS5 proxy port (0 until `state === 'on'`). */
  socksPort: number;
}

interface AegisTorNative {
  start(): Promise<TorStatus>;
  getStatus(): Promise<TorStatus>;
  stop(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const Native = (NativeModules as { AegisTor?: AegisTorNative }).AegisTor ?? null;
const emitter = Native ? new NativeEventEmitter(Native as unknown as never) : null;

const OFF: TorStatus = { state: 'off', socksPort: 0 };

/** True when the embedded Tor native module is present (prebuilt APK only). */
export function isTorAvailable(): boolean {
  return Native !== null;
}

/**
 * Start the embedded Tor and resolve once it has bootstrapped (STATUS_ON),
 * returning the local SOCKS port. Rejects on native error. No-op-safe: throws a
 * typed error when the native module is absent so callers can fall back.
 */
export async function startTor(): Promise<TorStatus> {
  if (!Native) throw new Error('[tor] native module unavailable (Expo Go or non-prebuilt build)');
  const status = await Native.start();
  if (__DEV__) logger.debug('[tor] started:', status.state, 'socks', status.socksPort);
  return status;
}

/** Current Tor status without starting it. Returns OFF when unavailable. */
export async function torStatus(): Promise<TorStatus> {
  if (!Native) return OFF;
  try {
    return await Native.getStatus();
  } catch (e) {
    if (__DEV__) logger.warn('[tor] getStatus failed:', (e as Error).message);
    return OFF;
  }
}

/** Stop the embedded Tor. Best-effort; safe to call when unavailable. */
export async function stopTor(): Promise<void> {
  if (!Native) return;
  try {
    await Native.stop();
  } catch (e) {
    if (__DEV__) logger.warn('[tor] stop failed:', (e as Error).message);
  }
}

/**
 * Subscribe to Tor bootstrap/status updates. Returns an unsubscribe function.
 * No-op (returns a noop unsubscribe) when the native module is absent.
 */
export function onTorStatus(cb: (status: TorStatus) => void): () => void {
  if (!emitter) return () => {};
  const sub: EmitterSubscription = emitter.addListener('AegisTorStatus', cb);
  return () => sub.remove();
}
