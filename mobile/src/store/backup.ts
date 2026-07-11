/**
 * Backup store — Section 10
 *
 * Manages last-backup metadata and orchestrates the backup/restore lifecycle.
 * Crypto is delegated to crypto/backup.ts. File I/O uses expo-file-system/legacy.
 * Passphrase is NEVER persisted — derived key is zeroised in crypto/backup.ts.
 */

import { create } from 'zustand';
import { ss } from '../utils/secureStore';
import * as Sharing from 'expo-sharing';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import {
  encryptBackup,
  decryptBackup,
  isBackupEnvelope,
  BACKUP_FILE_EXTENSION,
  type BackupPayload,
  type BackupEnvelope,
} from '../crypto/backup';
import { saveIdentity, saveContact, closeActiveDatabase } from '../db/local';
import type { StoredContact } from '../db/local';

const LAST_AT_KEY = 'aegis.backup.lastAt' as const;

// ─── Internal helpers ─────────────────────────────────────────────────────────

const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');

function buildFileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `aegislink-backup-${date}.${BACKUP_FILE_EXTENSION}`;
}

async function writeEnvelopeToCacheDir(envelope: BackupEnvelope): Promise<string> {
  const filename = buildFileName();
  const uri = `${FS.cacheDirectory ?? ''}${filename}`;
  await FS.writeAsStringAsync(uri, JSON.stringify(envelope), {
    encoding: FS.EncodingType.UTF8,
  });
  return uri;
}

// ─── Zustand state ────────────────────────────────────────────────────────────

export interface BackupState {
  /** Unix ms of the last successful backup, or null if none. */
  lastBackupAt: number | null;
  isBackingUp: boolean;
  isRestoring: boolean;

  /**
   * Loads `lastBackupAt` from SecureStore into state.
   * Call once on app startup or when the Backup screen mounts.
   */
  loadMeta: () => Promise<void>;

  /**
   * Encrypts the current DB-derived payload with `passphrase` and writes it
   * to the cache directory. Returns the local file URI.
   * The caller is responsible for providing a valid payload built from current
   * store state (identity + contacts) so this store stays dependency-free.
   */
  createLocalBackup: (payload: BackupPayload, passphrase: string) => Promise<string>;

  /**
   * Calls `createLocalBackup` then `expo-sharing`. Throws on sharing failure.
   */
  shareBackup: (payload: BackupPayload, passphrase: string) => Promise<void>;

  /**
   * Reads the file at `fileUri`, decrypts with `passphrase`, restores identity
   * + contacts into SQLite via db/local helpers, then re-initialises the DB.
   * Throws a typed error on wrong passphrase or corrupted data so the caller
   * can surface it with Alert.
   */
  importBackup: (
    fileUri: string,
    passphrase: string,
    onRestored: (payload: BackupPayload) => Promise<void>,
  ) => Promise<void>;
}

export const useBackup = create<BackupState>((set) => ({
  lastBackupAt: null,
  isBackingUp: false,
  isRestoring: false,

  async loadMeta() {
    try {
      const raw = await ss.get(LAST_AT_KEY);
      if (raw) {
        const ts = parseInt(raw, 10);
        if (!Number.isNaN(ts)) set({ lastBackupAt: ts });
      }
    } catch {
      // SecureStore unavailable — non-fatal
    }
  },

  async createLocalBackup(payload, passphrase) {
    set({ isBackingUp: true });
    try {
      const envelope = await encryptBackup(payload, passphrase);
      const uri = await writeEnvelopeToCacheDir(envelope);
      const now = Date.now();
      await ss.set(LAST_AT_KEY, String(now));
      set({ lastBackupAt: now, isBackingUp: false });
      return uri;
    } catch (e) {
      set({ isBackingUp: false });
      throw e;
    }
  },

  async shareBackup(payload, passphrase) {
    const { createLocalBackup } = useBackup.getState();
    const uri = await createLocalBackup(payload, passphrase);
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      throw new Error(`Sharing unavailable on this device. File saved at: ${uri}`);
    }
    await Sharing.shareAsync(uri, {
      mimeType: 'application/octet-stream',
      dialogTitle: 'Save your encrypted AegisLink backup',
    });
  },

  async importBackup(fileUri, passphrase, onRestored) {
    // Duress containment: a restore writes the payload's identity/contacts
    // into the REAL SecureStore + SQLite (overwriting the user's real secret
    // keys). Under coercion that is a data-destruction vector — refuse with
    // the same generic error a corrupt file produces, revealing nothing.
    {
      const { usePreferences } = require('./preferences') as typeof import('./preferences');
      if (usePreferences.getState().duressActive) {
        throw new Error('File is not a valid AegisLink backup envelope');
      }
    }
    set({ isRestoring: true });
    try {
      // Read file as text (envelope is JSON)
      const raw = await FS.readAsStringAsync(fileUri, {
        encoding: FS.EncodingType.UTF8,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('File is not a valid AegisLink backup (JSON parse failed)');
      }

      if (!isBackupEnvelope(parsed)) {
        throw new Error('File is not a valid AegisLink backup envelope');
      }

      // Decrypt — throws on bad passphrase or MAC failure
      const payload = await decryptBackup(parsed, passphrase);

      // Close the active DB so the restore can write to it cleanly
      await closeActiveDatabase();

      // Delegate full restore to caller (identity + contacts + prefs)
      await onRestored(payload);

      set({ isRestoring: false });
    } catch (e) {
      set({ isRestoring: false });
      throw e;
    }
  },
}));
