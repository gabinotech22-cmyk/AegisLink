/**
 * The key vault of the desktop (F-1b, docs/F1B-KEY-VAULT-DESIGN.md), in the
 * Electron MAIN process: private keys live here, in libsodium secure memory
 * (sodium_malloc, no access outside an operation), and the sandboxed renderer
 * only holds numeric handles and wrapped blobs. A renderer XSS can use a handle
 * while the app runs, but can never read or exfiltrate a key.
 *
 * Same contract and blob format as the mobile C vault
 * (`mobile/modules/aegis-sodium/cpp/aegis_vault.c`):
 *   blob v2 = "AV" | 2 | type | nonce(24) | secretbox_KEK(type | slotlen | slot | key)
 * (type and slot authenticated inside the box).
 * The per-profile KEK comes from a `KekStore` (Electron safeStorage in
 * production, `./kekStore.ts`); this module has no Electron import so tests
 * drive it directly.
 */
import sodium from 'sodium-native';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { sha3_256 } from '@noble/hashes/sha3.js';

/** 'x25519prekey' (SPK / OPK): every X25519 operation, its own type for the export policy. */
export type VaultKeyType = 'x25519' | 'ed25519' | 'mlkem768' | 'secret32' | 'x25519prekey';

export const TYPE_ID: Record<VaultKeyType, number> = { x25519: 1, ed25519: 2, mlkem768: 3, secret32: 4, x25519prekey: 5 };
const TYPE_NAME: Record<number, VaultKeyType> = { 1: 'x25519', 2: 'ed25519', 3: 'mlkem768', 4: 'secret32', 5: 'x25519prekey' };
const KEY_LEN: Record<VaultKeyType, number> = { x25519: 32, ed25519: 64, mlkem768: 2400, secret32: 32, x25519prekey: 32 };
const PUB_LEN: Record<VaultKeyType, number> = { x25519: 32, ed25519: 32, mlkem768: 1184, secret32: 0, x25519prekey: 32 };
const VERSION = 2;

/** A key of type `have` serves an operation wanting `want` (an X25519 prekey does every X25519 operation). */
const typeOk = (have: VaultKeyType, want: VaultKeyType): boolean =>
  have === want || (want === 'x25519' && have === 'x25519prekey');
const HEADER = 28;
const MLKEM_EK = 1152;
const SLOT_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_KEYS = 8192;

/** Where the per-profile KEK lives (the OS keychain in production). */
export interface KekStore {
  /** The profile's 32-byte KEK, created on first use. The caller zeroes it. */
  getOrCreate(slot: string): Uint8Array;
  /** Forget it (cryptographic erase of every blob of the profile). */
  destroy(slot: string): void;
}

export class VaultError extends Error {
  constructor(
    readonly code: 'NOKEY' | 'REJECTED' | 'BAD_ARG',
    message: string,
  ) {
    super(`vault: ${message}`);
    this.name = 'VaultError';
  }
}

export interface VaultKeyInfo {
  handle: number;
  type: VaultKeyType;
  publicKey: Uint8Array;
}

interface Entry {
  type: VaultKeyType;
  slot: string;
  secret: Buffer; // sodium_malloc: secure, no access outside an operation
}

function checkSlot(slot: unknown): asserts slot is string {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) throw new VaultError('BAD_ARG', 'bad slot name');
}

function secure(bytes: Uint8Array): Buffer {
  const b = sodium.sodium_malloc(bytes.length);
  b.set(bytes);
  sodium.sodium_mprotect_noaccess(b);
  return b;
}

function publicOf(type: VaultKeyType, secret: Uint8Array): Uint8Array {
  const pub = new Uint8Array(PUB_LEN[type]);
  if (type === 'x25519' || type === 'x25519prekey') sodium.crypto_scalarmult_base(pub, secret);
  else if (type === 'ed25519') pub.set(secret.subarray(32, 64));
  else if (type === 'mlkem768') pub.set(secret.subarray(MLKEM_EK, MLKEM_EK + 1184));
  return pub;
}

export class KeyVault {
  private readonly keks = new Map<string, Buffer>();
  private readonly keys = new Map<number, Entry>();
  private next = 1;

  constructor(private readonly store: KekStore) {}

  unlock(slot: string): void {
    checkSlot(slot);
    if (this.keks.has(slot)) return;
    const kek = this.store.getOrCreate(slot);
    try {
      if (kek.length !== 32) throw new VaultError('BAD_ARG', 'KEK must be 32 bytes');
      this.keks.set(slot, secure(kek));
    } finally {
      kek.fill(0);
    }
  }

  lock(slot: string): void {
    checkSlot(slot);
    for (const [h, e] of this.keys) {
      if (e.slot === slot) this.free(h);
    }
    const kek = this.keks.get(slot);
    if (kek) {
      sodium.sodium_mprotect_readwrite(kek);
      sodium.sodium_memzero(kek);
      this.keks.delete(slot);
    }
  }

  lockAll(): void {
    for (const slot of [...this.keks.keys()]) this.lock(slot);
  }

  destroyProfile(slot: string): void {
    this.lock(slot);
    this.store.destroy(slot);
  }

  generate(slot: string, type: VaultKeyType): VaultKeyInfo & { blob: Uint8Array } {
    this.requireUnlocked(slot);
    const len = KEY_LEN[type];
    if (!len) throw new VaultError('BAD_ARG', 'bad key type');
    let secret: Uint8Array;
    if (type === 'ed25519') {
      secret = new Uint8Array(64);
      sodium.crypto_sign_keypair(new Uint8Array(32), secret);
    } else if (type === 'mlkem768') {
      secret = ml_kem768.keygen().secretKey;
    } else {
      secret = new Uint8Array(32);
      sodium.randombytes_buf(secret);
    }
    try {
      return this.add(slot, type, secret);
    } finally {
      secret.fill(0);
    }
  }

  /** One-time migration of a raw key stored before F-1b. The caller zeroes its copy. */
  import(slot: string, type: VaultKeyType, raw: Uint8Array): VaultKeyInfo & { blob: Uint8Array } {
    this.requireUnlocked(slot);
    if (!KEY_LEN[type] || !(raw instanceof Uint8Array) || raw.length !== KEY_LEN[type]) {
      throw new VaultError('BAD_ARG', 'bad key length');
    }
    if (type === 'ed25519') {
      const pk = new Uint8Array(32);
      const sk = new Uint8Array(64);
      sodium.crypto_sign_seed_keypair(pk, sk, raw.subarray(0, 32));
      sk.fill(0);
      if (sodium.sodium_memcmp(Buffer.from(pk), Buffer.from(raw.subarray(32))) !== true) {
        throw new VaultError('BAD_ARG', 'Ed25519 key does not match its seed');
      }
    }
    if (type === 'mlkem768') {
      const h = sha3_256(raw.subarray(MLKEM_EK, MLKEM_EK + 1184));
      if (!Buffer.from(h).equals(Buffer.from(raw.subarray(MLKEM_EK + 1184, MLKEM_EK + 1216)))) {
        throw new VaultError('BAD_ARG', 'ML-KEM key fails its hash check');
      }
    }
    return this.add(slot, type, raw);
  }

  load(slot: string, blob: Uint8Array): VaultKeyInfo {
    checkSlot(slot);
    if (!(blob instanceof Uint8Array) || blob.length < HEADER + 18 || blob[0] !== 0x41 || blob[1] !== 0x56 || blob[2] !== VERSION) {
      throw new VaultError('REJECTED', 'blob rejected (another profile, or tampered)');
    }
    const type = TYPE_NAME[blob[3]];
    const slotBytes = Buffer.from(slot, 'ascii');
    if (!type || blob.length !== HEADER + 16 + 2 + slotBytes.length + KEY_LEN[type]) {
      throw new VaultError('REJECTED', 'blob rejected (another profile, or tampered)');
    }
    const kek = this.keks.get(slot);
    if (!kek) throw new VaultError('NOKEY', 'profile locked');
    const plain = sodium.sodium_malloc(blob.length - HEADER - 16);
    try {
      const ok = this.withKek(kek, () =>
        sodium.crypto_secretbox_open_easy(plain, blob.subarray(HEADER), blob.subarray(4, HEADER), kek),
      );
      // Type and slot inside the box must match the header and this profile:
      // a relabelled header (identity key posing as a prekey) never loads.
      if (
        !ok ||
        plain[0] !== TYPE_ID[type] ||
        plain[1] !== slotBytes.length ||
        !Buffer.from(plain.subarray(2, 2 + slotBytes.length)).equals(slotBytes)
      ) {
        throw new VaultError('REJECTED', 'blob rejected (another profile, or tampered)');
      }
      const secret = plain.subarray(2 + slotBytes.length);
      const publicKey = publicOf(type, secret);
      return { handle: this.store_(slot, type, secret), type, publicKey };
    } finally {
      sodium.sodium_memzero(plain);
    }
  }

  deriveEd25519(xHandle: number): VaultKeyInfo & { blob: Uint8Array } {
    // The identity derivation takes the identity key only (exact type).
    const x = this.entry(xHandle, 'x25519', true);
    const sk = new Uint8Array(64);
    try {
      this.use(xHandle, 'x25519', (seed) => sodium.crypto_sign_seed_keypair(new Uint8Array(32), sk, seed));
      return this.add(x.slot, 'ed25519', sk);
    } finally {
      sk.fill(0);
    }
  }

  /**
   * The same key as a key of another (unlocked) profile: a new profile's
   * identity is minted before its slot exists (the slot is its own AegisID).
   */
  copy(handle: number, slot: string): VaultKeyInfo & { blob: Uint8Array } {
    this.requireUnlocked(slot);
    const e = typeof handle === 'number' ? this.keys.get(handle) : undefined;
    if (!e) throw new VaultError('NOKEY', 'key not available (locked, released or of another type)');
    let out: (VaultKeyInfo & { blob: Uint8Array }) | null = null;
    this.use(handle, e.type, (secret) => {
      out = this.add(slot, e.type, secret);
    });
    return out as unknown as VaultKeyInfo & { blob: Uint8Array };
  }

  /**
   * The raw key — for the explicit exports ONLY (design doc §5: encrypted
   * backup, recovery phrase). The IPC layer asks the user in a native dialog
   * first (`ipc/vault.ts`); the caller zeroes the copy.
   */
  exportSecret(handle: number, type: VaultKeyType): Uint8Array {
    const out = new Uint8Array(KEY_LEN[type] ?? 0);
    // Exact type: the IPC layer's export policy keys off the declared type.
    this.use(handle, type, (secret) => out.set(secret), true);
    return out;
  }

  release(handle: number): void {
    if (!this.keys.has(handle)) throw new VaultError('NOKEY', 'key released');
    this.free(handle);
  }

  sign(handle: number, message: Uint8Array): Uint8Array {
    const sig = new Uint8Array(64);
    this.use(handle, 'ed25519', (sk) => sodium.crypto_sign_detached(sig, message, sk));
    return sig;
  }

  scalarMult(handle: number, peer: Uint8Array): Uint8Array {
    if (!(peer instanceof Uint8Array) || peer.length !== 32) throw new VaultError('BAD_ARG', 'bad public key size');
    const q = new Uint8Array(32);
    this.use(handle, 'x25519', (sk) => sodium.crypto_scalarmult(q, sk, peer));
    let acc = 0;
    for (const b of q) acc |= b;
    if (acc === 0) throw new VaultError('BAD_ARG', 'low-order point (all-zero shared secret)');
    return q;
  }

  box(handle: number, message: Uint8Array, nonce: Uint8Array, peer: Uint8Array): Uint8Array {
    const c = new Uint8Array(message.length + 16);
    this.use(handle, 'x25519', (sk) => sodium.crypto_box_easy(c, message, nonce, peer, sk));
    return c;
  }

  boxOpen(handle: number, box: Uint8Array, nonce: Uint8Array, peer: Uint8Array): Uint8Array | null {
    if (box.length < 16) return null;
    const m = new Uint8Array(box.length - 16);
    let ok = false;
    this.use(handle, 'x25519', (sk) => {
      ok = sodium.crypto_box_open_easy(m, box, nonce, peer, sk);
    });
    return ok ? m : null;
  }

  mlkemDecapsulate(handle: number, cipherText: Uint8Array): Uint8Array {
    let ss: Uint8Array = new Uint8Array(0);
    this.use(handle, 'mlkem768', (sk) => {
      ss = ml_kem768.decapsulate(cipherText, new Uint8Array(sk.buffer, sk.byteOffset, sk.length));
    });
    return ss;
  }

  liveKeys(): number {
    return this.keys.size;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private requireUnlocked(slot: string): void {
    checkSlot(slot);
    if (!this.keks.has(slot)) throw new VaultError('NOKEY', 'profile locked');
  }

  private add(slot: string, type: VaultKeyType, secret: Uint8Array): VaultKeyInfo & { blob: Uint8Array } {
    const publicKey = publicOf(type, secret);
    const blob = this.wrap(slot, type, secret);
    return { handle: this.store_(slot, type, secret), type, publicKey, blob };
  }

  private wrap(slot: string, type: VaultKeyType, secret: Uint8Array): Uint8Array {
    const kek = this.keks.get(slot);
    if (!kek) throw new VaultError('NOKEY', 'profile locked');
    const s = Buffer.from(slot, 'ascii');
    const plain = sodium.sodium_malloc(2 + s.length + secret.length);
    try {
      plain[0] = TYPE_ID[type];
      plain[1] = s.length;
      plain.set(s, 2);
      plain.set(secret, 2 + s.length);
      const blob = new Uint8Array(HEADER + 16 + plain.length);
      blob.set([0x41, 0x56, VERSION, TYPE_ID[type]]);
      sodium.randombytes_buf(blob.subarray(4, HEADER));
      this.withKek(kek, () => sodium.crypto_secretbox_easy(blob.subarray(HEADER), plain, blob.subarray(4, HEADER), kek));
      return blob;
    } finally {
      sodium.sodium_memzero(plain);
    }
  }

  private store_(slot: string, type: VaultKeyType, secret: Uint8Array): number {
    if (this.keys.size >= MAX_KEYS) throw new VaultError('BAD_ARG', 'too many keys');
    const handle = this.next++;
    this.keys.set(handle, { type, slot, secret: secure(secret) });
    return handle;
  }

  private entry(handle: number, type: VaultKeyType, exact = false): Entry {
    const e = typeof handle === 'number' ? this.keys.get(handle) : undefined;
    if (!e || !(exact ? e.type === type : typeOk(e.type, type))) throw new VaultError('NOKEY', 'key not available (locked, released or of another type)');
    return e;
  }

  private use(handle: number, type: VaultKeyType, fn: (secret: Buffer) => void, exact = false): void {
    const e = this.entry(handle, type, exact);
    sodium.sodium_mprotect_readonly(e.secret);
    try {
      fn(e.secret);
    } finally {
      sodium.sodium_mprotect_noaccess(e.secret);
    }
  }

  private withKek<T>(kek: Buffer, fn: () => T): T {
    sodium.sodium_mprotect_readonly(kek);
    try {
      return fn();
    } finally {
      sodium.sodium_mprotect_noaccess(kek);
    }
  }

  private free(handle: number): void {
    const e = this.keys.get(handle);
    if (!e) return;
    sodium.sodium_mprotect_readwrite(e.secret);
    sodium.sodium_memzero(e.secret);
    this.keys.delete(handle);
  }
}
