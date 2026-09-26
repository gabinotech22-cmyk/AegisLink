/**
 * TEST ONLY: the raw state inside a vault-sealed ratchet (F-1b phase 3). The
 * app cannot do this — the native vault has no such call; only its Jest
 * stand-in (`modules/aegis-sodium/jest/nodeRatchet.ts`) exposes it, so tests
 * can check what the vault keeps (skipped-key cap, PQ rotation).
 */
import { peekRatchet } from '../../../../modules/aegis-sodium/jest/nodeBackend';
import type { RawRatchetState } from '../../../../modules/aegis-sodium/ratchetState';
import type { RatchetState } from '../../signal/ratchet';

export function peek(state: RatchetState): RawRatchetState {
  return peekRatchet(state.slot, state.sealed);
}
