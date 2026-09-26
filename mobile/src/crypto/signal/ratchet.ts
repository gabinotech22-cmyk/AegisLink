/**
 * Double Ratchet (classic, and hybrid X25519 + ML-KEM-768 "R1") — run by the
 * key vault (F-1b phase 3, docs/F1B-KEY-VAULT-DESIGN.md).
 *
 * The state (root, chain and message keys, our DH and ML-KEM pairs) never
 * exists in JavaScript: the vault's C core (`modules/aegis-sodium/cpp/
 * aegis_ratchet.c`) holds it while it runs a step and hands it back SEALED
 * under the profile's KEK. A `RatchetState` is that sealed blob plus its
 * non-secret view (`info`: counters and public keys) and the session metadata
 * the transport keeps next to it (`x3dhInit`, `createdAtMs`).
 *
 * The algorithm and the wire format are those of the JavaScript ratchet this
 * replaces (its TypeScript twin, `modules/aegis-sodium/jest/ratchetCore.ts`,
 * is what the C port is tested against): old and new clients interoperate,
 * and sessions saved before phase 3 are imported once (`socket/ratchetSerde.ts`).
 *
 * Transactional: a step writes a new sealed state; the old one is untouched,
 * so a message that does not authenticate (a forgery, a desync) leaves the
 * session exactly as it was.
 */
import { vault, type VaultKey, type RatchetHeader, type RatchetInfo } from '../sodium/vault';
import { isVaultKey, type SecretRef } from '../sodium/secretRef';

export type { RatchetHeader, RatchetInfo };

export interface RatchetState {
  /** Vault profile (slot) the state is sealed to. */
  slot: string;
  /** The state, sealed by the vault. Replaced (never mutated) by every step. */
  sealed: Uint8Array;
  /** Non-secret view of the state after the last step (counters, public keys). */
  info: RatchetInfo;

  // Optional X3DH initialization parameters for the recipient's trial decryption
  x3dhInit?: {
    aliceEKB64: string;
    spkId: number;
    opkId: number | null;
    // PQXDH (v2) ONLY: base64 of the 1088-byte ML-KEM-768 ciphertext Alice
    // encapsulated to Bob's PQSPK. Bob decapsulates it (with his PQSPK secret)
    // to recover the PQ shared secret and derive the v2 root key. Absent ⇒ v1.
    pqCtB64?: string;
  };

  // Wall-clock time (ms) at which this session was established via X3DH. Used by
  // the transport layer to grant a grace period so a stale, in-flight message on
  // the OLD session cannot trigger a desync-recovery teardown of a freshly
  // negotiated session. Not key material; safe to persist in cleartext-of-session.
  createdAtMs?: number;
}

/**
 * Forward-secrecy bound: hard cap on how many out-of-order message keys we will
 * retain. Lower than Signal's default 2000 to shrink the post-hoc decryption
 * window if the encrypted DB is ever recovered. Cost: clients that miss more
 * than MAX_SKIPPED_KEYS messages on a single chain will lose those messages.
 * Enforced inside the vault (the C core's AEGIS_RATCHET_MAX_SKIPPED).
 */
export const MAX_SKIPPED_KEYS = 50;

/** A secret the caller holds as raw bytes (tests, legacy callers) goes through the vault as a temporary key. */
function asVaultKey(slot: string, ref: SecretRef, type: 'x25519prekey' | 'mlkem768'): { key: VaultKey; temp: boolean } {
  if (isVaultKey(ref)) return { key: ref, temp: false };
  return { key: vault.import(slot, type, Uint8Array.from(ref)).key, temp: true };
}

/**
 * A new session.
 *
 * Alice (`isAlice`, the initiator) passes Bob's SPK public key as
 * `contactDHPublicKey` and, for a hybrid session, Bob's PQSPK public key as
 * `initialPQr`; she turns her first sending chain right away.
 *
 * Bob (the receiver) MUST start from his SPK pair (`initialDHs`) and, hybrid,
 * his PQSPK pair (`initialPQs`), so his first ratchet step matches Alice's:
 * DH(bobSPK.sec, alice.DHs.pub) == DH(alice.DHs.sec, bobSPK.pub). His keys
 * stay his (the vault copies them into the state).
 *
 * The vault takes its own copy of `rootKey` (the X3DH output); the caller
 * zeroes its copy once the session exists (golden rule #9).
 */
export function initRatchet(
  slot: string,
  rootKey: Uint8Array,
  contactDHPublicKey: Uint8Array,
  isAlice: boolean,
  initialDHs?: { publicKey: Uint8Array; secretKey: SecretRef },
  initialPQs?: { publicKey: Uint8Array; secretKey: SecretRef } | null,
  initialPQr?: Uint8Array | null,
): RatchetState {
  if (isAlice) {
    if (initialDHs || initialPQs) {
      throw new Error('Ratchet: the initiator starts from a fresh pair (no initial DHs/PQs)');
    }
    const { sealed, info } = vault.ratchetInitAlice(slot, Uint8Array.from(rootKey), contactDHPublicKey, initialPQr ?? null);
    return { slot, sealed, info, createdAtMs: Date.now() };
  }
  if (!initialDHs) {
    throw new Error('Ratchet: the receiver must start from its SPK pair');
  }
  const spk = asVaultKey(slot, initialDHs.secretKey, 'x25519prekey');
  const pq = initialPQs ? asVaultKey(slot, initialPQs.secretKey, 'mlkem768') : null;
  try {
    if (spk.key.slot !== slot || (pq && pq.key.slot !== slot)) {
      throw new Error('Ratchet: SPK/PQSPK of another profile');
    }
    const { sealed, info } = vault.ratchetInitBob(Uint8Array.from(rootKey), spk.key, pq ? pq.key : null);
    return { slot, sealed, info, createdAtMs: Date.now() };
  } finally {
    if (spk.temp) vault.release(spk.key);
    if (pq?.temp) vault.release(pq.key);
  }
}

export function ratchetEncrypt(state: RatchetState, plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  header: { ratchetKey: Uint8Array; n: number; pn: number; pqPub?: Uint8Array; pqCt?: Uint8Array };
} {
  const r = vault.ratchetEncrypt(state.slot, state.sealed, plaintext);
  state.sealed = r.sealed;
  state.info = r.info;
  return { ciphertext: r.ciphertext, nonce: r.nonce, header: r.header };
}

/**
 * Decrypt one message; the state advances only if it authenticates. Returns
 * null (state untouched) for a message that does not; throws for one the
 * ratchet refuses outright (too many skipped, downgrade, low-order key).
 */
export function ratchetDecrypt(
  state: RatchetState,
  header: { ratchetKey: Uint8Array; n: number; pn: number; pqPub?: Uint8Array; pqCt?: Uint8Array },
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Uint8Array | null {
  const r = vault.ratchetDecrypt(state.slot, state.sealed, header, ciphertext, nonce);
  if (!r) return null;
  state.sealed = r.sealed;
  state.info = r.info;
  return r.plaintext;
}

/**
 * A copy for trial decryption: stepping it never touches the original (the
 * sealed blob is replaced by each step, not mutated, so sharing it is safe).
 */
export function cloneState(state: RatchetState): RatchetState {
  return {
    slot: state.slot,
    sealed: state.sealed,
    info: { ...state.info },
    x3dhInit: state.x3dhInit ? { ...state.x3dhInit } : undefined,
    createdAtMs: state.createdAtMs,
  };
}

/**
 * Drop any skipped keys whose message number is older than `state.Nr - maxAge`.
 * Use this to actively shrink the FS window past inactivity, e.g. on app
 * background or before persisting.
 */
export function trimOldSkippedKeys(state: RatchetState, maxAge: number): void {
  if (maxAge < 0) return;
  const r = vault.ratchetTrim(state.slot, state.sealed, maxAge);
  state.sealed = r.sealed;
  state.info = r.info;
}
