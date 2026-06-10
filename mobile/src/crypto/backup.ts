import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { argon2idAsync } from '@noble/hashes/argon2';
import { KDF_ASYNC_TICK_MS } from './nobleNextTickPatch';

// ─── AegisLink encrypted backup format ────────────────────────────────────────
//
// File extension: .aegisbak
// JSON shape:
//   { v: 1 | 2 | 3, salt: base64(32 bytes), nonce: base64(24 bytes), ciphertext: base64 }
//
// Three on-disk envelope formats are supported for backward compatibility.
// AegisLink ALWAYS WRITES v=3 envelopes today, but can still DECRYPT older
// backups produced by earlier app versions (v1 and v2).
//
//   v=1 (legacy)     PBKDF2-HMAC-SHA256, c=100_000, dkLen=32
//   v=2 (legacy)     PBKDF2-HMAC-SHA256, c=600_000, dkLen=32  (OWASP 2023 baseline)
//   v=3 (current)    Argon2id, m=65_536 KiB (64 MiB), t=3, p=1, dkLen=32
//
// Why Argon2id (H-3 finding mitigation):
//   PBKDF2 is NOT memory-hard. A modern attacker can rent an RTX 4090
//   (~500M SHA-256/s) and crack mid-entropy passphrases far faster than
//   intended. The backup envelope contains the user's PRIVATE identity key,
//   so the cost asymmetry must be maximised. Argon2id (winner of the
//   2015 Password Hashing Competition, OWASP top recommendation) requires
//   ~64 MiB of RAM per attempt, which collapses GPU/ASIC parallelism by
//   orders of magnitude.
//
// Runtime note: all KDFs here run as pure JS on Hermes (no JIT), which is
// ~60× slower than Node/V8 for this workload — a v3 derivation takes on the
// order of MINUTES, and even the legacy v2 PBKDF2 takes tens of seconds.
// Every derivation therefore uses the *Async variants, which yield to the
// event loop so the UI stays responsive behind a progress indicator. The v3
// cost itself CANNOT be lowered without a version bump: KDF parameters are
// implied by `v`, not stored in the envelope, so changing them would break
// decryption of every existing v3 backup.
//
// Symmetric cipher in all versions: nacl.secretbox (XSalsa20-Poly1305) —
// authenticated, so MAC failure on wrong passphrase is detected explicitly.
//
// The passphrase NEVER touches disk. Salt, nonce and ciphertext are stored;
// the user must remember the passphrase to restore.

/** Envelope version emitted by encryptBackup today. */
export const BACKUP_VERSION = 3 as const;
export const BACKUP_FILE_EXTENSION = 'aegisbak' as const;

// PBKDF2 iterations — kept ONLY for decrypting legacy v1 / v2 envelopes.
export const BACKUP_PBKDF2_ITERATIONS_V1 = 100_000 as const;
export const BACKUP_PBKDF2_ITERATIONS_V2 = 600_000 as const;

// Argon2id parameters for v3. Tuned for mobile: ~64 MiB RAM, 3 passes, 1 lane.
// RFC 9106 §4 "SECOND RECOMMENDED option" (memory-constrained / interactive).
export const BACKUP_ARGON2_MEMORY = 65536 as const; // KiB → 64 MiB
export const BACKUP_ARGON2_TIME = 3 as const; // iterations (passes)
export const BACKUP_ARGON2_PARALLELISM = 1 as const; // lanes (mobile-safe)

export const BACKUP_KEY_BYTES = 32 as const;
export const BACKUP_SALT_BYTES = 32 as const;
export const BACKUP_MIN_PASSPHRASE_LEN = 12 as const;

/** Supported on-disk envelope versions. */
export type BackupEnvelopeVersion = 1 | 2 | 3;

export interface BackupEnvelope {
  v: BackupEnvelopeVersion;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface BackupContact {
  aegisId: string;
  publicKeyB64: string;
  signingPublicKeyB64?: string;
  name: string;
  verified: boolean;
  addedAt: number;
  color?: string;
  avatarImage?: string | null;
  status?: string;
  muted?: boolean;
  mutedUntil?: number | null;
  zeroTrust?: boolean;
  blocked?: boolean;
  archived?: boolean;
}

/**
 * Mirrors StoredGroup from db/local.ts exactly.
 * Kept as a standalone type here to avoid any circular import with the DB layer.
 */
export interface BackupGroup {
  id: string;
  name: string;
  members: string[];
  createdAt: number;
  avatarColor?: string;
  avatarImage?: string;
  adminOnlyInvite?: boolean;
  moderateNewMembers?: boolean;
  adminId?: string;
  adminSig?: string;
  moderators?: string[];
  admins?: string[];
}

export interface BackupPayload {
  /** Schema version of the inner JSON. Same set as the envelope version. */
  v: BackupEnvelopeVersion;
  createdAt: number;
  identity: {
    aegisId: string;
    publicKeyB64: string;
    secretKeyB64: string;
    signingPublicKeyB64: string;
    signingSecretKeyB64: string;
    createdAt: number;
  };
  profile: {
    displayName: string;
    avatarColor: string;
    avatarImage: string | null;
    profileStatus: string;
  };
  contacts: BackupContact[];
  /**
   * Snapshot of data-only fields from usePreferences (runtime flags excluded).
   * Optional — absent in backups produced before this field was added.
   * Using Record<string,unknown> to avoid a circular import with the store layer.
   */
  preferences?: Record<string, unknown>;
  /** Groups the user was part of at backup time. Optional — absent in legacy backups. */
  groups?: BackupGroup[];
}

export type PassphraseStrength = 'too_short' | 'weak' | 'fair' | 'strong';

export function ratePassphrase(pw: string): PassphraseStrength {
  if (pw.length < BACKUP_MIN_PASSPHRASE_LEN) return 'too_short';
  let classes = 0;
  if (/[a-z]/.test(pw)) classes += 1;
  if (/[A-Z]/.test(pw)) classes += 1;
  if (/[0-9]/.test(pw)) classes += 1;
  if (/[^A-Za-z0-9]/.test(pw)) classes += 1;
  if (pw.length >= 20 && classes >= 3) return 'strong';
  if (pw.length >= 16 && classes >= 2) return 'fair';
  return 'weak';
}

// ─── KDF dispatch ─────────────────────────────────────────────────────────────

function derivePbkdf2(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const pwBytes = decodeUTF8(passphrase);
  return pbkdf2Async(sha256, pwBytes, salt, {
    c: iterations,
    dkLen: BACKUP_KEY_BYTES,
    asyncTick: KDF_ASYNC_TICK_MS,
  });
}

function deriveArgon2id(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const pwBytes = decodeUTF8(passphrase);
  return argon2idAsync(pwBytes, salt, {
    m: BACKUP_ARGON2_MEMORY,
    t: BACKUP_ARGON2_TIME,
    p: BACKUP_ARGON2_PARALLELISM,
    dkLen: BACKUP_KEY_BYTES,
    asyncTick: KDF_ASYNC_TICK_MS,
  });
}

/**
 * Derive a 32-byte symmetric key for the given envelope version.
 * Throws on unsupported versions.
 */
function deriveKeyForVersion(
  passphrase: string,
  salt: Uint8Array,
  version: BackupEnvelopeVersion,
): Promise<Uint8Array> {
  if (version === 1) return derivePbkdf2(passphrase, salt, BACKUP_PBKDF2_ITERATIONS_V1);
  if (version === 2) return derivePbkdf2(passphrase, salt, BACKUP_PBKDF2_ITERATIONS_V2);
  if (version === 3) return deriveArgon2id(passphrase, salt);
  throw new Error(`Unsupported backup version: ${version as number}`);
}

/**
 * Encrypts the payload with a passphrase. Returns a JSON-serialisable envelope.
 * The derived key is wiped from local scope as soon as ciphertext is produced.
 * Always emits BACKUP_VERSION (v3 / Argon2id).
 */
export async function encryptBackup(payload: BackupPayload, passphrase: string): Promise<BackupEnvelope> {
  if (passphrase.length < BACKUP_MIN_PASSPHRASE_LEN) {
    throw new Error(`Passphrase must be at least ${BACKUP_MIN_PASSPHRASE_LEN} characters`);
  }
  const salt = nacl.randomBytes(BACKUP_SALT_BYTES);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const key = await deriveKeyForVersion(passphrase, salt, BACKUP_VERSION);
  try {
    const plaintext = decodeUTF8(JSON.stringify(payload));
    const ciphertext = nacl.secretbox(plaintext, nonce, key);
    return {
      v: BACKUP_VERSION,
      salt: encodeBase64(salt),
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(ciphertext),
    };
  } finally {
    // Best-effort zeroisation of derived key in memory.
    key.fill(0);
  }
}

/**
 * Decrypts a backup envelope with the user's passphrase. Throws on bad
 * passphrase, MAC mismatch, schema mismatch, or unsupported version.
 *
 * Supports envelope versions 1, 2 and 3 (see header for KDF per version).
 */
export async function decryptBackup(envelope: BackupEnvelope, passphrase: string): Promise<BackupPayload> {
  if (envelope.v !== 1 && envelope.v !== 2 && envelope.v !== 3) {
    throw new Error(`Unsupported backup version: ${(envelope as { v: number }).v}`);
  }
  const salt = decodeBase64(envelope.salt);
  const nonce = decodeBase64(envelope.nonce);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = await deriveKeyForVersion(passphrase, salt, envelope.v);
  try {
    const opened = nacl.secretbox.open(ciphertext, nonce, key);
    if (!opened) {
      throw new Error('Incorrect passphrase or corrupted backup');
    }
    const json = encodeUTF8(opened);
    const parsed = JSON.parse(json) as BackupPayload;
    if (
      (parsed.v !== 1 && parsed.v !== 2 && parsed.v !== 3) ||
      !parsed.identity ||
      !Array.isArray(parsed.contacts)
    ) {
      throw new Error('Backup payload schema mismatch');
    }
    return parsed;
  } finally {
    key.fill(0);
  }
}

export function isBackupEnvelope(value: unknown): value is BackupEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.v === 1 || v.v === 2 || v.v === BACKUP_VERSION) &&
    typeof v.salt === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.ciphertext === 'string'
  );
}
