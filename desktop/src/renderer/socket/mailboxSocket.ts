/**
 * AegisLink — Dedicated mailbox delivery socket (sealed-sender Fase 4, desktop)
 *
 * Parity with mobile/src/socket/mailboxSocket.ts. Hides the recipient (`to`) from
 * the relay. A SEPARATE Socket.IO connection from the aegisId control-plane socket
 * (client.ts): it authenticates by proving possession of the current epoch's
 * mailbox signing key — the relay never learns the aegisId on this socket — and
 * carries ONLY message delivery (`envelope:mb`, send + receive). Prekeys/push/
 * token/profile stay on the aegisId socket (Option A, docs/FASE4-CONTROL-PLANE-DESIGN.md).
 *
 * Privacy gate (fail-closed): only ever connects when MAILBOX_ENABLED — i.e.
 * MAILBOX_MODE on AND Tor (ONION_URL) available. We route this socket over Tor so
 * the relay can't relink the opaque mailbox to our IP next to the aegisId control
 * socket. If Tor is unavailable the caller never enables mailbox mode and delivery
 * falls back to the aegisId transport. Default OFF.
 *
 * Wire protocol (mirrors server/src/relay/handler.ts handleMailboxConnection):
 *   handshake.auth: { mailboxId, mailboxSignPubKey }
 *   server → 'mailbox:challenge' { nonce }        (32 random bytes, base64)
 *   client → 'mailbox:auth:response' { sig }      (Ed25519 over the nonce)
 *   server → 'auth:ok'                            (after draining the offline queue)
 *   server → 'envelope:mb' { id, to, ciphertext, nonce, epk, createdAt }  (incoming)
 *   client → 'envelope:mb' { id, to, ciphertext, nonce, epk }  ack {ok,delivered?,queued?}
 *
 * Epoch rotation: the mailbox is derived for the CURRENT epoch at connect time.
 * Live re-derivation on an epoch boundary is Slice 5 — noted, not handled here.
 */

import { io, type Socket } from 'socket.io-client';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { ONION_URL, MAILBOX_ENABLED } from '../config';
import { getOwnCurrentMailbox } from '../crypto/mailboxStore';
import { mailboxAuthProof, type Mailbox } from '../crypto/mailbox';

const DEV = import.meta.env.DEV;

/** Incoming envelope as forwarded by the relay (createdAt stamped relay-side). */
export interface IncomingMailboxEnvelope {
  id: string;
  to: string;
  ciphertext: string;
  nonce: string;
  epk: string;
  createdAt: number;
}

/** Outgoing sealed v2 wire fields, addressed to a recipient mailbox id. */
export interface OutgoingMailboxEnvelope {
  id: string;
  to: string;            // recipient's current-epoch mailbox id (base64)
  ciphertext: string;
  nonce: string;
  epk: string;
  /** Slice 5: ephemeral TTL (ms) — server uses it ONLY to bound offline-queue life. */
  ephemeralTtl?: number;
}

type EnvelopeAck = { ok: boolean; delivered?: boolean; queued?: boolean; error?: string };

let mboxSocket: Socket | null = null;
let currentEpochMailbox: Mailbox | null = null;
let authed = false;

/** True once the mailbox socket is connected and possession-proof authenticated. */
export function isMailboxAuthed(): boolean {
  return authed && mboxSocket?.connected === true;
}

/**
 * Open the dedicated mailbox delivery socket and authenticate by possession proof.
 * No-op (returns null) unless MAILBOX_ENABLED. Incoming envelopes are handed to
 * `onEnvelope`; the caller decrypts (sealed v2) and routes into the normal
 * incoming pipeline. Idempotent: a live socket is reused.
 */
export async function connectMailboxSocket(
  onEnvelope: (env: IncomingMailboxEnvelope) => void,
): Promise<Socket | null> {
  if (!MAILBOX_ENABLED || !ONION_URL) return null; // fail-closed: needs Tor
  if (mboxSocket && mboxSocket.connected) return mboxSocket;

  // Derive the mailbox valid right now (id + auth keypair) from our own root.
  const mb = await getOwnCurrentMailbox(Date.now());
  currentEpochMailbox = mb;
  authed = false;

  const sock = io(ONION_URL, {
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    auth: {
      mailboxId: mb.mailboxIdB64,
      mailboxSignPubKey: encodeBase64(mb.signPublicKey),
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    reconnectionAttempts: Infinity,
    timeout: 20000,
  });
  mboxSocket = sock;

  sock.on('connect', () => {
    authed = false;
    if (DEV) console.debug('[mailbox] connected, awaiting challenge');
  });

  sock.on('disconnect', (reason) => {
    authed = false;
    if (DEV) console.debug('[mailbox] disconnected:', reason);
  });

  // Possession proof: sign the relay's random challenge with the mailbox secret.
  // The relay verifies against the signing pubkey it recomputed the id from, so
  // it learns nothing but the rotating mailbox id.
  sock.on('mailbox:challenge', (chal: { nonce?: unknown }) => {
    try {
      if (typeof chal?.nonce !== 'string') throw new Error('bad challenge');
      const nonce = decodeBase64(chal.nonce);
      const sig = mailboxAuthProof(mb.signSecretKey, nonce);
      sock.emit('mailbox:auth:response', { sig: encodeBase64(sig) });
    } catch (e) {
      if (DEV) console.warn('[mailbox] auth failure:', (e as Error).message);
      sock.disconnect();
    }
  });

  sock.on('auth:ok', () => {
    authed = true;
    if (DEV) console.debug('[mailbox] authenticated');
  });

  sock.on('error_msg', (e: { code?: string }) => {
    if (DEV) console.warn('[mailbox] server error:', e?.code);
  });

  sock.on('envelope:mb', (raw: unknown) => {
    const env = raw as IncomingMailboxEnvelope;
    if (!env || typeof env.id !== 'string' || typeof env.ciphertext !== 'string') return;
    try {
      onEnvelope(env);
    } catch (e) {
      if (DEV) console.warn('[mailbox] onEnvelope handler threw:', e);
    }
  });

  return sock;
}

/**
 * Send a sealed v2 wire addressed to a recipient mailbox id over the mailbox
 * socket. Returns the relay ack ({delivered|queued}), or null if the socket is
 * not authenticated yet (caller falls back to the aegisId transport).
 */
export async function sendViaMailbox(env: OutgoingMailboxEnvelope): Promise<EnvelopeAck | null> {
  if (!isMailboxAuthed() || !mboxSocket) return null;
  return new Promise<EnvelopeAck | null>((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 15000);
    mboxSocket!.emit('envelope:mb', env, (ack: EnvelopeAck) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(ack ?? null);
    });
  });
}

/** Tear down the mailbox socket (e.g. on logout / profile switch / panic). */
export function disconnectMailboxSocket(): void {
  authed = false;
  currentEpochMailbox = null;
  if (mboxSocket) {
    try { mboxSocket.removeAllListeners(); mboxSocket.disconnect(); } catch { /* noop */ }
    mboxSocket = null;
  }
}

/** Our current-epoch mailbox id (base64), or null if the socket isn't up. Test/debug aid. */
export function ownCurrentMailboxId(): string | null {
  return currentEpochMailbox?.mailboxIdB64 ?? null;
}
