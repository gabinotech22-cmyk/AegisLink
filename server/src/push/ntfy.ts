/**
 * AegisLink — ntfy wake-up publisher (Fase 4 · Slice 2b)
 *
 * docs/FASE4-SLICE2B-PUSH-DESIGN.md §5.3: the ONLY change to the mailbox hot
 * path is a best-effort, zero-metadata publish to a self-hosted ntfy topic
 * equal to the (opaque, per-epoch) mailbox id. No aegisId, no sender, no
 * content — an empty-body high-priority publish is the entire wake-up (R2).
 *
 * v1 (co-hosted ntfy, §5.1): topic = mailboxId. No binding table, no extra
 * registration round — the relay already knows the mailbox id it is routing
 * to, and the id itself rotates by epoch, so no new correlation is added.
 *
 * Gated behind PUSH_MAILBOX_ENABLED (default OFF) and requires NTFY_URL.
 * Best-effort: never throws, never blocks the caller, short timeout.
 */

import { pushEndpointRepo } from '../db/client.js';

// ntfy topics only allow [-_A-Za-z0-9]. Our mailbox ids are standard base64
// (mailboxIdForSignPublicKey/mailboxId(epoch) — see crypto/mailbox.ts), so
// convert to base64url without padding before using it as a topic name.
export function mailboxTopic(mailboxIdB64: string): string {
  return mailboxIdB64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function isPushMailboxEnabled(): boolean {
  return (process.env['PUSH_MAILBOX_ENABLED'] ?? 'off').toLowerCase() === 'on';
}

const PUBLISH_TIMEOUT_MS = 5_000;

// ── Slice 2b.3b: UnifiedPush endpoint bindings ───────────────────────────────

/** Endpoint URLs longer than this are rejected outright (abuse guard). */
export const MAX_ENDPOINT_LENGTH = 512;

/**
 * SSRF guard for client-supplied UnifiedPush endpoints. The relay will POST to
 * this URL, so an attacker must not be able to point it at internal services.
 * Accepts only https:// with a plain DNS hostname: IP literals (v4/v6),
 * localhost and single-label/internal-suffix hosts are rejected. DNS-rebinding
 * to a private IP is out of scope here — the POST carries an empty body and no
 * credentials, so a rebound request cannot exfiltrate or mutate anything.
 */
export function isSafeUpEndpoint(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (!host.includes('.')) return false; // single-label (intranet) names
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.onion')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // IPv4 literal
  if (host.startsWith('[') || host.includes(':')) return false; // IPv6 literal
  return true;
}

/**
 * POST an empty, high-priority wake to a bound UnifiedPush endpoint. Returns
 * 'gone' when the endpoint reports 404/410 (distributor unregistered) so the
 * caller can drop the dead binding; 'ok' otherwise (including network errors —
 * best-effort, the queued message is safe either way).
 */
async function publishToEndpoint(endpoint: string): Promise<'ok' | 'gone'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      // R2: nothing readable in the wake-up — empty body, no title/sender.
      body: '',
      headers: { Priority: 'high' },
      signal: controller.signal,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return 'ok';
  } catch (e) {
    if (isDev) console.warn('[push:ntfy] endpoint publish failed', (e as Error).message);
    return 'ok';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publishes an empty, high-priority wake-up to the ntfy topic derived from
 * `mailboxIdB64`. Best-effort and silent: any failure (flag off, ntfy down,
 * timeout) is swallowed — the message stays safely queued either way and the
 * recipient still drains it on the next reconnect.
 *
 * NEVER logs the mailbox id / topic in production — that would put an opaque
 * routing id (already minimized elsewhere) into logs for no operational gain.
 */
export async function notifyMailbox(mailboxIdB64: string): Promise<void> {
  if (!isPushMailboxEnabled()) return;

  // Slice 2b.3b: a registered UnifiedPush endpoint (app-killed path, external
  // distributor) takes precedence over the co-hosted topic publish. The topic
  // publish still covers the in-app 2b.2 subscription when no binding exists.
  try {
    const endpoint = await pushEndpointRepo.get(mailboxIdB64);
    if (endpoint) {
      const outcome = await publishToEndpoint(endpoint);
      if (outcome === 'gone') await pushEndpointRepo.delete(mailboxIdB64);
      return;
    }
  } catch (e) {
    if (isDev) console.warn('[push:ntfy] endpoint lookup failed', (e as Error).message);
    // fall through to the topic publish — best-effort either way
  }

  const ntfyUrl = process.env['NTFY_URL'];
  if (!ntfyUrl) return;

  const topic = mailboxTopic(mailboxIdB64);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    await fetch(`${ntfyUrl.replace(/\/+$/, '')}/${topic}`, {
      method: 'POST',
      // Empty body, no title/tags/click — R2: nothing readable in the wake-up.
      body: '',
      headers: { Priority: 'high' },
      signal: controller.signal,
    });
  } catch (e) {
    if (isDev) console.warn('[push:ntfy] publish failed', (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

// Allow __DEV__-equivalent guard in Node — true when NODE_ENV !== 'production'.
const isDev = process.env['NODE_ENV'] !== 'production';
