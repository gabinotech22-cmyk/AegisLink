/**
 * Our own contact address (federation F7, docs/FEDERATION-DESIGN.md D1/§9.3).
 *
 * A contact address is identity + relay: on the official relay it is the v1
 * payload every shipped client understands; once the home is a self-hosted
 * `.onion` (F5b) it MUST be v2 and carry the relay *and* our mailbox root,
 * because a stranger on another relay has no other way to write the first
 * message (the SimpleX model — the address includes the queue). Found in the
 * F7 device test: the encoders in crypto/qr.ts supported v2 since F1 but every
 * screen emitted v1, so a migrated user handed out an address nobody could
 * reach. One helper, used by every QR/link screen, so it cannot drift again.
 */
import { useEffect, useState } from 'react';
import { getHomeRelay } from './homeRelay';
import { getOwnMailboxRootB64 } from '../crypto/mailboxStore';
import type { RelayRef } from './relayRef';

export interface OwnAddressParts {
  /** null = official relay (v1 payload). */
  relay: RelayRef | null;
  /** Our mailbox root (base64) — only set alongside a custom relay (v2 payload). */
  mailboxRootB64: string | null;
}

const OFFICIAL: OwnAddressParts = { relay: null, mailboxRootB64: null };

/** Resolve the parts once (async: the root lives in SecureStore). */
export async function ownAddressParts(): Promise<OwnAddressParts> {
  const relay = getHomeRelay();
  if (!relay) return OFFICIAL;
  return { relay, mailboxRootB64: await getOwnMailboxRootB64() };
}

/**
 * Hook form for the QR/link screens. Starts as "official" and resolves to the
 * custom-relay parts; callers must not emit a v2 payload until `ready` — the
 * encoders throw on a relay without a root, and a v1 payload for a custom
 * home would be a link nobody can reach.
 */
export function useOwnAddressParts(): OwnAddressParts & { ready: boolean } {
  const [state, setState] = useState<OwnAddressParts & { ready: boolean }>(() => ({ ...OFFICIAL, ready: getHomeRelay() === null }));
  useEffect(() => {
    let alive = true;
    ownAddressParts()
      .then((p) => { if (alive) setState({ ...p, ready: true }); })
      .catch(() => { if (alive) setState((s) => ({ ...s, ready: false })); });
    return () => { alive = false; };
  }, []);
  return state;
}
