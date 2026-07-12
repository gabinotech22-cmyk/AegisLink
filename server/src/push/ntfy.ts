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
