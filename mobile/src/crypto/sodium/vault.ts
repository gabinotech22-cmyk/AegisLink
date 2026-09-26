/**
 * The key vault (F-1b, docs/F1B-KEY-VAULT-DESIGN.md): private keys that never
 * exist in JavaScript. A `VaultKey` is an opaque handle plus the key's public
 * half; the secret lives in the native vault's guarded memory
 * (`modules/aegis-sodium/cpp/aegis_vault.c`) and leaves it only as a *blob*,
 * encrypted under the profile's key-encryption key (KEK), which the OS keeps
 * (iOS Keychain / Android Keystore) and JavaScript never sees.
 *
 * Callers store blobs where they used to store raw keys, load them back into
 * handles, and run the operation by handle. A profile must be unlocked first.
 *
 * Fail closed: every non-OK native code throws; a blob of another profile or a
 * tampered blob never loads; a released handle or a locked profile throws
 * `VaultKeyUnavailableError` instead of operating.
 */
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import AegisSodium, { AEGIS_OK, AEGIS_EVERIFY, AEGIS_EFAIL, AEGIS_ENOKEY } from '../../../modules/aegis-sodium';

/**
 * 'x25519prekey' (SPK / OPK) does every X25519 operation, but is its own type
 * so the desktop can export it for its linked devices without the consent
 * dialog the identity key needs. Types are authenticated inside the blob.
 */
export type VaultKeyType = 'x25519' | 'ed25519' | 'mlkem768' | 'secret32' | 'x25519prekey';

const TYPE_ID: Record<VaultKeyType, number> = { x25519: 1, ed25519: 2, mlkem768: 3, secret32: 4, x25519prekey: 5 };
const TYPE_NAME: Record<number, VaultKeyType> = { 1: 'x25519', 2: 'ed25519', 3: 'mlkem768', 4: 'secret32', 5: 'x25519prekey' };
const KEY_LEN: Record<VaultKeyType, number> = { x25519: 32, ed25519: 64, mlkem768: 2400, secret32: 32, x25519prekey: 32 };
const PUB_LEN: Record<VaultKeyType, number> = { x25519: 32, ed25519: 32, mlkem768: 1184, secret32: 0, x25519prekey: 32 };
const BLOB_HEADER = 28;
const SLOT_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface VaultKey {
  /** Opaque 4-byte handle; meaningless outside this process. */
  readonly handle: Uint8Array;
  readonly slot: string;
  readonly type: VaultKeyType;
  /** The public half (empty for 'secret32'). */
  readonly publicKey: Uint8Array;
}

/** A key plus the blob to persist it with. */
export interface VaultKeyWithBlob {
  key: VaultKey;
  blob: Uint8Array;
}

/** The profile is locked, or the handle was released / belongs to another key type. */
export class VaultKeyUnavailableError extends Error {
  constructor(what: string) {
    super(`vault: ${what}: key not available (profile locked or key released)`);
    this.name = 'VaultKeyUnavailableError';
  }
}

/** A blob that is not this profile's, or was altered. */
export class VaultBlobRejectedError extends Error {
  constructor() {
    super('vault: blob rejected (another profile, or tampered)');
    this.name = 'VaultBlobRejectedError';
  }
}

function check(rc: number, what: string): void {
  if (rc === AEGIS_OK) return;
  if (rc === AEGIS_ENOKEY) throw new VaultKeyUnavailableError(what);
  throw new Error(`vault: ${what} failed (${rc})`);
}

function slotBytes(slot: string): Uint8Array {
  if (!SLOT_RE.test(slot)) throw new Error('vault: bad slot name');
  return new TextEncoder().encode(slot);
}

// Blob v2: "AV" | 2 | type | nonce | secretbox(type | slotlen | slot | key).
const blobLen = (slot: Uint8Array, type: VaultKeyType): number => BLOB_HEADER + 16 + 2 + slot.length + KEY_LEN[type];

function freshKey(slot: string, type: VaultKeyType, what: string, run: (h: Uint8Array, blob: Uint8Array, pub: Uint8Array, s: Uint8Array) => number): VaultKeyWithBlob {
  const s = slotBytes(slot);
  const handle = new Uint8Array(4);
  const blob = new Uint8Array(blobLen(s, type));
  const publicKey = new Uint8Array(PUB_LEN[type]);
  check(run(handle, blob, publicKey, s), what);
  return { key: { handle, slot, type, publicKey }, blob };
}

function need(key: VaultKey, type: VaultKeyType, what: string): void {
  // An X25519 prekey does every X25519 operation.
  const ok = key.type === type || (type === 'x25519' && key.type === 'x25519prekey');
  if (!ok) throw new Error(`vault: ${what} needs a ${type} key, got ${key.type}`);
}

/**
 * Persisted form of a vault key: "vault1:" + base64(blob). A string without
 * the prefix is a raw key stored before F-1b (base64), migrated on load.
 */
const STORED_PREFIX = 'vault1:';

export const isVaultStored = (stored: string): boolean => stored.startsWith(STORED_PREFIX);
export const toStored = (blob: Uint8Array): string => STORED_PREFIX + encodeBase64(blob);

/** Bumped whenever keys are destroyed in bulk (lock, lockAll, destroyProfile): cached handles are stale. */
let lockEpoch = 0;

export const vault = {
  /** Handles cached before a different epoch are dead (see `lockEpoch`). */
  epoch(): number {
    return lockEpoch;
  },

  /** Make a profile usable: its KEK goes from the OS store into the native vault. */
  unlock(slot: string): Promise<void> {
    slotBytes(slot);
    return AegisSodium.vaultUnlock(slot);
  },

  /** Panic / profile wipe: destroy the profile's keys and forget its KEK (blobs become unreadable). */
  destroyProfile(slot: string): Promise<void> {
    slotBytes(slot);
    lockEpoch++;
    return AegisSodium.vaultDestroyProfile(slot);
  },

  /** Destroy the profile's keys in memory; its KEK stays in the OS store. */
  lock(slot: string): void {
    lockEpoch++;
    check(AegisSodium.vaultLock(slot), 'lock');
  },

  lockAll(): void {
    lockEpoch++;
    check(AegisSodium.vaultLockAll(), 'lockAll');
  },

  generate(slot: string, type: VaultKeyType): VaultKeyWithBlob {
    return freshKey(slot, type, 'generate', (h, blob, pub, s) => AegisSodium.vaultGenerate(h, blob, pub, s, TYPE_ID[type]));
  },

  /**
   * Take a raw key into the vault (one-time migration of keys stored before
   * F-1b). The caller's copy is zeroed once the vault has it.
   */
  import(slot: string, type: VaultKeyType, raw: Uint8Array): VaultKeyWithBlob {
    try {
      if (raw.length !== KEY_LEN[type]) throw new Error(`vault: import needs ${KEY_LEN[type]} bytes`);
      return freshKey(slot, type, 'import', (h, blob, pub, s) => AegisSodium.vaultImport(h, blob, pub, s, TYPE_ID[type], raw));
    } finally {
      raw.fill(0);
    }
  },

  /** Load a stored blob of `slot` into a new handle. */
  load(slot: string, blob: Uint8Array): VaultKey {
    const s = slotBytes(slot);
    const handle = new Uint8Array(4);
    const typeOut = new Uint8Array(4);
    const type = TYPE_NAME[blob[3]];
    if (!type) throw new VaultBlobRejectedError();
    const publicKey = new Uint8Array(PUB_LEN[type]);
    const rc = AegisSodium.vaultLoad(handle, typeOut, publicKey, s, blob);
    if (rc === AEGIS_EVERIFY) throw new VaultBlobRejectedError();
    check(rc, 'load');
    return { handle, slot, type, publicKey };
  },

  /** The identity's Ed25519 key: seeded with its X25519 secret (sign.keyPair.fromSeed(boxSecret)). */
  deriveEd25519(x: VaultKey): VaultKeyWithBlob {
    // The identity derivation takes the identity key only (exact type, no prekey).
    if (x.type !== 'x25519') throw new Error(`vault: deriveEd25519 needs a x25519 key, got ${x.type}`);
    return freshKey(x.slot, 'ed25519', 'deriveEd25519', (h, blob, pub) => AegisSodium.vaultDeriveEd25519(h, blob, pub, x.handle));
  },

  /**
   * The same key as a key of another (unlocked) profile. A new profile's
   * identity is minted before its slot exists — the slot name is the
   * identity's own AegisID — so it is created in the active profile and
   * copied over; the caller releases the original.
   */
  copy(key: VaultKey, slot: string): VaultKeyWithBlob {
    const s = slotBytes(slot);
    const handle = new Uint8Array(4);
    const blob = new Uint8Array(blobLen(s, key.type));
    check(AegisSodium.vaultCopy(handle, blob, key.handle, s), 'copy');
    return { key: { handle, slot, type: key.type, publicKey: key.publicKey }, blob };
  },

  release(key: VaultKey): void {
    const rc = AegisSodium.vaultRelease(key.handle);
    if (rc !== AEGIS_OK && rc !== AEGIS_ENOKEY) check(rc, 'release');
  },

  sign(key: VaultKey, message: Uint8Array): Uint8Array {
    need(key, 'ed25519', 'sign');
    const sig = new Uint8Array(64);
    check(AegisSodium.vaultSign(key.handle, sig, message), 'sign');
    return sig;
  },

  /** X25519 with the vault key; throws on a low-order peer key (all-zero output), like scalarMult. */
  scalarMult(key: VaultKey, peerPublic: Uint8Array): Uint8Array {
    need(key, 'x25519', 'scalarMult');
    const q = new Uint8Array(32);
    const rc = AegisSodium.vaultScalarmult(key.handle, q, peerPublic);
    // Same message as the facade's scalarMult, so callers and tests see one error.
    if (rc === AEGIS_EFAIL) throw new Error('scalarMult: low-order point (all-zero shared secret)');
    check(rc, 'scalarMult');
    return q;
  },

  box(key: VaultKey, message: Uint8Array, nonce: Uint8Array, peerPublic: Uint8Array): Uint8Array {
    need(key, 'x25519', 'box');
    const c = new Uint8Array(message.length + 16);
    check(AegisSodium.vaultBox(key.handle, c, message, nonce, peerPublic), 'box');
    return c;
  },

  /** null on a bad MAC (like nacl.box.open). */
  boxOpen(key: VaultKey, box: Uint8Array, nonce: Uint8Array, peerPublic: Uint8Array): Uint8Array | null {
    need(key, 'x25519', 'boxOpen');
    if (box.length < 16) return null;
    const m = new Uint8Array(box.length - 16);
    const rc = AegisSodium.vaultBoxOpen(key.handle, m, box, nonce, peerPublic);
    if (rc === AEGIS_EVERIFY) return null;
    check(rc, 'boxOpen');
    return m;
  },

  mlkemDecapsulate(key: VaultKey, cipherText: Uint8Array): Uint8Array {
    need(key, 'mlkem768', 'mlkemDecapsulate');
    const ss = new Uint8Array(32);
    check(AegisSodium.vaultMlkem768Dec(key.handle, ss, cipherText), 'mlkemDecapsulate');
    return ss;
  },

  /**
   * The raw secret of `key` — the explicit exports ONLY (design doc §5):
   * encrypted backup, device link and the recovery phrase. Every caller is on
   * the allowlist of `crypto/__tests__/vaultExport.guard.test.ts`; the caller
   * zeroes the copy as soon as it is used.
   */
  exportSecret(key: VaultKey): Uint8Array {
    const out = new Uint8Array(KEY_LEN[key.type]);
    check(AegisSodium.vaultExport(key.handle, TYPE_ID[key.type], out), 'export');
    return out;
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

  /** Live handles (tests and leak checks). */
  liveKeys(): number {
    return AegisSodium.vaultLiveKeys();
  },
};
