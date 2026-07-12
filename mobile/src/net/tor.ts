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
  // F2 socket.io-over-SOCKS bridge.
  sioConnect(id: string, url: string, authJson: string, eventsJson: string): Promise<boolean>;
  sioEmit(id: string, event: string, payloadJson: string, ackId: string | null): Promise<boolean>;
  sioDisconnect(id: string): Promise<boolean>;
  // Slice 2b.2: ntfy topic subscription over Tor (dumb HTTP streaming pipe).
  httpSubscribe(id: string, url: string): Promise<boolean>;
  httpUnsubscribe(id: string): Promise<boolean>;
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
 * Bootstrap timeout: the native `start()` promise only resolves on STATUS_ON —
 * if Tor never bootstraps (no network, carrier/firewall blocking, cold first-run
 * fetching consensus) it would otherwise hang forever. 45s is generous for a
 * normal bootstrap but still bounds the fail-closed fallback to the aegisId
 * transport (mailboxSocket.ts) to a finite wait. Bootstrap continues natively
 * after we give up — a later `startTor()` call resolves immediately if it
 * eventually reaches STATUS_ON.
 */
const BOOTSTRAP_TIMEOUT_MS = 45_000;

/**
 * Start the embedded Tor and resolve once it has bootstrapped (STATUS_ON),
 * returning the local SOCKS port. Rejects on native error or bootstrap timeout.
 * No-op-safe: throws a typed error when the native module is absent so callers
 * can fall back.
 */
export async function startTor(): Promise<TorStatus> {
  if (!Native) throw new Error('[tor] native module unavailable (Expo Go or non-prebuilt build)');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('[tor] bootstrap timed out')), BOOTSTRAP_TIMEOUT_MS);
  });
  try {
    const status = await Promise.race([Native.start(), timeout]);
    if (__DEV__) logger.debug('[tor] started:', status.state, 'socks', status.socksPort);
    return status;
  } finally {
    clearTimeout(timer);
  }
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

// ─── Slice 2b.2: ntfy topic subscription over Tor ─────────────────────────────

/** Native bridge event payload for an HTTP stream line. */
interface HttpForward { id: string; event: 'open' | 'line' | 'close' | 'error'; line: string }

let _httpCounter = 0;

/**
 * Subscribe to an ntfy topic over Tor by streaming its `/<topic>/json` endpoint
 * on the relay's .onion. Each newline-delimited JSON line arrives via `onLine`
 * (the caller parses it and decides what a `message` event means — here: drain
 * the mailbox). `onError` fires on a dropped circuit / HTTP error so the caller
 * can re-subscribe. Returns an unsubscribe function. No-op (returns a noop) when
 * the native module is absent (Expo Go / non-prebuilt) — fail-closed like the
 * rest of the Tor layer.
 */
export function subscribeNtfyOverTor(
  url: string,
  onLine: (line: string) => void,
  onError?: (reason: string) => void,
): () => void {
  if (!Native || !emitter) return () => {};
  const id = `ntfy-${++_httpCounter}`;
  const sub: EmitterSubscription = emitter.addListener('AegisTorHttp', (p: HttpForward) => {
    if (p.id !== id) return;
    if (p.event === 'line') onLine(p.line);
    else if (p.event === 'error' || p.event === 'close') onError?.(p.event === 'error' ? p.line : 'closed');
  });
  void Native.httpSubscribe(id, url).catch((e: Error) => {
    if (__DEV__) logger.warn('[tor] httpSubscribe failed:', e.message);
    onError?.(e.message);
  });
  return () => {
    sub.remove();
    if (Native) void Native.httpUnsubscribe(id).catch(() => { /* best effort */ });
  };
}

// ─── F2: socket.io-over-Tor transport ─────────────────────────────────────────

/** Generic event/ack callback. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors socket.io-client's
// own listener typing: callers narrow each event's argument shape themselves.
type SioListener = (...args: any[]) => void;

/** Native bridge event payload (args is a JSON-encoded array). */
interface SioForward { id: string; event: string; args: string }

/** Custom socket.io events the mailbox protocol expects forwarded from native. */
const MAILBOX_FORWARD_EVENTS = ['mailbox:challenge', 'auth:ok', 'error_msg', 'envelope:mb'];

let _sioCounter = 0;

/**
 * A minimal socket.io-client-shaped transport backed by the native
 * socket.io-over-SOCKS bridge (every byte rides Tor). Implements exactly the
 * subset `mailboxSocket.ts` uses — `on` / `emit(+ack)` / `connected` /
 * `disconnect` / `removeAllListeners` — so the mailbox transport is a drop-in
 * swap for `io(ONION_URL)` with no protocol logic leaving JS.
 */
export class TorSioSocket {
  private readonly id: string;
  private readonly handlers = new Map<string, Set<SioListener>>();
  private readonly acks = new Map<string, SioListener>();
  private ackCounter = 0;
  private unsub: (() => void) | null = null;
  /** True between the native 'connect' and 'disconnect'/'connect_error' events. */
  public connected = false;

  constructor(url: string, auth: Record<string, unknown>) {
    if (!Native || !emitter) throw new Error('[tor] native module unavailable');
    this.id = `mbx-${++_sioCounter}`;
    const sub = emitter.addListener('AegisTorSio', (ev: SioForward) => {
      if (ev?.id === this.id) this.dispatch(ev.event, ev.args);
    });
    this.unsub = () => sub.remove();
    // socket.io-client-java handshake auth is Map<String,String>; non-string
    // values (the catch-up `binds` array) are pre-serialized to JSON strings —
    // the relay tolerates a stringified `binds` (see relay/handler.ts).
    const authStr: Record<string, string> = {};
    for (const [k, v] of Object.entries(auth)) {
      authStr[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    void Native.sioConnect(this.id, url, JSON.stringify(authStr), JSON.stringify(MAILBOX_FORWARD_EVENTS))
      .catch((e: Error) => { if (__DEV__) logger.warn('[tor] sioConnect failed:', e.message); });
  }

  private dispatch(event: string, argsJson: string): void {
    let args: unknown[] = [];
    try { const p: unknown = JSON.parse(argsJson); if (Array.isArray(p)) args = p; } catch { /* keep [] */ }
    if (event === 'connect') this.connected = true;
    else if (event === 'disconnect' || event === 'connect_error') this.connected = false;
    if (event.startsWith('__ack:')) {
      const cb = this.acks.get(event.slice('__ack:'.length));
      if (cb) { this.acks.delete(event.slice('__ack:'.length)); cb(...args); }
      return;
    }
    const set = this.handlers.get(event);
    if (set) for (const h of set) {
      try { h(...args); } catch (e) { if (__DEV__) logger.warn('[tor] sio handler threw:', e); }
    }
  }

  on(event: string, cb: SioListener): this {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(cb);
    return this;
  }

  emit(event: string, payload?: unknown, ack?: SioListener): this {
    if (!Native) return this;
    let ackId: string | null = null;
    if (ack) { ackId = `k${++this.ackCounter}`; this.acks.set(ackId, ack); }
    void Native.sioEmit(this.id, event, JSON.stringify(payload ?? {}), ackId)
      .catch((e: Error) => { if (__DEV__) logger.warn('[tor] sioEmit failed:', e.message); });
    return this;
  }

  removeAllListeners(): this {
    this.handlers.clear();
    this.acks.clear();
    return this;
  }

  disconnect(): this {
    this.connected = false;
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (Native) void Native.sioDisconnect(this.id).catch(() => { /* best effort */ });
    return this;
  }
}
