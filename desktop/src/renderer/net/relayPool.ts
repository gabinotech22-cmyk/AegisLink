/**
 * relayPool — desktop adapter of relayPoolCore (federation F2).
 *
 * Sockets ride the bridged `TorSioSocket` (isolated mailbox SOCKS listener in
 * main); one-shot HTTP is plain `fetch` because the WHOLE Chromium session is
 * already proxied through Tor (main/index.ts setProxy) — a .onion URL resolves
 * inside Tor. Fail-closed: nothing here has a clearnet path.
 */
import { createRelayPool, type RelayPool } from './relayPoolCore';
import { TorSioSocket, whenTorReady } from './tor';
import { generateMailboxRoot, currentMailbox, mailboxAuthProof } from '../crypto/mailbox';
import type { RelayRef } from './relayRef';
import type { OutgoingMailboxEnvelope, EnvelopeAck, PoolHttpResponse } from './relayPoolCore';

let pool: RelayPool | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

async function httpOverTor(url: string, method: 'GET' | 'POST', body: string, headers: Record<string, string>): Promise<PoolHttpResponse | null> {
  try {
    const res = await fetch(url, { method, headers, ...(method === 'POST' ? { body } : {}) });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

function getPool(): RelayPool {
  if (pool) return pool;
  pool = createRelayPool({
    transport: {
      openSocket: (baseUrl, auth) => new TorSioSocket(baseUrl, { auth }),
      http: httpOverTor,
      now: () => Date.now(),
    },
    // A fresh random root per foreign connection: never persisted, never shared.
    newDisposableMailbox: () => currentMailbox(generateMailboxRoot(), Date.now()),
    authProof: mailboxAuthProof,
  });
  idleTimer = setInterval(() => pool?.closeIdle(), 60_000);
  return pool;
}

/** Deliver a sealed envelope to a mailbox hosted on `relay`. Null = try again later (outbox). */
export async function sendViaForeignRelay(relay: RelayRef, env: OutgoingMailboxEnvelope): Promise<EnvelopeAck | null> {
  await whenTorReady();
  return getPool().send(relay.onion, env);
}

/** One-shot HTTP against a foreign relay (prekeys bundle, identity lookup, /relay/info). */
export async function foreignRelayHttp(
  relay: RelayRef, path: string, method: 'GET' | 'POST' = 'GET', body = '', headers: Record<string, string> = {},
): Promise<PoolHttpResponse | null> {
  await whenTorReady();
  return getPool().http(relay.onion, path, method, body, headers);
}

/** Tear down every foreign connection (logout, panic wipe, profile switch). */
export function closeForeignRelays(): void {
  pool?.closeAll();
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  pool = null;
}
