/**
 * relayPoolCore — multi-relay client core (federation F2, docs/FEDERATION-DESIGN.md D2).
 *
 * A contact on another relay is reached by opening a mailbox socket ON THAT
 * relay with a DISPOSABLE mailbox: a random root that lives only in memory for
 * this session, is never persisted and never receives anything. The foreign
 * relay sees an opaque id it cannot link to us or to our contacts; our
 * identity is never authenticated there (golden rules #3/#4). The socket is
 * closed after `idleMs` without traffic and re-opened (with a fresh root) on
 * the next send.
 *
 * Pure: transport, clock and crypto arrive through `deps`, so the SAME file is
 * used byte-identically on mobile (TorSioSocket + native SOCKS HTTP) and
 * desktop (bridged TorSioSocket + Chromium session proxied through Tor), and
 * the same unit test runs against a fake transport on both.
 *
 * Wire (mirrors server/src/relay/handler.ts handleMailboxConnection):
 *   handshake.auth: { mailboxId, mailboxSignPubKey }
 *   server → 'mailbox:challenge' { nonce }   client → 'mailbox:auth:response' { sig }
 *   server → 'auth:ok'                       client → 'envelope:mb' env, ack
 */

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

/** Structural subset both TorSioSocket implementations satisfy. */
export interface PoolSocket {
  connected: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io listener shape
  on(event: string, cb: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io ack shape
  emit(event: string, payload?: unknown, ack?: (...args: any[]) => void): unknown;
  removeAllListeners(): unknown;
  disconnect(): unknown;
}

export interface PoolHttpResponse { status: number; body: string }

export interface PoolTransport {
  /** Open a mailbox socket to `baseUrl` (http://<onion>) with the given handshake auth. */
  openSocket(baseUrl: string, auth: Record<string, unknown>): PoolSocket;
  /** One-shot HTTP over Tor. Resolves null on any transport failure (never throws). */
  http(url: string, method: 'GET' | 'POST', body: string, headers: Record<string, string>): Promise<PoolHttpResponse | null>;
  now(): number;
}

/** The subset of crypto/mailbox `Mailbox` the pool needs. */
export interface DisposableMailbox {
  mailboxIdB64: string;
  signPublicKey: Uint8Array;
  signSecretKey: Uint8Array;
}

export interface OutgoingMailboxEnvelope {
  id: string;
  to: string;
  ciphertext: string;
  nonce: string;
  epk: string;
  ephemeralTtl?: number;
  /** F4: call-class wake for the recipient (the one declared metadata bit, D3). */
  wakeHint?: 'call';
}

export type EnvelopeAck = { ok: boolean; delivered?: boolean; queued?: boolean; error?: string };

export interface RelayPoolDeps {
  transport: PoolTransport;
  /** Fresh random-root mailbox for the current epoch — one per foreign connection. */
  newDisposableMailbox: () => DisposableMailbox;
  /** Ed25519 possession proof over the relay's 32-byte challenge. */
  authProof: (signSecretKey: Uint8Array, challenge: Uint8Array) => Uint8Array;
  /** Close a foreign socket after this long without traffic (default 5 min). */
  idleMs?: number;
  /** Give up on a connect/auth that has not reached auth:ok (default 45 s). */
  connectTimeoutMs?: number;
  /** Ack wait for a single envelope send (default 15 s). */
  sendTimeoutMs?: number;
}

export const DEFAULT_IDLE_MS = 5 * 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 45_000;
export const DEFAULT_SEND_TIMEOUT_MS = 15_000;

/** Base URL for a relay named by its onion host. Self-hosted relays expose the hidden service on port 80. */
export function relayBaseUrl(onion: string): string {
  return `http://${onion}`;
}

interface ForeignConn {
  onion: string;
  socket: PoolSocket;
  mailbox: DisposableMailbox;
  authed: boolean;
  lastUsed: number;
  /** Resolves once auth:ok arrives; rejects on error/timeout. Shared by concurrent senders. */
  ready: Promise<void>;
}

export interface RelayPool {
  /** Deliver a sealed envelope to a mailbox hosted on `onion`. Null = transport failure (caller retries via outbox). */
  send(onion: string, env: OutgoingMailboxEnvelope): Promise<EnvelopeAck | null>;
  /** One-shot HTTP against a foreign relay's API (path starts with '/'). */
  http(onion: string, path: string, method?: 'GET' | 'POST', body?: string, headers?: Record<string, string>): Promise<PoolHttpResponse | null>;
  /** Close connections idle for longer than `idleMs`. Returns how many were closed. */
  closeIdle(now?: number): number;
  /** Tear everything down (logout / panic / profile switch). */
  closeAll(): void;
  /** Number of live foreign connections (tests / debug). */
  size(): number;
  /** Whether a live, authenticated connection to `onion` exists right now. */
  isConnected(onion: string): boolean;
}

export function createRelayPool(deps: RelayPoolDeps): RelayPool {
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const conns = new Map<string, ForeignConn>();

  function drop(onion: string, conn?: ForeignConn): void {
    const c = conn ?? conns.get(onion);
    if (!c) return;
    if (conns.get(onion) === c) conns.delete(onion);
    try { c.socket.removeAllListeners(); c.socket.disconnect(); } catch { /* best effort */ }
  }

  function open(onion: string): ForeignConn {
    const mailbox = deps.newDisposableMailbox();
    const socket = deps.transport.openSocket(relayBaseUrl(onion), {
      mailboxId: mailbox.mailboxIdB64,
      mailboxSignPubKey: encodeBase64(mailbox.signPublicKey),
      // We never receive on a disposable mailbox, but declare the capability
      // anyway so the relay applies the same (at-least-once) semantics to this socket.
      ackDelivery: true,
    });
    const conn: ForeignConn = { onion, socket, mailbox, authed: false, lastUsed: deps.transport.now(), ready: Promise.resolve() };
    conn.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        drop(onion, conn);
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail('foreign_relay_connect_timeout'), connectTimeoutMs);
      socket.on('mailbox:challenge', (chal: { nonce?: unknown }) => {
        try {
          if (typeof chal?.nonce !== 'string') throw new Error('bad challenge');
          const nonce = decodeBase64(chal.nonce);
          // Only sign a well-formed 32-byte challenge — never let a foreign relay
          // turn the disposable key into a signing oracle for arbitrary bytes.
          if (nonce.length !== 32) throw new Error('bad challenge size');
          socket.emit('mailbox:auth:response', { sig: encodeBase64(deps.authProof(mailbox.signSecretKey, nonce)) });
        } catch {
          fail('foreign_relay_bad_challenge');
        }
      });
      socket.on('auth:ok', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.authed = true;
        conn.lastUsed = deps.transport.now();
        resolve();
      });
      socket.on('error_msg', (e: { code?: string }) => fail(`foreign_relay_error:${e?.code ?? 'unknown'}`));
      socket.on('connect_error', () => fail('foreign_relay_connect_error'));
      socket.on('disconnect', () => {
        conn.authed = false;
        if (conns.get(onion) === conn) conns.delete(onion);
        if (!settled) fail('foreign_relay_disconnected');
      });
    });
    // A rejected `ready` is observed by every sender awaiting it; keep the
    // promise itself from surfacing as an unhandled rejection when no one is.
    conn.ready.catch(() => { /* reported to callers through send() */ });
    conns.set(onion, conn);
    return conn;
  }

  async function acquire(onion: string): Promise<ForeignConn> {
    const existing = conns.get(onion);
    if (existing) {
      // Reuse a live or still-connecting connection; concurrent senders share
      // its `ready`. A connection that failed drops itself from the map.
      try {
        await existing.ready;
        if (conns.get(onion) === existing && existing.authed && existing.socket.connected !== false) return existing;
      } catch { /* fall through to a fresh connection */ }
    }
    const fresh = open(onion);
    await fresh.ready;
    return fresh;
  }

  return {
    async send(onion, env) {
      let conn: ForeignConn;
      try {
        conn = await acquire(onion);
      } catch {
        return null;
      }
      conn.lastUsed = deps.transport.now();
      return new Promise<EnvelopeAck | null>((resolve) => {
        let settled = false;
        const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, sendTimeoutMs);
        conn.socket.emit('envelope:mb', env, (ack: EnvelopeAck) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          conn.lastUsed = deps.transport.now();
          resolve(ack ?? null);
        });
      });
    },

    http(onion, path, method = 'GET', body = '', headers = {}) {
      return deps.transport.http(`${relayBaseUrl(onion)}${path}`, method, body, headers);
    },

    closeIdle(now = deps.transport.now()) {
      let closed = 0;
      for (const [onion, c] of conns) {
        if (now - c.lastUsed >= idleMs) { drop(onion, c); closed++; }
      }
      return closed;
    },

    closeAll() {
      for (const [onion, c] of Array.from(conns)) drop(onion, c);
    },

    size() { return conns.size; },

    isConnected(onion) {
      const c = conns.get(onion);
      return !!c && c.authed && c.socket.connected !== false;
    },
  };
}
