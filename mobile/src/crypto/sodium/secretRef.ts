/**
 * A private key as the X3DH receiver and the ratchet take it (F-1b phase 2):
 * either a key-vault handle — what production passes for the prekeys (SPK,
 * OPK, PQSPK), whose secrets never exist in JavaScript — or raw bytes, which
 * the ratchet's own per-turn keys still are until phase 3 (and which the
 * golden vectors and tests use). Operations dispatch on the kind; raw bytes
 * are zeroed by their owner, handles are released by theirs.
 */
import { nacl, ml_kem768 } from './index';
import { vault, type VaultKey } from './vault';

export type SecretRef = Uint8Array | VaultKey;

export const isVaultKey = (k: SecretRef): k is VaultKey => !(k instanceof Uint8Array);

/** X25519(k, peer); throws on a low-order peer key (all-zero output), either way. */
export function dhWith(k: SecretRef, peerPublic: Uint8Array): Uint8Array {
  return isVaultKey(k) ? vault.scalarMult(k, peerPublic) : nacl.scalarMult(k, peerPublic);
}

/** ML-KEM-768 decapsulation with k. */
export function decapsulateWith(cipherText: Uint8Array, k: SecretRef): Uint8Array {
  return isVaultKey(k) ? vault.mlkemDecapsulate(k, cipherText) : ml_kem768.decapsulate(cipherText, k);
}

/** Zero raw key bytes; a handle belongs to its owner (who releases it) and is left alone. */
export function zeroizeRef(k: SecretRef): void {
  if (!isVaultKey(k)) k.fill(0);
}

/** An independent copy of raw bytes; a handle is shared by reference. */
export function cloneRef<T extends SecretRef>(k: T): T {
  return (isVaultKey(k) ? k : new Uint8Array(k)) as T;
}
