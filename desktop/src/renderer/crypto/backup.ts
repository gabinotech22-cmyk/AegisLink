import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

// ─── AegisLink encrypted backup format ────────────────────────────────────────
//
// File extension: .aegisbak
// JSON shape:
//   { v: 1, salt: base64(32 bytes), nonce: base64(24 bytes), ciphertext: base64 }
//
// Key derivation: PBKDF2-HMAC-SHA256, 100_000 iterations, dkLen=32.
// Symmetric cipher: nacl.secretbox (XSalsa20-Poly1305) — authenticated.
//
// Saving / loading the file on disk is delegated to the caller. Use the
// browser File API (e.g. <input type="file">, URL.createObjectURL) or the
// Electron main process via an IPC channel — this module is pure crypto.

export const BACKUP_VERSION = 1 as const;
export const BACKUP_FILE_EXTENSION = 'aegisbak' as const;
export const BACKUP_PBKDF2_ITERATIONS = 100_000 as const;
export const BACKUP_KEY_BYTES = 32 as const;
export const BACKUP_SALT_BYTES = 32 as const;
export const BACKUP_MIN_PASSPHRASE_LEN = 12 as const;

export interface BackupEnvelope {
  v: typeof BACKUP_VERSION;
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
    displayName: string;
    avatarColor: string;
    avatarImage: string | null;
    profileStatus: string;
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

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  const pwBytes = decodeUTF8(passphrase);
  return pbkdf2(sha256, pwBytes, salt, {
    c: BACKUP_PBKDF2_ITERATIONS,
    dkLen: BACKUP_KEY_BYTES,
  });
}

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
    key.fill(0);
  }
}

export function decryptBackup(envelope: BackupEnvelope, passphrase: string): BackupPayload {
  if (envelope.v !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${envelope.v}`);
  }
  const salt = decodeBase64(envelope.salt);
  const nonce = decodeBase64(envelope.nonce);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = deriveKey(passphrase, salt);
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

/**
 * Helper: trigger a download of the encrypted envelope using the browser
 * Blob/anchor mechanism. The renderer never touches the filesystem directly.
 */
export function downloadBackupBlob(envelope: BackupEnvelope, filename = `aegislink.${BACKUP_FILE_EXTENSION}`): void {
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
