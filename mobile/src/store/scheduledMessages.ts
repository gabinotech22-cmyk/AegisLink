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
import type { PostMedia } from '../channels/channelService';
import { toRelativeMediaPath, toAbsoluteMediaUri } from '../utils/mediaPaths';

const MAX_RETRIES = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type ScheduledMessage = StoredScheduledMessage;

/**
 * Publish-time options for a scheduled group post (mirrors the compose screen
 * toggles). Persisted at-rest encrypted in scheduled_messages.post_meta.
 */
export interface GroupPostOptions {
  /** Publish as the group identity (announcement) instead of as the author. */
  asGroup: boolean;
  /** Highlight/pin the announcement on publish. */
  pinned: boolean;
  /** When false the wire body carries the 's' flag → receivers skip the banner. */
  notify: boolean;
  /** When false the post renders as read-only ('r' flag). */
  replies: boolean;
  /** Re-schedule +7 días after each publish, until cancelled. */
  repeatWeekly: boolean;
  /** Local file:// path of the staged, EXIF-stripped image (documentDirectory). */
  imagePath?: string;
  /** Display name shown on the EXIF-stripped badge and queue thumbnail. */
  imageName?: string;
  /**
   * Local file:// path of a staged document (documentDirectory). At fire time
   * it is E2EE-uploaded (encryptAndUploadMedia) and fans out as a second
   * `[file:name:blob…]` message right after the announcement text.
   */
  filePath?: string;
  /** Display name for the staged document ('s' and ':' stripped at fire). */
  fileName?: string;
  /**
   * Poll attached to the post — fans out as a `[poll:q|opt|…]` message after
   * the announcement, reusing the anonymous-voting pipeline untouched.
   */
  poll?: { question: string; options: string[] };
  /** URL appended to the announcement text (FormattedText renders it tappable). */
  linkUrl?: string;
}

export const DEFAULT_POST_OPTIONS: GroupPostOptions = {
  asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: false,
};

/**
 * Permission gate for scheduled group posts: only the group owner (adminId)
 * and moderators may create them. Pure function so the UI gate and the
 * fire-time re-check share one definition.
 */
export function canScheduleGroupPost(
  group: { adminId?: string; moderators?: string[] } | undefined | null,
  myAegisId: string | undefined | null,
): boolean {
  if (!group || !myAegisId) return false;
  if (group.adminId === myAegisId) return true;
  return group.moderators?.includes(myAegisId) ?? false;
}

/**
 * Permission gate for scheduled channel posts: open channels allow any
 * subscriber; readonly/moderated/approval channels only allow the owner.
 * Pure function so the UI gate and the fire-time re-check share one definition.
 */
export function canScheduleChannelPost(
  summary: { channelType?: string; owned?: boolean } | undefined | null,
  hasIdentity: boolean,
): boolean {
  if (!summary || !hasIdentity) return false;
  if (summary.channelType === 'open') return true;
  return summary.owned === true;
}

/**
 * Decrypt + parse the at-rest post options, falling back to defaults on any
 * missing/corrupt input. Shared by the fire path and the cleanup paths.
 */
async function decryptPostOptions(postMeta: string | undefined): Promise<GroupPostOptions> {
  if (!postMeta) return DEFAULT_POST_OPTIONS;
  const { decryptBody } = require('../db/local') as typeof import('../db/local');
  const metaJson = await decryptBody(postMeta);
  if (!metaJson || metaJson === '[DECRYPTION_ERROR]') return DEFAULT_POST_OPTIONS;
  try {
    const parsed = { ...DEFAULT_POST_OPTIONS, ...(JSON.parse(metaJson) as Partial<GroupPostOptions>) };
    // Staged file paths were persisted RELATIVE (see encryptPostOptions below);
    // resolve against the current container's directories on read.
    if (parsed.imagePath) parsed.imagePath = toAbsoluteMediaUri(parsed.imagePath);
    if (parsed.filePath) parsed.filePath = toAbsoluteMediaUri(parsed.filePath);
    return parsed;
  } catch {
    return DEFAULT_POST_OPTIONS;
  }
}

/** Serialize post options with staged file paths made container-independent. */
function encryptablePostOptions(options: GroupPostOptions): GroupPostOptions {
  return {
    ...options,
    imagePath: options.imagePath ? toRelativeMediaPath(options.imagePath) : options.imagePath,
    filePath: options.filePath ? toRelativeMediaPath(options.filePath) : options.filePath,
  };
}

/**
 * Best-effort removal of a staged post file (image or document). Staged files
 * are the only plaintext artifacts of a scheduled post, so every path that
 * stops referencing them (cancel, edit-replace, publish) must unlink them.
 * Cleanup only — never throws, and refuses paths outside the staging directory.
 */
async function deleteStagedPostFile(path: string | undefined): Promise<void> {
  if (!path || !path.includes('scheduledposts/')) return;
  try {
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    await FS.deleteAsync(path, { idempotent: true });
  } catch { /* best-effort */ }
}

/** Unlink every staged file referenced by a post's options. */
async function deleteStagedPostFiles(options: GroupPostOptions): Promise<void> {
  await deleteStagedPostFile(options.imagePath);
  await deleteStagedPostFile(options.filePath);
}

/**
 * A staged media attachment for a scheduled CHANNEL post: a local file kept in
 * documentDirectory/channelposts/ until fire time, when it is uploaded as an
 * E2EE blob and turned into a sealed PostMedia. Covers image/audio/gif alike.
 */
export interface ChannelPostStagedMedia {
  kind: PostMedia['kind'];
  /** Staged local file path (documentDirectory/channelposts/). */
  path: string;
  /** MIME used for the E2EE upload (e.g. 'image/jpeg', 'image/gif', 'audio/m4a'). */
  mime: string;
  w?: number;
  h?: number;
  durationMs?: number;
}

/**
 * Publish-time options for a scheduled CHANNEL post. Channels broadcast a single
 * sealed feed entry, so the only option is an optional staged media attachment
 * (uploaded as an E2EE blob at fire time). Persisted at-rest encrypted in post_meta.
 */
export interface ChannelPostOptions {
  media?: ChannelPostStagedMedia;
}

/** Decrypt + parse the at-rest channel post options; defaults to none on any failure. */
async function decryptChannelPostOptions(postMeta: string | undefined): Promise<ChannelPostOptions> {
  if (!postMeta) return {};
  const { decryptBody } = require('../db/local') as typeof import('../db/local');
  const metaJson = await decryptBody(postMeta);
  if (!metaJson || metaJson === '[DECRYPTION_ERROR]') return {};
  try {
    const parsed = JSON.parse(metaJson) as ChannelPostOptions;
    // Staged media path persisted RELATIVE -- resolve against the current
    // container's directories on read (see encryptableChannelPostOptions).
    if (parsed.media) parsed.media = { ...parsed.media, path: toAbsoluteMediaUri(parsed.media.path) };
    return parsed;
  } catch {
    return {};
  }
}

/** Serialize channel post options with the staged media path made container-independent. */
function encryptableChannelPostOptions(options: ChannelPostOptions): ChannelPostOptions {
  if (!options.media) return options;
  return { ...options, media: { ...options.media, path: toRelativeMediaPath(options.media.path) } };
}

/** Unlink a staged channel-post file. Refuses paths outside the staging dir. */
async function deleteStagedChannelFile(path: string | undefined): Promise<void> {
  if (!path || !path.includes('channelposts/')) return;
  try {
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    await FS.deleteAsync(path, { idempotent: true });
  } catch { /* best-effort */ }
}

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

  /**
   * Schedule (or update, when `id` is given) a group post — owner/moderators
   * only; enforce with canScheduleGroupPost at the call site (re-checked at
   * fire time). Text and options are stored at-rest encrypted (encryptBody /
   * SecureStore key) and ratchet-encrypted at FIRE time via sendGroupMessage,
   * so the fan-out always uses fresh membership and a fresh admin signature.
   * status 'draft' parks the post in the queue without firing.
   */
  scheduleGroupPost(opts: {
    groupId: string;
    plaintext: string;
    sendAt: number;
    options?: GroupPostOptions;
    /** Provide to update an existing post/draft in place. */
    id?: string;
    status?: 'pending' | 'draft';
  }): Promise<void>;

  /**
   * Schedule a channel post — text only, no attachments. The body is stored
   * at-rest encrypted (encryptBody). At fire time processDue calls
   * useChannels.getState().sendPost(), re-checking the permission gate.
   */
  scheduleChannelPost(opts: {
    channelId: string;
    body: string;
    sendAt: number;
    id?: string;
    status?: 'pending' | 'draft';
    /** Optional media (staged image path). Uploaded as an E2EE blob at fire time. */
    options?: ChannelPostOptions;
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

export const useScheduledMessages = create<ScheduledState>((set, get) => ({
  scheduled: [],

  async scheduleMessage({ identity, recipientAegisId, recipientPublicKeyB64, plaintext, sendAt }) {
    const { encryptMessage } = require('../crypto/messaging') as typeof import('../crypto/messaging');
    const { loadRatchetSession, saveRatchetSession } = require('../db/local') as typeof import('../db/local');
    const { decodeBase64 } = require('tweetnacl-util') as typeof import('tweetnacl-util');
    const { trimOldSkippedKeys, MAX_SKIPPED_KEYS } = require('../crypto/signal/ratchet') as typeof import('../crypto/signal/ratchet');
    const { getSocket, isConnected } = require('../socket/client') as typeof import('../socket/client');

    const { useIdentity } = require('./identity') as typeof import('./identity');
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
      const { useContacts } = require('./contacts') as typeof import('./contacts');
      const contact = useContacts.getState().contacts.find((c) => c.aegisId === recipientAegisId);
      if (!contact) throw new Error('Contacto no encontrado');

      const { performX3DH } = require('../crypto/signal/x3dh') as typeof import('../crypto/signal/x3dh');
      const { initRatchet } = require('../crypto/signal/ratchet') as typeof import('../crypto/signal/ratchet');
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

  async scheduleGroupPost({ groupId, plaintext, sendAt, options, id, status }) {
    const { encryptBody } = require('../db/local') as typeof import('../db/local');
    // When updating, capture the previously staged files so a replaced or
    // removed image/document doesn't linger on disk once the row stops
    // referencing it.
    let previousOptions: GroupPostOptions | null = null;
    if (id) {
      const prev = get().scheduled.find((m) => m.id === id);
      if (prev) previousOptions = await decryptPostOptions(prev.postMeta);
    }
    // At-rest encryption with the SecureStore-held DB key — same protection
    // level as the outbox plaintext and ratchet sessions. Ratchet encryption
    // happens at fire time (processDue) against fresh group membership.
    const encryptedPayload = await encryptBody(plaintext);
    const postMeta = await encryptBody(JSON.stringify(encryptablePostOptions(options ?? DEFAULT_POST_OPTIONS)));
    const stored: StoredScheduledMessage = {
      id: id ?? Crypto.randomUUID(),
      recipientAegisId: groupId,
      groupId,
      encryptedPayload,
      postMeta,
      sendAt,
      createdAt: Date.now(),
      status: status ?? 'pending',
      retryCount: 0,
    };
    await saveScheduled(stored); // INSERT OR REPLACE — same id updates in place
    if (previousOptions) {
      const next = options ?? DEFAULT_POST_OPTIONS;
      if (previousOptions.imagePath && previousOptions.imagePath !== next.imagePath) {
        await deleteStagedPostFile(previousOptions.imagePath);
      }
      if (previousOptions.filePath && previousOptions.filePath !== next.filePath) {
        await deleteStagedPostFile(previousOptions.filePath);
      }
    }
    set((s) => {
      const exists = s.scheduled.some((m) => m.id === stored.id);
      return {
        scheduled: exists
          ? s.scheduled.map((m) => (m.id === stored.id ? stored : m))
          : [...s.scheduled, stored],
      };
    });
  },

  async scheduleChannelPost({ channelId, body, sendAt, id, status, options }) {
    const { encryptBody } = require('../db/local') as typeof import('../db/local');
    const encryptedPayload = await encryptBody(body);
    // Editing an existing row: unlink a staged media file being replaced/dropped.
    if (id) {
      const prev = get().scheduled.find((m) => m.id === id);
      if (prev?.postMeta) {
        const prevPath = (await decryptChannelPostOptions(prev.postMeta)).media?.path;
        if (prevPath && prevPath !== options?.media?.path) {
          await deleteStagedChannelFile(prevPath);
        }
      }
    }
    const hasOptions = !!options?.media;
    const postMeta = hasOptions ? await encryptBody(JSON.stringify(encryptableChannelPostOptions(options as ChannelPostOptions))) : undefined;
    const stored: StoredScheduledMessage = {
      id: id ?? Crypto.randomUUID(),
      recipientAegisId: channelId,
      channelId,
      encryptedPayload,
      sendAt,
      createdAt: Date.now(),
      status: status ?? 'pending',
      retryCount: 0,
      postMeta,
    };
    await saveScheduled(stored);
    set((s) => {
      const exists = s.scheduled.some((m) => m.id === stored.id);
      return {
        scheduled: exists
          ? s.scheduled.map((m) => (m.id === stored.id ? stored : m))
          : [...s.scheduled, stored],
      };
    });
  },

  async cancelScheduled(id) {
    const msg = get().scheduled.find((m) => m.id === id);
    await deleteScheduled(id);
    set((s) => ({ scheduled: s.scheduled.filter((m) => m.id !== id) }));
    // Group/channel post: also unlink its staged files — the row no longer
    // exists, so they would otherwise be orphaned plaintext on disk forever.
    if (msg?.groupId && msg.postMeta) {
      await deleteStagedPostFiles(await decryptPostOptions(msg.postMeta));
    }
    if (msg?.channelId && msg.postMeta) {
      await deleteStagedChannelFile((await decryptChannelPostOptions(msg.postMeta)).media?.path);
    }
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

    const { getSocket, isConnected } = require('../socket/client') as typeof import('../socket/client');
    const sock = getSocket();
    const online = sock !== null && isConnected();

    // Local helpers shared by the group branch (mirror the 1:1 retry/fail style)
    const failNow = async (msg: ScheduledMessage, retryCount: number) => {
      await markScheduledFailed(msg.id, retryCount);
      set((s) => ({
        scheduled: s.scheduled.map((m) =>
          m.id === msg.id ? { ...m, status: 'failed' as const, retryCount } : m,
        ),
      }));
    };
    const bumpRetry = async (msg: ScheduledMessage) => {
      const nextRetry = msg.retryCount + 1;
      if (nextRetry >= MAX_RETRIES) {
        await failNow(msg, nextRetry);
      } else {
        await incrementScheduledRetry(msg.id, nextRetry);
        set((s) => ({
          scheduled: s.scheduled.map((m) =>
            m.id === msg.id ? { ...m, retryCount: nextRetry } : m,
          ),
        }));
      }
    };

    for (const msg of due) {
      // ── Scheduled GROUP post: decrypt at-rest plaintext and fan out through
      //    sendGroupMessage with FRESH membership + admin signature. Offline is
      //    fine — sendGroupMessage persists per-member outbox jobs that drain on
      //    reconnect, so no `online` gate here.
      if (msg.groupId) {
        const { useIdentity } = require('./identity') as typeof import('./identity');
        const identity = useIdentity.getState().identity;
        // Identity locked/not loaded (e.g. background wake before unlock):
        // skip WITHOUT burning a retry — it fires on the next run.
        if (!identity) continue;
        try {
          const { getGroup, decryptBody } = require('../db/local') as typeof import('../db/local');
          const group = await getGroup(msg.groupId);
          // Group gone (left/deleted) or author demoted since scheduling —
          // permanent failure, never silently post without authorization.
          if (!group || !canScheduleGroupPost(group, identity.aegisId)) {
            await failNow(msg, msg.retryCount);
            continue;
          }
          const plaintext = await decryptBody(msg.encryptedPayload);
          // Empty text is legitimate (document-only / poll-only posts) — only
          // an actual decryption failure is fatal.
          if (typeof plaintext !== 'string' || plaintext === '[DECRYPTION_ERROR]') {
            await failNow(msg, msg.retryCount);
            continue;
          }

          // Publish options → wire marker flags (see utils/groupPost.ts)
          const options = await decryptPostOptions(msg.postMeta);

          // Posts with a document need the relay NOW for the E2EE blob upload —
          // wait online WITHOUT burning retries (mirrors the 1:1 semantics).
          if (options.filePath && !online) continue;

          // 1) Upload the document blob FIRST — the only remote op that can
          //    fail midway; nothing has fanned out yet if it throws (clean retry).
          let fileWire: { body: string; mediaUri: string } | null = null;
          if (options.filePath) {
            const { encryptAndUploadMedia } = require('../crypto/media') as typeof import('../crypto/media');
            const blobUri = await encryptAndUploadMedia(options.filePath);
            // ':', '[' and ']' would break the [file:name:blob…] parser.
            const safeName = (options.fileName ?? 'file').replace(/[:[\]]/g, '') || 'file';
            fileWire = { body: `[file:${safeName}:${blobUri}]`, mediaUri: blobUri };
          }

          const { buildGroupPostBody } = require('../utils/groupPost') as typeof import('../utils/groupPost');
          // The link rides the announcement text — FormattedText already
          // renders https?:// URLs as tappable links in the bubble.
          const baseText = options.linkUrl
            ? (plaintext.trim().length > 0 ? `${plaintext}\n\n${options.linkUrl}` : options.linkUrl)
            : plaintext;
          const textBody = buildGroupPostBody(baseText, {
            asGroup: options.asGroup,
            pinned: options.pinned,
            silent: !options.notify,
            repliesOff: !options.replies,
          });

          const { sendGroupMessage } = require('../socket/client') as typeof import('../socket/client');

          // 2) Announcement (text/link, image riding the [image:data:…] media
          //    pipeline with the marker in the caption). Skipped for posts that
          //    are only a document and/or poll.
          if (baseText.trim().length > 0 || options.imagePath) {
            let wireBody = textBody;
            let msgType: 'image' | undefined;
            let mediaUri: string | undefined;
            if (options.imagePath) {
              try {
                const { readAsStringAsync, EncodingType } = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
                const b64 = await readAsStringAsync(options.imagePath, { encoding: EncodingType.Base64 });
                wireBody = `[image:data:image/jpeg;base64,${b64}]${textBody}`;
                msgType = 'image';
                mediaUri = options.imagePath;
              } catch {
                // Image file lost (cache cleared) — publish text-only rather than dropping the post.
              }
            }
            await sendGroupMessage({
              identity,
              groupId: msg.groupId,
              plaintext: wireBody,
              ...(msgType ? { msgType, mediaUri } : {}),
            });
          }

          // 3) Document and 4) poll fan out as their own messages so receivers
          //    reuse the existing file/poll bubbles untouched. Each call
          //    persists per-member outbox jobs, so it is durable once made.
          //    (Known limit: these carry no [post:] marker, so the silent flag
          //    only applies to the announcement message.)
          if (fileWire) {
            await sendGroupMessage({
              identity, groupId: msg.groupId,
              plaintext: fileWire.body, msgType: 'file', mediaUri: fileWire.mediaUri,
            });
          }
          if (options.poll && options.poll.options.length >= 2) {
            await sendGroupMessage({
              identity, groupId: msg.groupId,
              plaintext: `[poll:${options.poll.question}|${options.poll.options.join('|')}]`,
              msgType: 'poll',
            });
          }

          if (options.repeatWeekly) {
            // Recurring post: re-arm one week ahead instead of marking sent.
            const next: StoredScheduledMessage = {
              ...msg, sendAt: msg.sendAt + WEEK_MS, retryCount: 0, status: 'pending',
            };
            await saveScheduled(next);
            set((s) => ({
              scheduled: s.scheduled.map((m) => (m.id === msg.id ? next : m)),
            }));
          } else {
            await markScheduledSent(msg.id);
            // Published and never firing again — the staged image travelled
            // inline (base64) and the document went up as an E2EE blob, so
            // unlink the plaintext staging files.
            await deleteStagedPostFiles(options);
            set((s) => ({
              scheduled: s.scheduled.map((m) =>
                m.id === msg.id ? { ...m, status: 'sent' as const } : m,
              ),
            }));
          }
        } catch {
          await bumpRetry(msg);
        }
        continue;
      }

      // ── Scheduled CHANNEL post: decrypt at-rest text and send via
      //    useChannels.sendPost(). Re-checks permission at fire time.
      if (msg.channelId) {
        const { useIdentity } = require('./identity') as typeof import('./identity');
        const identity = useIdentity.getState().identity;
        if (!identity) continue; // locked — skip without burning retry
        try {
          const { useChannels } = require('./channels') as typeof import('./channels');
          // `subscribed` is memory-only and may still be empty this early in a
          // cold launch / background wake (App.tsx's rehydrate effect races
          // this runner). Hydrate before trusting an absence — otherwise a
          // perfectly valid scheduled post is permanently failed just because
          // hydrateSubscribed() hadn't resolved yet.
          if (!useChannels.getState().hydrated) {
            const hydrateOk = await useChannels
              .getState()
              .hydrateSubscribed()
              .then(() => true)
              .catch(() => false);
            // Hydration failed (e.g. offline, manifest fetch error) AND still
            // isn't hydrated — `subscribed` may be empty/stale, so an absence
            // here is not trustworthy. Retry later instead of permanently
            // failing a post whose channel might genuinely still be there.
            if (!hydrateOk && !useChannels.getState().hydrated) {
              await bumpRetry(msg);
              continue;
            }
          }
          const summary = useChannels.getState().subscribed.find(
            (c) => c.channelId === msg.channelId,
          );
          // Channel gone (unsubscribed) or author lost permission — permanent fail.
          if (!canScheduleChannelPost(summary, true)) {
            await failNow(msg, msg.retryCount);
            continue;
          }
          const { decryptBody } = require('../db/local') as typeof import('../db/local');
          const plaintext = await decryptBody(msg.encryptedPayload);
          if (typeof plaintext !== 'string' || plaintext === '[DECRYPTION_ERROR]') {
            await failNow(msg, msg.retryCount);
            continue;
          }

          // Media posts need the relay NOW for the E2EE blob upload — wait online
          // WITHOUT burning retries (mirrors the group-post/1:1 semantics).
          const staged = (await decryptChannelPostOptions(msg.postMeta)).media;
          if (staged && !online) continue;

          let media: PostMedia | null = null;
          if (staged) {
            try {
              const { encryptAndUploadMedia } = require('../crypto/media') as typeof import('../crypto/media');
              const blobUri = await encryptAndUploadMedia(staged.path, staged.mime);
              media = { kind: staged.kind, uri: blobUri, mime: staged.mime, w: staged.w, h: staged.h, durationMs: staged.durationMs };
            } catch {
              // Upload failed (offline mid-way / staged file lost). If there is no
              // text either, retry later rather than posting an empty entry.
              if (!plaintext.trim()) { await bumpRetry(msg); continue; }
            }
          }

          const res = await useChannels.getState().sendPost(msg.channelId, plaintext, identity, undefined, media);
          if (!res.ok) {
            await bumpRetry(msg);
            continue;
          }
          await markScheduledSent(msg.id);
          // Published — the staged plaintext media travelled up as an E2EE blob.
          await deleteStagedChannelFile(staged?.path);
          set((s) => ({
            scheduled: s.scheduled.map((m) =>
              m.id === msg.id ? { ...m, status: 'sent' as const } : m,
            ),
          }));
        } catch {
          await bumpRetry(msg);
        }
        continue;
      }

      // Offline: leave the message pending WITHOUT burning a retry — the
      // runner ticks every few seconds, so counting offline ticks as attempts
      // would mark messages 'failed' after seconds of bad signal. Retries are
      // reserved for actual send failures below.
      if (!online) continue;

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
