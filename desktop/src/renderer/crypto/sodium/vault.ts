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
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { vaultBridge } from './vaultIpcBridge';
import type { VaultResult } from '../ipc-types';

/** 'x25519prekey' (SPK / OPK): every X25519 operation; exportable for linked devices without the consent dialog. */
export type VaultKeyType = 'x25519' | 'ed25519' | 'mlkem768' | 'secret32' | 'x25519prekey';

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
export type VaultExportPurpose = 'backup' | 'recoveryPhrase' | 'deviceSync';

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
  // An X25519 prekey does every X25519 operation.
  if (!(key.type === type || (type === 'x25519' && key.type === 'x25519prekey'))) throw new Error(`vault: ${what} needs a ${type} key, got ${key.type}`);
}

/**
 * Persisted form of a vault key: "vault1:" + base64(blob). A string without
 * the prefix is a raw key stored before F-1b (base64), migrated on load.
 */
const STORED_PREFIX = 'vault1:';

export const isVaultStored = (stored: string): boolean => stored.startsWith(STORED_PREFIX);
export const toStored = (blob: Uint8Array): string => STORED_PREFIX + encodeBase64(blob);

/** Non-secret view of a Double Ratchet state (counters, public keys): what the renderer may see. */
export interface RatchetInfo {
  Ns: number;
  Nr: number;
  PN: number;
  hybrid: boolean;
  hasCKs: boolean;
  hasCKr: boolean;
  dhsPublicKey: Uint8Array;
  dhr: Uint8Array | null;
}

export interface RatchetHeader {
  ratchetKey: Uint8Array;
  n: number;
  pn: number;
  pqPub?: Uint8Array;
  pqCt?: Uint8Array;
}

/** A Double Ratchet state sealed by the vault (F-1b phase 3) and its public view. */
export interface SealedRatchet {
  sealed: Uint8Array;
  info: RatchetInfo;
}

/**
 * A pre-F-1b session's raw state, revived from the renderer's old JSON — only
 * for `vault.ratchetImport`, the one-time migration (design doc section 4).
 */
export interface LegacyRatchetState {
  DHs: { publicKey: Uint8Array; secretKey: Uint8Array };
  DHr: Uint8Array | null;
  RK: Uint8Array;
  PQs: { publicKey: Uint8Array; secretKey: Uint8Array } | null;
  PQr: Uint8Array | null;
  pqSendCt: Uint8Array | null;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  skipped: { pub: Uint8Array; n: number; mk: Uint8Array }[];
}

/** Bumped whenever keys are destroyed in bulk (lock, lockAll, destroyProfile): cached handles are stale. */
let lockEpoch = 0;

export const vault = {
  /** Handles cached before a different epoch are dead (see `lockEpoch`). */
  epoch(): number {
    return lockEpoch;
  },

  unlock(slot: string): Promise<void> {
    return Promise.resolve().then(() => call<void>('unlock', slot));
  },
  destroyProfile(slot: string): Promise<void> {
    lockEpoch++;
    return Promise.resolve().then(() => call<void>('destroyProfile', slot));
  },
  lock(slot: string): void {
    lockEpoch++;
    call('lock', slot);
  },
  lockAll(): void {
    lockEpoch++;
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
    // The identity derivation takes the identity key only (exact type, no prekey).
    if (x.type !== 'x25519') throw new Error(`vault: deriveEd25519 needs a x25519 key, got ${x.type}`);
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
   * For 'backup' / 'recoveryPhrase' the main process first asks the user in a
   * native dialog the renderer cannot click (declined → VaultExportDeniedError);
   * 'deviceSync' exports prekeys only, without asking. The caller zeroes the copy.
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
  /**
   * A persisted key (see `toStored`) into a handle of `slot`: a vault blob
   * loads; a raw pre-F-1b key is imported (the caller re-persists `stored`
   * when it differs from what it loaded — that is the one-time migration).
   */
  openStored(slot: string, type: VaultKeyType, stored: string): { key: VaultKey; stored: string } {
    if (isVaultStored(stored)) {
      return { key: vault.load(slot, decodeBase64(stored.slice(STORED_PREFIX.length))), stored };
    }
    const { key, blob } = vault.import(slot, type, decodeBase64(stored));
    return { key, stored: toStored(blob) };
  },
  /** A fresh key of `type` in `slot`, with its persisted form. */
  generateStored(slot: string, type: VaultKeyType): { key: VaultKey; stored: string } {
    const { key, blob } = vault.generate(slot, type);
    return { key, stored: toStored(blob) };
  },
  liveKeys(): number {
    return call<number>('liveKeys');
  },

  // ── Double Ratchet (F-1b phase 3) ──────────────────────────────────────
  // The state runs in the main process and reaches the renderer only sealed
  // under the profile KEK; every step returns a new sealed state.

  /** Alice's state. The vault gets a copy of `rootKey`; the caller zeroes its own. */
  ratchetInitAlice(slot: string, rootKey: Uint8Array, bobSpk: Uint8Array, bobPqSpk: Uint8Array | null): SealedRatchet {
    return call<SealedRatchet>('ratchetInitAlice', slot, rootKey, bobSpk, bobPqSpk);
  },
  /** Bob's state: his SPK (and PQSPK, hybrid) handles are his initial pair; he keeps them. */
  ratchetInitBob(rootKey: Uint8Array, spk: VaultKey, pqSpk: VaultKey | null): SealedRatchet {
    need(spk, 'x25519', 'ratchetInitBob');
    if (pqSpk) {
      need(pqSpk, 'mlkem768', 'ratchetInitBob');
      if (pqSpk.slot !== spk.slot) throw new Error('vault: ratchetInitBob: SPK and PQSPK of different profiles');
    }
    return call<SealedRatchet>('ratchetInitBob', spk.slot, rootKey, spk.handle, pqSpk ? pqSpk.handle : null);
  },
  ratchetEncrypt(slot: string, state: Uint8Array, plaintext: Uint8Array): SealedRatchet & { header: RatchetHeader; nonce: Uint8Array; ciphertext: Uint8Array } {
    return call('ratchetEncrypt', slot, state, plaintext);
  },
  /** The plaintext and the advanced state, or null when the message does not authenticate (state unchanged). */
  ratchetDecrypt(slot: string, state: Uint8Array, header: RatchetHeader, ciphertext: Uint8Array, nonce: Uint8Array): (SealedRatchet & { plaintext: Uint8Array }) | null {
    if (nonce.length !== 24 || ciphertext.length < 16) return null;
    const box = new Uint8Array(24 + ciphertext.length);
    box.set(nonce, 0);
    box.set(ciphertext, 24);
    const h: RatchetHeader = { ratchetKey: header.ratchetKey, n: header.n, pn: header.pn };
    if (header.pqPub && header.pqCt) {
      h.pqPub = header.pqPub;
      h.pqCt = header.pqCt;
    }
    return call('ratchetDecrypt', slot, state, h, box);
  },
  /** Drop skipped message keys older than `Nr - maxAge`. */
  ratchetTrim(slot: string, state: Uint8Array, maxAge: number): SealedRatchet {
    return call<SealedRatchet>('ratchetTrim', slot, state, maxAge);
  },
  /** One-time migration of a pre-F-1b session into the vault; the raw copies are zeroed. */
  ratchetImport(slot: string, raw: LegacyRatchetState): SealedRatchet {
    try {
      return call<SealedRatchet>('ratchetImport', slot, raw);
    } finally {
      raw.DHs.secretKey.fill(0);
      raw.RK.fill(0);
      raw.CKs?.fill(0);
      raw.CKr?.fill(0);
      raw.PQs?.secretKey.fill(0);
      for (const e of raw.skipped) e.mk.fill(0);
    }
  },
};
