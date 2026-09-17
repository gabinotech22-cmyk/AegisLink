/**
 * homeRelay — which relay hosts OUR mailbox (federation, docs/FEDERATION-DESIGN.md D2/D4).
 *
 * F2 ships the routing plumbing; the setting itself (Privacy → Red → "Mi relay",
 * migration, persistence) arrives in F5. Until then the home relay is always the
 * official one (`null`), so every path below behaves exactly as today.
 *
 * `relayFor(contact)` / `isForeign(contact)` are the ONLY way code decides where a
 * contact lives — never compare `relayOnion` strings by hand.
 */
import { canonicalRelay } from './officialRelay';
import { relayRefFromOnion, sameRelay, type RelayRef } from './relayRef';

/** The relay our identity is registered on and our mailbox binds to. null = official. */
export function getHomeRelay(): RelayRef | null {
  return null; // F5: read from the per-profile relay setting
}

/** Where a contact's mailbox lives. null = official relay. */
export function relayFor(contact: { relayOnion?: string | null } | null | undefined): RelayRef | null {
  if (!contact?.relayOnion) return null;
  return canonicalRelay(relayRefFromOnion(contact.relayOnion));
}

/**
 * A contact is "foreign" when its mailbox lives on a relay other than our home.
 * Foreign contacts are reached only through the relay pool (disposable mailbox
 * socket on their relay); there is no aegisId transport to them at all.
 */
export function isForeign(contact: { relayOnion?: string | null } | null | undefined): boolean {
  return !sameRelay(relayFor(contact), getHomeRelay());
}
