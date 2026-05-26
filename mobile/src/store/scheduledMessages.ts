/**
 * Scheduled Messages Store — Section 12
 *
 * Security invariants:
 *   - Plaintext NEVER written to disk. Only E2EE ciphertext (wire envelope JSON) is persisted.
 *   - Encryption happens at compose time via the same Double Ratchet path used in client.ts.
 *   - processDue() reads ciphertext from SQLite and emits it directly — no re-encryption needed.
 *   - Background task survival: processDue() reads from SQLite independently of Zustand state.
 */

import { create } from 'zustand';
import * as Crypto from 'expo-crypto';
import {
  saveScheduled,
  loadPendingScheduled,
  loadAllScheduled,
  markScheduledSent,
  markScheduledFailed,
  incrementScheduledRetry,
  deleteScheduled,
  type StoredScheduledMessage,
} from '../db/local';
import type { Identity } from '../crypto/identity';

const MAX_RETRIES = 3;

export type ScheduledMessage = StoredScheduledMessage;

/** Revive JSON-deserialized byte fields back into Uint8Array. Mirrors client.ts logic. */
function reviveBytes(o: unknown): Uint8Array | null {
  if (o === null || o === undefined) return null;
  if (o instanceof Uint8Array) return o;
  if (Array.isArray(o) && o.every((x) => typeof x === 'number')) return new Uint8Array(o);
  if (
    typeof o === 'object' &&
    (o as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((o as { data?: unknown }).data)
  ) {
    return new Uint8Array((o as { data: number[] }).data);
  }
  if (typeof o === 'object' && !Array.isArray(o) && o !== null) {
    const keys = Object.keys(o as object);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const out = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        out[i] = (o as Record<string, number>)[String(i)];
      }
      return out;
    }
  }
  return null;
}

function reviveMkSkipped(raw: unknown): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [k, v] = entry as [unknown, unknown];
    if (typeof k !== 'string') continue;
    const bytes = reviveBytes(v);
    if (bytes) out.set(k, bytes);
  }
  return out;
}

interface ScheduledState {
  scheduled: ScheduledMessage[];

  /** Encrypt now and persist ciphertext. Plaintext never reaches disk. */
  scheduleMessage(opts: {
    identity: Identity;
    recipientAegisId: string;
    recipientPublicKeyB64: string;
    plaintext: string;
    sendAt: number;
  }): Promise<void>;

  /** Cancel (delete) a pending scheduled message. */
  cancelScheduled(id: string): Promise<void>;

  /** Hydrate in-memory list from SQLite (all statuses). */
  loadPending(): Promise<void>;

  /**
   * Process messages whose send_at has elapsed. Called by the background task
   * and by the foreground setInterval runner. Handles retries up to MAX_RETRIES.
   */
  processDue(): Promise<void>;
}

export const useScheduledMessages = create<ScheduledState>((set) => ({
  scheduled: [],

  async scheduleMessage({ identity, recipientAegisId, recipientPublicKeyB64, plaintext, sendAt }) {
    const { encryptMessage } = await import('../crypto/messaging');
    const { loadRatchetSession, saveRatchetSession } = await import('../db/local');
    const { decodeBase64 } = await import('tweetnacl-util');
    const { trimOldSkippedKeys, MAX_SKIPPED_KEYS } = await import('../crypto/signal/ratchet');
    const { getSocket, isConnected } = await import('../socket/client');

    const { useIdentity } = await import('./identity');
    const idState = useIdentity.getState();
    const senderName = idState.displayName;
    const senderColor = idState.avatarColor;

    const payloadObj = {
      type: 'direct_msg',
      text: plaintext,
      senderName,
      senderColor,
      scheduled: true,
    };

    // Load or create ratchet session for this recipient
    let session: import('../crypto/signal/ratchet').RatchetState | null = null;
    const existingJson = await loadRatchetSession(recipientAegisId);

    if (existingJson) {
      const s = JSON.parse(existingJson);
      s.RK = reviveBytes(s.RK);
      s.CKs = reviveBytes(s.CKs);
      s.CKr = reviveBytes(s.CKr);
      s.DHr = reviveBytes(s.DHr);
      s.DHs.publicKey = reviveBytes(s.DHs.publicKey);
      s.DHs.secretKey = reviveBytes(s.DHs.secretKey);
      s.MKSKIPPED = reviveMkSkipped(s.MKSKIPPED);
      session = s as import('../crypto/signal/ratchet').RatchetState;
    } else {
      // Need a socket to fetch prekeys (X3DH Alice side)
      const sock = getSocket();
      if (!sock || !isConnected()) {
        throw new Error('Debes estar conectado para cifrar el primer mensaje a este contacto.');
      }
      const { useContacts } = await import('./contacts');
      const contact = useContacts.getState().contacts.find((c) => c.aegisId === recipientAegisId);
      if (!contact) throw new Error('Contacto no encontrado');

      const { performX3DH } = await import('../crypto/signal/x3dh');
      const { initRatchet } = await import('../crypto/signal/ratchet');
      type PreKeyBundle = import('../crypto/signal/x3dh').PreKeyBundle;
      type AckType = { ok: true; bundle: PreKeyBundle } | { ok: false; error?: string };

      const bundle = await new Promise<PreKeyBundle>((resolve, reject) => {
        sock.emit('prekeys:fetch', { aegisId: recipientAegisId }, (ack: AckType) => {
          if (!ack?.ok) reject(new Error((ack as { ok: false; error?: string }).error ?? 'prekeys_fetch_failed'));
          else resolve(ack.bundle);
        });
      });
      bundle.identityKeyB64 = recipientPublicKeyB64;
      if (contact.signingPublicKeyB64) bundle.signingPublicKeyB64 = contact.signingPublicKeyB64;

      const x3dh = performX3DH(identity, bundle);
      session = initRatchet(x3dh.rootKey, decodeBase64(bundle.signedPreKey.publicKeyB64), true);
      session.x3dhInit = {
        aliceEKB64: x3dh.myEphemeralPublicKeyB64,
        spkId: bundle.signedPreKey.keyId,
        opkId: bundle.oneTimePreKey ? bundle.oneTimePreKey.keyId : null,
      };
    }

    const recipientPublicKey = decodeBase64(recipientPublicKeyB64);
    const { envelope, newState } = encryptMessage(
      JSON.stringify(payloadObj),
      identity.aegisId,
      recipientPublicKey,
      identity.secretKey,
      session,
    );

    // Persist updated ratchet state
    trimOldSkippedKeys(newState, MAX_SKIPPED_KEYS);
    const serialized = {
      RK: newState.RK,
      DHs: newState.DHs,
      DHr: newState.DHr,
      CKs: newState.CKs,
      CKr: newState.CKr,
      Ns: newState.Ns,
      Nr: newState.Nr,
      PN: newState.PN,
      MKSKIPPED: Array.from(newState.MKSKIPPED.entries()),
      x3dhInit: newState.x3dhInit,
    };
    await saveRatchetSession(recipientAegisId, JSON.stringify(serialized));

    // The wire envelope — only ciphertext, never plaintext
    const msgId = Crypto.randomUUID();
    const wirePayload = {
      id: msgId,
      to: recipientAegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    };

    const stored: StoredScheduledMessage = {
      id: msgId,
      recipientAegisId,
      encryptedPayload: JSON.stringify(wirePayload),
      sendAt,
      createdAt: Date.now(),
      status: 'pending',
      retryCount: 0,
    };

    await saveScheduled(stored);
    set((s) => ({ scheduled: [...s.scheduled, stored] }));
  },

  async cancelScheduled(id) {
    await deleteScheduled(id);
    set((s) => ({ scheduled: s.scheduled.filter((m) => m.id !== id) }));
  },

  async loadPending() {
    const all = await loadAllScheduled();
    set({ scheduled: all });
  },

  async processDue() {
    const now = Date.now();
    const pending = await loadPendingScheduled();
    const due = pending.filter((m) => m.sendAt <= now);
    if (due.length === 0) return;

    const { getSocket, isConnected } = await import('../socket/client');
    const sock = getSocket();
    const online = sock !== null && isConnected();

    for (const msg of due) {
      if (!online) {
        const nextRetry = msg.retryCount + 1;
        if (nextRetry >= MAX_RETRIES) {
          await markScheduledFailed(msg.id, nextRetry);
          set((s) => ({
            scheduled: s.scheduled.map((m) =>
              m.id === msg.id ? { ...m, status: 'failed' as const, retryCount: nextRetry } : m,
            ),
          }));
        } else {
          await incrementScheduledRetry(msg.id, nextRetry);
          set((s) => ({
            scheduled: s.scheduled.map((m) =>
              m.id === msg.id ? { ...m, retryCount: nextRetry } : m,
            ),
          }));
        }
        continue;
      }

      try {
        const wirePayload = JSON.parse(msg.encryptedPayload) as {
          id: string;
          to: string;
          ciphertext: string;
          nonce: string;
        };

        await new Promise<void>((resolve, reject) => {
          sock!.emit(
            'envelope',
            wirePayload,
            (ack: { ok: boolean; error?: string } | undefined) => {
              if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'send_failed'));
              else resolve();
            },
          );
        });

        await markScheduledSent(msg.id);
        set((s) => ({
          scheduled: s.scheduled.map((m) =>
            m.id === msg.id ? { ...m, status: 'sent' as const } : m,
          ),
        }));
      } catch {
        const nextRetry = msg.retryCount + 1;
        if (nextRetry >= MAX_RETRIES) {
          await markScheduledFailed(msg.id, nextRetry);
          set((s) => ({
            scheduled: s.scheduled.map((m) =>
              m.id === msg.id ? { ...m, status: 'failed' as const, retryCount: nextRetry } : m,
            ),
          }));
        } else {
          await incrementScheduledRetry(msg.id, nextRetry);
          set((s) => ({
            scheduled: s.scheduled.map((m) =>
              m.id === msg.id ? { ...m, retryCount: nextRetry } : m,
            ),
          }));
        }
      }
    }
  },
}));
