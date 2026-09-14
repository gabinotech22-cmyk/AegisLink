/**
 * AegisLink desktop — embedded Tor bridge (renderer side).
 *
 * Mirrors mobile/src/net/tor.ts: Tor itself runs in the Electron main process
 * (main/tor/torProcess.ts) and the WHOLE Chromium session is already proxied
 * through it, so ordinary fetch()/socket.io calls from the renderer ride Tor
 * with no changes. What this module adds:
 *
 *   - `useTor` — live bootstrap status for the UI (Splash / connection banner).
 *   - `TorSioSocket` — the mailbox delivery socket, bridged to main so it uses
 *     the ISOLATED mailbox SOCKS listener (separate circuits from the aegisId
 *     control socket). Same structural shape as socket.io-client's `Socket`
 *     subset that mailboxSocket.ts consumes, so that file changes one line.
 *
 * Fail-closed: there is no clearnet path anywhere in this module.
 */
import { create } from 'zustand';

export type TorState = 'off' | 'starting' | 'on' | 'error';

export interface TorStatus {
  state: TorState;
  progress: number;
  summary: string;
  controlSocksPort: number;
  mailboxSocksPort: number;
}

const OFF: TorStatus = { state: 'off', progress: 0, summary: '', controlSocksPort: 0, mailboxSocksPort: 0 };

function isTorStatus(v: unknown): v is TorStatus {
  return !!v && typeof v === 'object' && typeof (v as TorStatus).state === 'string' && typeof (v as TorStatus).progress === 'number';
}

interface TorStore {
  status: TorStatus;
  /** True once the bridge has been wired (idempotent init guard). */
  wired: boolean;
  init: () => void;
}

/** Zustand store with the live Tor status. Call `init()` once at app start. */
export const useTor = create<TorStore>((set, get) => ({
  status: OFF,
  wired: false,
  init: () => {
    if (get().wired || typeof window === 'undefined' || !window.aegis?.tor) return;
    set({ wired: true });
    window.aegis.tor.onStatus((s) => { if (isTorStatus(s)) set({ status: s }); });
    void window.aegis.tor.status().then((s) => { if (isTorStatus(s)) set({ status: s }); });
  },
}));

export function isTorOn(): boolean {
  return useTor.getState().status.state === 'on';
}

/** Resolves when Tor reports bootstrapped (never rejects — fail-closed wait). */
export function whenTorReady(): Promise<void> {
  if (isTorOn()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useTor.subscribe((s) => { if (s.status.state === 'on') { unsub(); resolve(); } });
  });
}

// ─── socket.io-over-Tor dumb pipe ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;
interface SioForward { id: string; event: string; args: unknown[]; ackId?: string }

let counter = 0;
const instances = new Map<string, TorSioSocket>();
let eventsWired = false;

function wireEvents(): void {
  if (eventsWired || typeof window === 'undefined' || !window.aegis?.tor) return;
  eventsWired = true;
  window.aegis.tor.onSioEvent((raw) => {
    const msg = raw as SioForward;
    if (!msg || typeof msg.id !== 'string') return;
    instances.get(msg.id)?._dispatch(msg);
  });
}

/**
 * Minimal socket.io-shaped client whose transport lives in main over the
 * isolated mailbox SOCKS port. The event list is declared up-front (`on()` calls
 * before `connect()`), exactly like the mobile bridge; late `on()` registrations
 * after connect still receive events for names already forwarded.
 */
export class TorSioSocket {
  readonly id: string;
  private readonly url: string;
  private readonly auth: Record<string, unknown>;
  private listeners = new Map<string, Listener[]>();
  private acks = new Map<string, Listener>();
  private _connected = false;
  private started = false;

  constructor(url: string, opts: { auth: Record<string, unknown> }) {
    this.id = `mb-${++counter}-${Date.now().toString(36)}`;
    this.url = url;
    this.auth = opts.auth;
    instances.set(this.id, this);
    wireEvents();
  }

  get connected(): boolean { return this._connected; }

  on(event: string, cb: Listener): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    this.acks.clear();
    return this;
  }

  /** Dial (main waits for Tor bootstrap before actually connecting). Idempotent. */
  connect(): this {
    if (this.started) return this;
    this.started = true;
    const events = [...this.listeners.keys()];
    void window.aegis.tor
      .sioConnect(this.id, this.url, JSON.stringify(this.auth), JSON.stringify(events))
      .catch((e: Error) => this._dispatch({ id: this.id, event: 'connect_error', args: [e.message] }));
    return this;
  }

  emit(event: string, payload: unknown, ack?: Listener): this {
    let ackId: string | null = null;
    if (ack) {
      ackId = `${this.id}-a${++counter}`;
      this.acks.set(ackId, ack);
    }
    void window.aegis.tor.sioEmit(this.id, event, JSON.stringify(payload ?? null), ackId).catch(() => { /* socket gone */ });
    return this;
  }

  disconnect(): this {
    this._connected = false;
    instances.delete(this.id);
    void window.aegis.tor.sioDisconnect(this.id).catch(() => { /* noop */ });
    return this;
  }

  /** @internal */
  _dispatch(msg: SioForward): void {
    if (msg.event === '__ack') {
      if (msg.ackId) { const cb = this.acks.get(msg.ackId); this.acks.delete(msg.ackId); cb?.(...msg.args); }
      return;
    }
    if (msg.event === 'connect') this._connected = true;
    if (msg.event === 'disconnect') this._connected = false;
    for (const cb of this.listeners.get(msg.event) ?? []) {
      try { cb(...msg.args); } catch { /* listener error must not break the pipe */ }
    }
  }
}
