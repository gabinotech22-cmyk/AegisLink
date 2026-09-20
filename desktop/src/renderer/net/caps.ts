/**
 * Client capabilities announced inside the E2EE profile (`profile_update.caps`)
 * and pinned per contact. They gate transport choices that an OLDER peer could
 * not follow, so the two sides never disagree on how a message must arrive:
 *
 *  - `sealed-calls`          the peer dispatches `call_signal` messages (F4
 *                            router) — call signaling may go through its
 *                            mailbox instead of the relay-visible `call:*`
 *                            events (FEDERATION-DESIGN D6).
 *  - `sealed-first-contact`  the peer opens a sealed-v2 first contact (`fc`
 *                            block, TOFU) from a sender it has no signing key
 *                            for (F3b) — informational; the sender decides on
 *                            the mailbox root it holds, see buildOutgoingEnvelope.
 *
 * A peer that announces nothing is treated as pre-caps (≤ 1.0.6): every path
 * behaves exactly as before. Byte-identical mobile ↔ desktop.
 */
export const CAP_SEALED_CALLS = 'sealed-calls';
export const CAP_SEALED_FIRST_CONTACT = 'sealed-first-contact';

/** What THIS client announces. Order is irrelevant; keep it stable anyway. */
export const OWN_CAPS: readonly string[] = [CAP_SEALED_CALLS, CAP_SEALED_FIRST_CONTACT];

const CAP_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_CAPS = 16;

/**
 * Accept a `caps` field from a (decrypted, authenticated) profile: an array of
 * short lowercase tokens. Anything else → null (field ignored, nothing stored).
 * Unknown tokens are kept — a newer peer may announce caps we do not know yet.
 */
export function sanitizeCaps(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !CAP_RE.test(v)) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= MAX_CAPS) break;
  }
  return out;
}

/** True when the contact has announced `cap`. */
export function contactHasCap(
  contact: { caps?: readonly string[] | null } | null | undefined,
  cap: string,
): boolean {
  return !!contact?.caps && contact.caps.includes(cap);
}

/** Two cap lists are the same set. */
export function sameCaps(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((c) => y.includes(c));
}
