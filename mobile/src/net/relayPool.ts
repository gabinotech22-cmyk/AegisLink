/**
 * relayPool — mobile adapter of relayPoolCore (federation F2).
 *
 * Every foreign connection rides embedded Tor: sockets through `TorSioSocket`
 * (native socket.io-over-SOCKS bridge) and one-shot HTTP through
 * `torHttpRequest`. Fail-closed: without the native Tor module, or before Tor
 * bootstraps, every call resolves null and the caller retries via the outbox.
 */
import { createRelayPool, type RelayPool } from './relayPoolCore';
import { TorSioSocket, isTorAvailable, startTor, torHttpRequest } from './tor';
import { generateMailboxRoot, currentMailbox, mailboxAuthProof } from '../crypto/mailbox';
import type { RelayRef } from './relayRef';
import type { OutgoingMailboxEnvelope, EnvelopeAck, PoolHttpResponse } from './relayPoolCore';

let pool: RelayPool | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

function getPool(): RelayPool {
  if (pool) return pool;
  pool = createRelayPool({
    transport: {
      openSocket: (baseUrl, auth) => new TorSioSocket(baseUrl, auth),
      http: (url, method, body, headers) => torHttpRequest(url, method, body, headers),
      now: () => Date.now(),
    },
    // A fresh random root per foreign connection: never persisted, never
    // shared with a contact, never the root our own mailbox derives from.
    newDisposableMailbox: () => currentMailbox(generateMailboxRoot(), Date.now()),
    authProof: mailboxAuthProof,
  });
  idleTimer = setInterval(() => pool?.closeIdle(), 60_000);
  // Never keep the JS runtime alive for the sweeper (tests, background).
  (idleTimer as { unref?: () => void }).unref?.();
  return pool;
}

/** Tor must be bootstrapped before anything leaves the device. Null = not possible right now. */
async function torReady(): Promise<boolean> {
  if (!isTorAvailable()) return false;
  try { await startTor(); return true; } catch { return false; }
}

/** Deliver a sealed envelope to a mailbox hosted on `relay`. Null = try again later (outbox). */
export async function sendViaForeignRelay(relay: RelayRef, env: OutgoingMailboxEnvelope): Promise<EnvelopeAck | null> {
  if (!(await torReady())) return null;
  return getPool().send(relay.onion, env);
}

/** One-shot HTTP against a foreign relay (prekeys bundle, identity lookup, /relay/info). */
export async function foreignRelayHttp(
  relay: RelayRef, path: string, method: 'GET' | 'POST' = 'GET', body = '', headers: Record<string, string> = {},
): Promise<PoolHttpResponse | null> {
  if (!(await torReady())) return null;
  return getPool().http(relay.onion, path, method, body, headers);
}

/** Tear down every foreign connection (logout, panic wipe, profile switch). */
export function closeForeignRelays(): void {
  pool?.closeAll();
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  pool = null;
}
