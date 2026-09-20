/**
 * Call-signal transport router (federation F4 — docs/FEDERATION-DESIGN.md D3).
 *
 * Every 1:1 and group call event is already sealed end-to-end (the relay only
 * ever routes `{ to, ...opaque }` and never stamps `from`). What the relay
 * still needs is a `to: aegisId` queue on OUR relay — which a contact on
 * ANOTHER relay does not have. For such a contact the very same sealed event
 * rides as a `call_signal` payload inside the Double Ratchet channel (like
 * typing / receipts / sender_key_dist in F3), which F2/F3b deliver through the
 * contact's relay by mailbox.
 *
 *   outgoing:  routeCallSignal(socket, event, to, msg)
 *              ├─ local contact  → socket.emit(event, { ...msg, to })     (as today)
 *              └─ foreign contact→ sendMessage({ type: 'call_signal',
 *                                    text: JSON{ event, msg } })          (F4)
 *   incoming:  the sealed handler in client.ts calls dispatchSealedCallSignal
 *              (from, text) → the SAME handler attachCallHandlers /
 *              attachGroupCallHandlers registered for that event, with the
 *              authenticated sealed-sender `from` so the handler can pin it.
 *
 * The inner sealing (per-call key, per-recipient box) is kept as-is on both
 * transports, so a handler cannot tell — and need not care — which way an
 * event arrived; the only difference is that the mailbox path also hands it
 * an authenticated `from`.
 *
 * Invites carry `wakeHint: 'call'` on the outer mailbox wire so the callee's
 * home relay publishes a high-priority (call-class) wake — the one declared
 * metadata bit of D3.
 */

import { logger } from '../utils/logger';
import { decodeBase64 } from 'tweetnacl-util';
import { isForeign } from '../net/homeRelay';
import { CAP_SEALED_CALLS, contactHasCap } from '../net/caps';
import { MAILBOX_ENABLED } from '../config';

/** Socket-like sink: the real socket.io client or a test double. */
export interface SignalSocket {
  emit: (event: string, payload: unknown) => unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- socket.io's listener type is (...args: any[]) => void */

/** Events that may travel as a sealed call_signal. Anything else is dropped on receipt. */
export const CALL_SIGNAL_EVENTS = new Set<string>([
  'call:invite:v2', 'call:answer:v2', 'call:ice:v2', 'call:hangup:v2',
  'group_call:accept', 'group_call:decline', 'group_call:offer', 'group_call:answer',
  'group_call:ice', 'group_call:channel', 'group_call:hangup',
]);

/** A call signal is useless once the ring/trickle window is over: bound its relay life. */
export const CALL_SIGNAL_TTL_MS = 60_000;

export type CallSignalHandler = (msg: unknown, from?: string) => void | Promise<void>;

const handlers = new Map<string, CallSignalHandler>();

/**
 * Register the handler for a call event on the socket AND in the sealed
 * dispatch table. `attachCallHandlers` / `attachGroupCallHandlers` already
 * `socket.off()` each event before re-registering; the table entry is simply
 * replaced.
 */
export function onCallSignal(
  socket: { on: (event: string, cb: (...args: any[]) => void) => unknown },
  event: string,
  handler: CallSignalHandler,
): void {
  handlers.set(event, handler);
  socket.on(event, (msg: unknown) => { void handler(msg); });
}

/** Test seam / teardown. */
export function clearCallSignalHandlers(): void {
  handlers.clear();
}

function contactFor(aegisId: string): { publicKeyB64: string; relayOnion?: string | null; caps?: string[] | null } | undefined {
  try {
    const { useContacts } = require('../store/contacts') as typeof import('../store/contacts');
    return useContacts.getState().contacts.find((c) => c.aegisId === aegisId);
  } catch {
    return undefined;
  }
}

/**
 * Deliver one call event to one recipient. Returns true when it left (or was
 * handed to the sealed transport); false when the recipient is foreign and we
 * cannot seal to them (no identity / key) — the caller treats that as a
 * signaling failure, never as "try the home socket" (a foreign aegisId has no
 * queue there and the emit would only hand our relay the me↔to edge).
 */
/**
 * Per-recipient send chain: the local-contact sealed decision needs one async
 * lookup (their mailbox id), and signals to the same peer must keep their
 * order (invite before ICE). Chaining per `to` preserves it.
 */
const sendChains = new Map<string, Promise<void>>();
function chainFor(to: string, step: () => Promise<void>): void {
  const prev = sendChains.get(to) ?? Promise.resolve();
  const next = prev.then(step, step).finally(() => {
    if (sendChains.get(to) === next) sendChains.delete(to);
  });
  sendChains.set(to, next);
}

function sealAndSend(
  identity: import('../crypto/identity').Identity,
  to: string,
  recipientPublicKey: Uint8Array,
  event: string,
  msg: Record<string, unknown>,
): Promise<void> {
  const { sendMessage } = require('./client') as typeof import('./client');
  return sendMessage({
    identity,
    recipientAegisId: to,
    recipientPublicKey,
    plaintext: JSON.stringify({ event, msg }),
    type: 'call_signal',
    // Bounds the relay's queue life; the handler ignores stale callIds anyway.
    expiresAt: Date.now() + CALL_SIGNAL_TTL_MS,
    skipLocalAppend: true,
    transient: true,
    wakeHint: event === 'call:invite:v2' ? 'call' : undefined,
  }).catch((e: unknown) => {
    if (__DEV__) logger.warn('[calls] sealed call signal failed:', event, (e as Error).message);
  });
}

export function routeCallSignal(
  socket: SignalSocket,
  event: string,
  to: string,
  msg: Record<string, unknown>,
  /** How to put this signal on the home socket when sealing is not possible
   *  (default: `{ ...msg, to }`; the `items` fan-out passes its own shape). */
  emitLegacy: () => void = () => { socket.emit(event, { ...msg, to }); },
): boolean {
  const contact = contactFor(to);
  if (!contact) {
    emitLegacy();
    return true;
  }
  const foreign = isForeign(contact);
  // D6 (FEDERATION-DESIGN): a contact on OUR relay gets the same sealed
  // `call_signal` as a foreign one when it announced `sealed-calls` — the
  // relay then stops seeing `to: aegisId` on calls — provided the sealed path
  // is usable right now (our mailbox socket up, their mailbox id derivable).
  // Otherwise the relay-visible event goes out as before, so a call never
  // fails to ring for want of privacy. A pre-caps peer never sees a sealed one.
  const sealedLocal = !foreign && MAILBOX_ENABLED && contactHasCap(contact, CAP_SEALED_CALLS);
  if (!foreign && !sealedLocal) {
    emitLegacy();
    return true;
  }
  let recipientPublicKey: Uint8Array;
  try { recipientPublicKey = decodeBase64(contact.publicKeyB64); } catch {
    if (foreign) return false;
    emitLegacy();
    return true;
  }
  const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
  const identity = useIdentity.getState().identity;
  if (!identity) {
    if (foreign) return false;
    emitLegacy();
    return true;
  }
  if (foreign) {
    chainFor(to, () => sealAndSend(identity, to, recipientPublicKey, event, msg));
    return true;
  }
  chainFor(to, async () => {
    const { isMailboxAuthed } = require('./mailboxSocket') as typeof import('./mailboxSocket');
    const { getContactCurrentMailboxId } = require('../crypto/mailboxStore') as typeof import('../crypto/mailboxStore');
    let mboxTo: string | null = null;
    if (isMailboxAuthed()) {
      try { mboxTo = await getContactCurrentMailboxId(to, Date.now()); } catch { mboxTo = null; }
    }
    if (mboxTo) await sealAndSend(identity, to, recipientPublicKey, event, msg);
    else emitLegacy();
  });
  return true;
}

/**
 * Per-recipient fan-out (`items: [{ to, ciphertext, nonce }]`): the relay-local
 * members stay in ONE emit with their items; each foreign member gets its own
 * sealed copy carrying exactly what the relay would have delivered to it.
 */
export function routeCallSignalItems(
  socket: SignalSocket,
  event: string,
  base: Record<string, unknown>,
  items: Array<{ to: string; ciphertext: string; nonce: string }>,
): void {
  const local: typeof items = [];
  for (const it of items) {
    const contact = contactFor(it.to);
    if (contact && (isForeign(contact) || (MAILBOX_ENABLED && contactHasCap(contact, CAP_SEALED_CALLS)))) {
      routeCallSignal(
        socket, event, it.to, { ...base, ciphertext: it.ciphertext, nonce: it.nonce },
        // Sealing not possible right now → this member's item in the fan-out shape.
        () => { socket.emit(event, { ...base, items: [it] }); },
      );
    } else {
      local.push(it);
    }
  }
  if (local.length > 0) socket.emit(event, { ...base, items: local });
}

/**
 * Incoming sealed `call_signal` (client.ts, authenticated sealed-sender `from`).
 * Hands the inner event to the handler registered for it, with `from` so the
 * handler can require the sealed-inside identity to match. Unknown events and
 * malformed payloads are dropped silently.
 */
export async function dispatchSealedCallSignal(from: string, text: string): Promise<void> {
  let parsed: { event?: unknown; msg?: unknown };
  try { parsed = JSON.parse(text) as { event?: unknown; msg?: unknown }; } catch { return; }
  if (typeof parsed.event !== 'string' || !CALL_SIGNAL_EVENTS.has(parsed.event)) return;
  if (!parsed.msg || typeof parsed.msg !== 'object') return;
  const handler = handlers.get(parsed.event);
  if (!handler) return;
  try {
    await handler(parsed.msg, from);
  } catch (e) {
    if (__DEV__) logger.warn('[calls] sealed call signal handler failed:', parsed.event, (e as Error).message);
  }
}
