/**
 * The key vault (F-1b, docs/F1B-KEY-VAULT-DESIGN.md), renderer side: private
 * keys that never exist in the renderer. A `VaultKey` is a handle plus the
 * key's public half; the secret lives in the main process's secure memory
 * (`src/main/crypto/vault/vault.ts`) and leaves it only as a blob encrypted
 * under the profile's KEK, which Electron safeStorage keeps.
 *
 * Same API as mobile's `mobile/src/crypto/sodium/vault.ts` (golden rule #5);
 * handles are numbers here and 4-byte arrays there, both opaque.
 */
import { vaultBridge } from './vaultIpcBridge';
import type { VaultResult } from '../ipc-types';

export type VaultKeyType = 'x25519' | 'ed25519' | 'mlkem768' | 'secret32';

export interface VaultKey {
  /** Opaque handle; meaningless outside this app session. */
  readonly handle: number;
  readonly slot: string;
  readonly type: VaultKeyType;
  /** The public half (empty for 'secret32'). */
  readonly publicKey: Uint8Array;
}

export interface VaultKeyWithBlob {
  key: VaultKey;
  blob: Uint8Array;
}

/** The profile is locked, or the handle was released / belongs to another key type. */
export class VaultKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyUnavailableError';
  }
}

/** The user declined, in the main process's native dialog, to let a raw key out. */
export class VaultExportDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultExportDeniedError';
  }
}

/** Why a raw key may leave the vault (design doc §5): the user is asked first. */
export type VaultExportPurpose = 'backup' | 'recoveryPhrase';

/** A blob that is not this profile's, or was altered. */
export class VaultBlobRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultBlobRejectedError';
  }
}

function call<T>(op: string, ...args: unknown[]): T {
  const r = vaultBridge().call(op, args) as VaultResult;
  if (!r || typeof r !== 'object') throw new Error('vault: bad response from main process');
  if (r.ok) return r.value as T;
  if (r.code === 'NOKEY') throw new VaultKeyUnavailableError(r.message);
  if (r.code === 'REJECTED') throw new VaultBlobRejectedError(r.message);
  if (r.code === 'DENIED') throw new VaultExportDeniedError(r.message);
  throw new Error(r.message);
}

interface Info {
  handle: number;
  type: VaultKeyType;
  publicKey: Uint8Array;
  blob?: Uint8Array;
}

const withBlob = (slot: string, info: Info): VaultKeyWithBlob => ({
  key: { handle: info.handle, slot, type: info.type, publicKey: info.publicKey },
  blob: info.blob as Uint8Array,
});

function need(key: VaultKey, type: VaultKeyType, what: string): void {
  if (key.type !== type) throw new Error(`vault: ${what} needs a ${type} key, got ${key.type}`);
}

export const vault = {
  unlock(slot: string): Promise<void> {
    return Promise.resolve().then(() => call<void>('unlock', slot));
  },
  destroyProfile(slot: string): Promise<void> {
    return Promise.resolve().then(() => call<void>('destroyProfile', slot));
  },
  lock(slot: string): void {
    call('lock', slot);
  },
  lockAll(): void {
    call('lockAll');
  },
  generate(slot: string, type: VaultKeyType): VaultKeyWithBlob {
    return withBlob(slot, call<Info>('generate', slot, type));
  },
  /** One-time migration of a raw key; the caller's copy is zeroed. */
  import(slot: string, type: VaultKeyType, raw: Uint8Array): VaultKeyWithBlob {
    try {
      return withBlob(slot, call<Info>('import', slot, type, raw));
    } finally {
      raw.fill(0);
    }
  },
  load(slot: string, blob: Uint8Array): VaultKey {
    const info = call<Info>('load', slot, blob);
    return { handle: info.handle, slot, type: info.type, publicKey: info.publicKey };
  },
  deriveEd25519(x: VaultKey): VaultKeyWithBlob {
    need(x, 'x25519', 'deriveEd25519');
    return withBlob(x.slot, call<Info>('deriveEd25519', x.handle));
  },
  /**
   * The same key as a key of another (unlocked) profile: a new profile's
   * identity is minted in the active profile (its slot is its own AegisID, not
   * known before) and copied over; the caller releases the original.
   */
  copy(key: VaultKey, slot: string): VaultKeyWithBlob {
    const info = call<Info>('copy', key.handle, slot);
    return { key: { handle: info.handle, slot, type: key.type, publicKey: key.publicKey }, blob: info.blob as Uint8Array };
  },
  /**
   * The raw secret of `key`, for the explicit exports ONLY (design doc §5).
   * The main process first asks the user in a native dialog the renderer
   * cannot click; declined → VaultExportDeniedError. The caller zeroes the copy.
   */
  exportSecret(key: VaultKey, purpose: VaultExportPurpose): Uint8Array {
    return call<Uint8Array>('exportSecret', key.handle, key.type, purpose);
  },
  release(key: VaultKey): void {
    try {
      call('release', key.handle);
    } catch (e) {
      if (!(e instanceof VaultKeyUnavailableError)) throw e;
    }
  },
  sign(key: VaultKey, message: Uint8Array): Uint8Array {
    need(key, 'ed25519', 'sign');
    return call<Uint8Array>('sign', key.handle, message);
  },
  scalarMult(key: VaultKey, peerPublic: Uint8Array): Uint8Array {
    need(key, 'x25519', 'scalarMult');
    return call<Uint8Array>('scalarMult', key.handle, peerPublic);
  },
  box(key: VaultKey, message: Uint8Array, nonce: Uint8Array, peerPublic: Uint8Array): Uint8Array {
    need(key, 'x25519', 'box');
    return call<Uint8Array>('box', key.handle, message, nonce, peerPublic);
  },
  boxOpen(key: VaultKey, box: Uint8Array, nonce: Uint8Array, peerPublic: Uint8Array): Uint8Array | null {
    need(key, 'x25519', 'boxOpen');
    return call<Uint8Array | null>('boxOpen', key.handle, box, nonce, peerPublic);
  },
  mlkemDecapsulate(key: VaultKey, cipherText: Uint8Array): Uint8Array {
    need(key, 'mlkem768', 'mlkemDecapsulate');
    return call<Uint8Array>('mlkemDecapsulate', key.handle, cipherText);
  },
  liveKeys(): number {
    return call<number>('liveKeys');
  },
};
