/**
 * Slice 2b.2 — device-side mailbox push subscription (app alive).
 *
 * Subscribes to the relay's co-hosted ntfy over Tor, on the topic equal to our
 * current-epoch delivery mailbox id (docs/FASE4-SLICE2B-PUSH-DESIGN.md §5.1 v1).
 * When the relay enqueues an `envelope:mb` for us while our mailbox socket is
 * down, it publishes an empty wake to `topic = mailboxId`; that surfaces here as
 * an ntfy `message` event, and we react by draining the mailbox (reconnecting
 * the mailbox socket, which authenticates and pulls the queue).
 *
 * Privacy: the subscription rides the SAME .onion as the mailbox transport
 * (virtual port 8090 → ntfy), so ntfy never sees the device IP. The topic is a
 * 128-bit bearer capability that ROTATES per UTC-day epoch with the mailbox, so
 * we re-subscribe at each boundary (mirrors mailboxSocket's epoch rotation).
 *
 * This covers the "app is alive/backgrounded" case only. Waking a fully-killed
 * app needs a UnifiedPush distributor (2b.3) or the existing FCM fallback — out
 * of scope here. No-op fail-closed when Tor/mailbox mode is unavailable.
 */

import { logger } from '../utils/logger';
import { ONION_URL, MAILBOX_ENABLED } from '../config';
import { isTorAvailable, subscribeNtfyOverTor } from '../net/tor';
import { epochFor, MAILBOX_EPOCH_MS } from '../crypto/mailbox';
import { getOwnCurrentMailbox } from '../crypto/mailboxStore';

/**
 * ntfy topics only allow [-_A-Za-z0-9]; our mailbox ids are standard base64, so
 * convert to base64url without padding. Byte-identical to the server's
 * mailboxTopic() in server/src/push/ntfy.ts — both must agree on the topic name.
 */
export function mailboxTopic(mailboxIdB64: string): string {
  return mailboxIdB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Derive the ntfy stream URL for a topic on the relay onion (virtual port 8090). */
function ntfyStreamUrl(topic: string): string | null {
  if (!ONION_URL) return null;
  // ONION_URL is http://<host>.onion (relay virtual port 80). ntfy is published
  // on the SAME onion at virtual port 8090 (infra/tor/torrc, Slice 2b).
  const base = ONION_URL.replace(/\/+$/, '');
  const withPort = base.replace(/^(http:\/\/[^/:]+)(:\d+)?$/, '$1:8090');
  return `${withPort}/${topic}/json`;
}

let wantSub = false;
let unsub: (() => void) | null = null;
let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let onWakeCb: (() => void) | null = null;
let subscribing = false;

const RETRY_MS = 30_000; // re-subscribe after a dropped circuit / ntfy error

function clearTimers(): void {
  if (boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

/** ntfy /json emits one JSON object per line: {event:'open'|'keepalive'|'message',...}. */
function handleLine(line: string): void {
  let parsed: { event?: string };
  try { parsed = JSON.parse(line) as { event?: string }; } catch { return; }
  // Only a real 'message' is a wake. 'open'/'keepalive' are stream housekeeping.
  if (parsed.event === 'message') {
    if (__DEV__) logger.debug('[mailboxPush] wake received, draining mailbox');
    onWakeCb?.();
  }
}

function scheduleRetry(): void {
  if (!wantSub || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; void resubscribe(); }, RETRY_MS);
}

/** Re-subscribe to the current-epoch topic, tearing down any prior subscription. */
async function resubscribe(): Promise<void> {
  if (!wantSub || subscribing) return;
  subscribing = true;
  try {
    if (unsub) { unsub(); unsub = null; }
    const mb = await getOwnCurrentMailbox(Date.now());
    if (!wantSub) return; // teardown raced the await
    const url = ntfyStreamUrl(mailboxTopic(mb.mailboxIdB64));
    if (!url) return;
    unsub = subscribeNtfyOverTor(url, handleLine, (reason) => {
      if (__DEV__) logger.debug('[mailboxPush] subscription dropped:', reason);
      scheduleRetry();
    });
    scheduleEpochBoundary();
  } catch (e) {
    if (__DEV__) logger.warn('[mailboxPush] resubscribe failed, will retry:', (e as Error).message);
    scheduleRetry();
  } finally {
    subscribing = false;
  }
}

/** Re-subscribe just after the next UTC-day epoch boundary (topic rotates then). */
function scheduleEpochBoundary(): void {
  if (boundaryTimer) return;
  const now = Date.now();
  const nextBoundary = (epochFor(now) + 1) * MAILBOX_EPOCH_MS;
  const delay = Math.max(5_000, nextBoundary - now + 2_000); // +2s skew grace
  boundaryTimer = setTimeout(() => { boundaryTimer = null; void resubscribe(); }, delay);
}

/**
 * Start (or restart) the mailbox push subscription. `onWake` is invoked whenever
 * a wake for our current mailbox arrives — the caller drains the mailbox (e.g.
 * connectMailboxForIdentity). Idempotent: replaces any prior onWake + re-subs.
 * No-op when mailbox mode / Tor is unavailable (fail-closed).
 */
export function startMailboxPushSubscription(onWake: () => void): void {
  if (!MAILBOX_ENABLED || !ONION_URL || !isTorAvailable()) return;
  onWakeCb = onWake;
  wantSub = true;
  void resubscribe();
}

/** Stop the subscription and cancel all timers (logout / panic / profile switch). */
export function stopMailboxPushSubscription(): void {
  wantSub = false;
  onWakeCb = null;
  clearTimers();
  if (unsub) { unsub(); unsub = null; }
}
