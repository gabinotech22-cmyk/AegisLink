/**
 * The official AegisLink relay as a RelayRef (docs/FEDERATION-DESIGN.md D1).
 *
 * Derived from ONION_URL so there is exactly ONE place that knows the official
 * onion. A contact whose `relayOnion` is null, or equals this onion, is on the
 * official relay; v1 contact links always mean this relay. In builds without
 * an onion configured (Expo Go, unit tests) this is null and every contact is
 * treated as official.
 */
import { ONION_URL } from '../config';
import { relayRefFromOnion, sameRelay, type RelayRef } from './relayRef';

export const OFFICIAL_RELAY: RelayRef | null = relayRefFromOnion(ONION_URL);

/** True for null (= official) and for a ref naming the official onion. */
export function isOfficialRelay(ref: RelayRef | null | undefined): boolean {
  return !ref || sameRelay(ref, OFFICIAL_RELAY);
}

/**
 * Canonical relay to persist/route for a contact: null when it is the official
 * relay (so the DB and the wire stay identical to today for every current user),
 * otherwise the custom ref.
 */
export function canonicalRelay(ref: RelayRef | null | undefined): RelayRef | null {
  return isOfficialRelay(ref) ? null : (ref ?? null);
}
