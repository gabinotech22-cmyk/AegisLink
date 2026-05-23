import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

// ─── AegisLink encrypted backup format ────────────────────────────────────────
//
// File extension: .aegisbak
// JSON shape:
//   { v: 1, salt: base64(32 bytes), nonce: base64(24 bytes), ciphertext: base64 }
//
// Key derivation: PBKDF2-HMAC-SHA256, 100_000 iterations, dkLen=32.
// Symmetric cipher: nacl.secretbox (XSalsa20-Poly1305) — authenticated.
//
// The passphrase NEVER touches disk. Salt and ciphertext are stored; the user
// must remember the passphrase to restore.

export const BACKUP_VERSION = 2 as const;
export const BACKUP_FILE_EXTENSION = 'aegisbak' as const;
// OWASP 2023: minimum 600k iterations for PBKDF2-HMAC-SHA256 protecting identity keys
export const BACKUP_PBKDF2_ITERATIONS = 600_000 as const;
export const BACKUP_PBKDF2_ITERATIONS_V1 = 100_000 as const; // legacy — for decrypting v1 backups
export const BACKUP_KEY_BYTES = 32 as const;
export const BACKUP_SALT_BYTES = 32 as const;
export const BACKUP_MIN_PASSPHRASE_LEN = 12 as const;

export interface BackupEnvelope {
  v: 1 | 2;
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

export interface BackupPayload {
  v: typeof BACKUP_VERSION;
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
    activeProfile: 'personal' | 'work';
    displayName: string;
    avatarColor: string;
    avatarImage: string | null;
    profileStatus: string;
    workDisplayName: string;
    workAvatarColor: string;
    workAvatarImage: string | null;
    workProfileStatus: string;
  };
  contacts: BackupContact[];
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

function deriveKey(passphrase: string, salt: Uint8Array, iterations: number = BACKUP_PBKDF2_ITERATIONS): Uint8Array {
  const pwBytes = decodeUTF8(passphrase);
  return pbkdf2(sha256, pwBytes, salt, {
    c: iterations,
    dkLen: BACKUP_KEY_BYTES,
  });
}

/**
 * Encrypts the payload with a passphrase. Returns a JSON-serialisable envelope.
 * The passphrase is wiped from local scope as soon as the key is derived.
 */
export function encryptBackup(payload: BackupPayload, passphrase: string): BackupEnvelope {
  if (passphrase.length < BACKUP_MIN_PASSPHRASE_LEN) {
    throw new Error(`Passphrase must be at least ${BACKUP_MIN_PASSPHRASE_LEN} characters`);
  }
  const salt = nacl.randomBytes(BACKUP_SALT_BYTES);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const key = deriveKey(passphrase, salt);
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
 * passphrase, MAC mismatch, or schema mismatch.
 */
export function decryptBackup(envelope: BackupEnvelope, passphrase: string): BackupPayload {
  if (envelope.v !== 1 && envelope.v !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${envelope.v}`);
  }
  // v1 used 100k iterations; v2+ uses 600k (OWASP 2023)
  const iterations = envelope.v === 1 ? BACKUP_PBKDF2_ITERATIONS_V1 : BACKUP_PBKDF2_ITERATIONS;
  const salt = decodeBase64(envelope.salt);
  const nonce = decodeBase64(envelope.nonce);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = deriveKey(passphrase, salt, iterations);
  try {
    const opened = nacl.secretbox.open(ciphertext, nonce, key);
    if (!opened) {
      throw new Error('Incorrect passphrase or corrupted backup');
    }
    const json = encodeUTF8(opened);
    const parsed = JSON.parse(json) as BackupPayload;
    if (parsed.v !== BACKUP_VERSION || !parsed.identity || !Array.isArray(parsed.contacts)) {
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
    v.v === BACKUP_VERSION &&
    typeof v.salt === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.ciphertext === 'string'
  );
}
