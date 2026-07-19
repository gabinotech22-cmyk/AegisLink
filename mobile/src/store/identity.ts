import { create } from 'zustand';
import { logger } from '../utils/logger';
import * as SecureStore from 'expo-secure-store';
import { ss } from '../utils/secureStore';

// AFTER_FIRST_UNLOCK: required for Android 14 hardware-backed Keystore (StrongBox).
// Without this flag, setItemAsync throws a native NPE on first write on real devices.
const SS_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};
import { createIdentity, identityFromStored, type Identity } from '../crypto/identity';
import { loadIdentity, saveIdentity } from '../db/local';
import { ensureRegistered } from '../crypto/ensureRegistered';
import { toRelativeMediaPath, toAbsoluteMediaUri } from '../utils/mediaPaths';
import { themedAlert } from '../components/AlertHost';

/** Publication status of this identity on the relay. */
export type PublishStatus = 'unknown' | 'publishing' | 'published' | 'failed';

interface IdentityState {
  identity: Identity | null;
  status: 'idle' | 'loading' | 'generating' | 'ready';
  hydrated: boolean;
  error: string | null;
  displayName: string;
  avatarColor: string;
  avatarImage: string | null;
  profileStatus: string;

  /** Whether this identity is confirmed published on the relay. */
  publishStatus: PublishStatus;
  /** Human-readable reason for the last publish failure (null when ok). */
  publishError: string | null;
  /**
   * Relay-requested cooldown (ms) after a 429 rate-limit. The Home retry loop
   * honors this instead of its default backoff so we don't hammer a relay that
   * already told us how long to wait. null when not rate-limited.
   */
  publishRetryAfterMs: number | null;
  /**
   * Absolute deadline (Date.now()-comparable ms) until which no PoW mining or
   * registration attempt should run. Persisted (see COOLDOWN_KEY) as a plain
   * local-operation timestamp — restarting the app must NOT reset the cooldown
   * and re-trigger CPU-heavy PoW mining against a relay that already rate-
   * limited us. null when no cooldown is active.
   */
  publishCooldownUntilMs: number | null;

  // Multi-E2EE Slots State
  activeSlotId: string;
  slotsList: string[];

  hydrate: () => Promise<void>;
  generate: () => Promise<Identity>;
  reset: () => Promise<void>;
  updateProfile: (displayName: string, avatarColor: string, avatarImage: string | null) => Promise<void>;
  updateStatus: (text: string) => Promise<void>;

  /**
   * Trigger ensureRegistered; updates publishStatus/publishError accordingly.
   * `force=true` bypasses the 'published' early-return ONLY — it never
   * bypasses the 'publishing' in-flight guard. Used by socket/client.ts's
   * unknown_identity handler: the relay saying `unknown_identity` is PROOF
   * that a persisted `publishStatus: 'published'` (restored by hydrate() from
   * the `aegis.published.<slot>` flag) is stale — the relay has forgotten us.
   * Without `force`, retryPublish() would no-op on that stale 'published'
   * status, the handler would reconnect anyway, and the relay would reject
   * again — an infinite unknown_identity ⇄ reconnect loop.
   */
  retryPublish: (force?: boolean) => Promise<void>;

  // Multi-E2EE Slots Actions
  createSlot: () => Promise<string>;
  switchSlot: (slotId: string) => Promise<void>;
  deleteSlot: (slotId: string) => Promise<void>;
}

function getPrefKey(key: string, slot: string): string {
  if (slot === 'self') return key;
  const suffix = key.replace(/^aegis\./, '');
  return `aegis.${slot}.${suffix}`;
}

/**
 * Persisted registration cooldown deadline (absolute epoch ms). This is a
 * local-operation timestamp only — no server identifiers, no message
 * metadata — used solely to stop the retry loop from re-mining PoW across
 * app restarts while the relay's 429 window is still open.
 */
const COOLDOWN_KEY = 'aegis.reg.cooldown.v1';

async function loadCooldownUntil(): Promise<number | null> {
  try {
    const raw = await ss.get(COOLDOWN_KEY);
    if (!raw) return null;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= Date.now()) {
      await ss.delete(COOLDOWN_KEY).catch(() => {});
      return null;
    }
    return until;
  } catch {
    return null;
  }
}

async function persistCooldownUntil(until: number | null): Promise<void> {
  try {
    if (until == null) await ss.delete(COOLDOWN_KEY);
    else await ss.set(COOLDOWN_KEY, String(until));
  } catch {
    /* best-effort: persistence is a UX optimization, not a security boundary */
  }
}

/**
 * Internal helper: run ensureRegistered and sync the store's publishStatus.
 * Slot-keyed SecureStore flag is updated on success so hydrate() fast-paths.
 *
 * `silent` is for the every-launch background refresh of an ALREADY-published
 * identity: it skips the visible 'publishing' state (so the "Registering
 * identity" banner doesn't flash on every app open) and swallows a transient
 * rate-limit (429) failure — we are still registered, so a throttled refresh
 * must NOT show an error banner. A genuine loss (e.g. the relay no longer
 * serves our key → verification fails with no retryAfterMs) is still surfaced
 * so the retry loop can re-register.
 */
async function runPublish(identity: Identity, slotId: string, silent = false): Promise<void> {
  // Correctness guard (CodeRabbit PR #301, parity w/ desktop): if the user
  // switches/creates/resets to a DIFFERENT identity or slot while THIS
  // publish is still resolving — e.g. createSlot() backgrounds a publish for
  // a brand-new, non-active slot via `void runPublish(identity, newSlotId)`
  // — the GLOBAL publishStatus/publishError/publishRetryAfterMs fields must
  // never be overwritten by a now-stale slot's outcome. That would corrupt
  // the banner/connectSocket-gate (see utils/socketGate.ts) for whatever
  // identity is actually active now. publishCooldownUntilMs is intentionally
  // exempt from this guard: it reflects a relay/IP-wide rate limit, not a
  // per-slot outcome, so it stays accurate to update regardless of which
  // slot is currently active. The `aegis.published.<slotId>` marker below is
  // already correctly slot-scoped (uses the captured `slotId` param, not
  // live store state), so it is also exempt.
  const isCurrentTarget = () => {
    const s = useIdentity.getState();
    return s.identity?.aegisId === identity.aegisId && s.activeSlotId === slotId;
  };

  // Gate BEFORE any network call / PoW mining: if a relay-issued cooldown is
  // still active, never re-mine — that is exactly the retry storm this fix
  // eliminates. This is the single choke point both retryPublish() and the
  // hydrate()-triggered background publish go through.
  const cooldownUntil = useIdentity.getState().publishCooldownUntilMs;
  if (cooldownUntil != null && Date.now() < cooldownUntil) {
    const retryAfterMs = cooldownUntil - Date.now();
    if (!silent && isCurrentTarget()) {
      useIdentity.setState({
        publishStatus: 'failed',
        publishError: 'rate_limited',
        publishRetryAfterMs: retryAfterMs,
      });
    }
    return;
  }

  if (!silent && isCurrentTarget()) useIdentity.setState({ publishStatus: 'publishing', publishError: null });
  const result = await ensureRegistered(identity);
  if (result.ok) {
    if (isCurrentTarget()) {
      useIdentity.setState({
        publishStatus: 'published',
        publishError: null,
        publishRetryAfterMs: null,
        publishCooldownUntilMs: null,
      });
    }
    void persistCooldownUntil(null);
    // Persist the published flag BEFORE returning (was fire-and-forget): if the
    // process is killed right after a slow first registration, an un-flushed
    // write meant the next cold-start re-ran a VISIBLE (non-silent) publish and
    // re-flashed the "Registering identity" banner for an already-registered
    // identity. The UI banner already cleared via setState above, so awaiting
    // here costs nothing user-visible — runPublish is always called via void.
    try { await SecureStore.setItemAsync(`aegis.published.${slotId}`, '1', SS_OPTS); } catch { /* best-effort */ }
    return;
  }
  // A 429 always sets/persists the cooldown deadline — silent or not — so the
  // NEXT attempt (this session or after a restart) skips PoW mining entirely.
  if (result.retryAfterMs != null) {
    const until = Date.now() + result.retryAfterMs;
    useIdentity.setState({ publishCooldownUntilMs: until });
    void persistCooldownUntil(until);
  }
  // Suppress ONLY a transient rate-limit during a silent (already-published)
  // refresh — staying 'published' avoids a false alarm and the retry storm that
  // caused the 429 in the first place.
  if (silent && result.retryAfterMs != null) {
    if (__DEV__) logger.warn('[identity] silent refresh rate-limited (staying published):', result.error);
    return;
  }
  if (__DEV__) logger.warn('[identity] publish failed:', result.error);
  const errorMsg = result.error ?? 'Unknown error';
  if (isCurrentTarget()) {
    useIdentity.setState({
      publishStatus: 'failed',
      publishError: errorMsg,
      publishRetryAfterMs: result.retryAfterMs ?? null,
    });
  }
  // Visible (non-silent) registration failures must be seen even if the device
  // is currently offline-gated behind NetworkErrorScreen (App.tsx replaces the
  // whole tree at 5s offline, hiding Home's publishError banner underneath).
  // A native-style Modal (themedAlert) renders above ANY screen, so it is the
  // only reliable channel here. Silent background refreshes of an
  // already-published identity intentionally do NOT alert — see the `silent`
  // doc comment on runPublish.
  if (!silent) {
    themedAlert('Registro fallido', errorMsg);
  }
}

export const useIdentity = create<IdentityState>((set, get) => ({
  identity: null,
  status: 'idle',
  hydrated: false,
  error: null,
  displayName: 'you',
  avatarColor: '#05b875',
  avatarImage: null,
  profileStatus: '',

  publishStatus: 'unknown',
  publishError: null,
  publishRetryAfterMs: null,
  publishCooldownUntilMs: null,

  activeSlotId: 'self',
  slotsList: ['self'],

  async hydrate() {
    set({ status: 'loading', error: null });
    try {
      const { usePreferences } = require('./preferences');
      if (usePreferences.getState().duressActive) {
        // Stable decoy: real AegisID + real key material (never all-zero, so
        // forensic analysis can't distinguish it from a genuine identity), but
        // generated ONCE and persisted so every duress unlock shows the SAME
        // decoy account. Two different "accounts" across unlocks would be a
        // dead giveaway that duress mode exists.
        const { getOrCreateDecoyBlob } = require('./duressDecoy') as typeof import('./duressDecoy');
        const { identity: decoy } = await getOrCreateDecoyBlob();
        const decoyIdentity: Identity = identityFromStored({
          publicKeyB64: decoy.publicKeyB64,
          secretKeyB64: decoy.secretKeyB64,
          signingPublicKeyB64: decoy.signingPublicKeyB64,
          signingSecretKeyB64: decoy.signingSecretKeyB64,
          createdAt: decoy.createdAt,
        });
        set({
          identity: decoyIdentity,
          activeSlotId: 'self',
          slotsList: ['self'],
          displayName: decoy.displayName,
          avatarColor: decoy.avatarColor,
          avatarImage: null,
          profileStatus: '',
          status: 'ready',
          hydrated: true,
          // The decoy must never reach the relay: mark it as already published
          // and clear any pending retry/error state, otherwise HomeScreen would
          // see a failed/unknown publish and re-run runPublish() with the decoy
          // identity — registering decoy keys on the relay during coercion.
          publishStatus: 'published',
          publishError: null,
          publishRetryAfterMs: null,
          publishCooldownUntilMs: null,
        });
        return;
      }

      // Parallelize the two independent slot reads — no dependency between them.
      const [activeSlotIdRaw, slotsListRaw] = await Promise.all([
        SecureStore.getItemAsync('aegis.activeSlotId'),
        SecureStore.getItemAsync('aegis.slotsList'),
      ]);
      const activeSlotId = activeSlotIdRaw || 'self';
      const slotsList = slotsListRaw ? JSON.parse(slotsListRaw) : ['self'];

      // Set the active slot in the database manager
      const { setActiveDbSlot } = require('../db/local');
      setActiveDbSlot(activeSlotId);

      const stored = await loadIdentity();
      if (!stored) {
        set({ identity: null, activeSlotId, slotsList, status: 'idle', hydrated: true });
        return;
      }
      const identity = identityFromStored(stored);

      // Parallelize all five independent SecureStore reads (profile + published flag).
      const [
        displayNameRaw,
        avatarColorRaw,
        avatarImageRaw,
        profileStatusRaw,
        alreadyPublished,
      ] = await Promise.all([
        SecureStore.getItemAsync(getPrefKey('aegis.displayName', activeSlotId)),
        SecureStore.getItemAsync(getPrefKey('aegis.avatarColor', activeSlotId)),
        SecureStore.getItemAsync(getPrefKey('aegis.avatarImage', activeSlotId)),
        SecureStore.getItemAsync(getPrefKey('aegis.profileStatus', activeSlotId)),
        SecureStore.getItemAsync(`aegis.published.${activeSlotId}`),
      ]);

      const displayName = displayNameRaw ?? identity.aegisId.toLowerCase().replace(/-/g, '');
      const avatarColor = avatarColorRaw ?? '#05b875';
      // Resolve against the CURRENT container -- avatarImageRaw may be a
      // relative pointer, or a stale absolute URI from a previous install.
      const avatarImage = avatarImageRaw ? toAbsoluteMediaUri(avatarImageRaw) : null;
      const profileStatus = profileStatusRaw ?? '';
      // Re-persist the relative form so subsequent reads skip the migration
      // branch (best-effort -- never block hydrate on this).
      if (avatarImageRaw && avatarImage) {
        const relative = toRelativeMediaPath(avatarImageRaw);
        if (relative !== avatarImageRaw) {
          SecureStore.setItemAsync(getPrefKey('aegis.avatarImage', activeSlotId), relative, SS_OPTS).catch(() => {});
        }
      }

      // Hydrate the persisted registration cooldown deadline (if any). A cold
      // start must NOT forget an active 429 window and re-mine PoW.
      const publishCooldownUntilMs = await loadCooldownUntil();

      // Expose identity to UI immediately regardless of server state.
      set({
        identity,
        activeSlotId,
        slotsList,
        displayName,
        avatarColor,
        avatarImage,
        profileStatus,
        // If we have the stored flag, assume published until we verify otherwise.
        publishStatus: alreadyPublished ? 'published' : 'unknown',
        publishError: null,
        publishRetryAfterMs: publishCooldownUntilMs != null ? publishCooldownUntilMs - Date.now() : null,
        publishCooldownUntilMs,
        status: 'ready',
        hydrated: true,
      });

      // Always run publish in background:
      // - If already flagged: SILENT prekey refresh (no banner flash, 429 ignored).
      // - If not flagged: first registration — visible banner drives the UX.
      void runPublish(identity, activeSlotId, !!alreadyPublished);
    } catch (e) {
      set({ status: 'idle', hydrated: true, error: (e as Error).message });
    }
  },

  async generate() {
    set({ status: 'generating', error: null });
    try {
      const identity = createIdentity();
      await saveIdentity({
        aegisId: identity.aegisId,
        publicKeyB64: identity.publicKeyB64,
        secretKeyB64: identity.secretKeyB64,
        signingPublicKeyB64: identity.signingPublicKeyB64,
        signingSecretKeyB64: identity.signingSecretKeyB64,
        createdAt: identity.createdAt,
      });

      const activeSlotId = get().activeSlotId || 'self';
      const defaultName = identity.aegisId.toLowerCase().replace(/-/g, '');
      const defaultColor = '#05b875';
      await SecureStore.setItemAsync(getPrefKey('aegis.displayName', activeSlotId), defaultName, SS_OPTS);
      await SecureStore.setItemAsync(getPrefKey('aegis.avatarColor', activeSlotId), defaultColor, SS_OPTS);
      await SecureStore.deleteItemAsync(getPrefKey('aegis.avatarImage', activeSlotId));

      // Mark ready immediately — identity is already saved locally.
      // Server registration is best-effort and must never block onboarding.
      const _slotId = get().activeSlotId || 'self';
      set({
        identity,
        displayName: defaultName,
        avatarColor: defaultColor,
        avatarImage: null,
        profileStatus: '',
        publishStatus: 'unknown',
        publishError: null,
        publishRetryAfterMs: null,
        status: 'ready',
      });
      // Registration runs in background; publishStatus will update via runPublish.
      void runPublish(identity, _slotId);
      return identity;
    } catch (e) {
      // Reset status to idle so the user can retry without restarting the app.
      // Surface a human-readable message rather than the raw JSI stack trace.
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: 'idle', error: msg });
      throw e;
    }
  },

  async reset() {
    const slotsList = get().slotsList || ['self'];
    // Gather everything only the LIVE state can still enumerate BEFORE any
    // deletion: the per-contact / per-group SecureStore families and the
    // identity's DIDs are keyed by ids that die with the DB and the stores
    // (see purgeGlobalAppState — SecureStore has no key-enumeration API).
    const aegisIdForPurge = get().identity?.aegisId ?? null;
    let peerIds: string[] = [];
    let groupIds: string[] = [];
    try {
      const { useContacts } = require('./contacts') as typeof import('./contacts');
      peerIds = useContacts.getState().contacts.map((c) => c.aegisId);
    } catch { /* best-effort */ }
    try {
      const { useGroups } = require('./groups') as typeof import('./groups');
      groupIds = useGroups.getState().groups.map((g) => g.id);
    } catch { /* best-effort */ }
    const { deleteIdentitySlot, purgeLockAndDuressSecrets, purgeGlobalAppState } = require('../db/local');
    for (const slot of slotsList) {
      await deleteIdentitySlot(slot).catch(() => {});
    }
    // Also delete global activeSlotId and slotsList keys
    await SecureStore.deleteItemAsync('aegis.activeSlotId').catch(() => {});
    await SecureStore.deleteItemAsync('aegis.slotsList').catch(() => {});

    // Delete-identity must NOT leave the app-lock PIN or coercion (duress) PIN
    // behind: a surviving coercion PIN would still arm the decoy for whatever
    // identity comes next, and a surviving lock PIN would gate it. Clears the
    // same lock/duress/PIN material as a panic wipe and resets in-memory prefs
    // (so appLockEnabled can't strand a PIN-less identity in a permanent lock).
    await (purgeLockAndDuressSecrets as () => Promise<void>)().catch(() => {});

    // Device-global remnants (mailbox roots, delivery tokens, sender keys,
    // push/VoIP tokens, profile list, media dirs, DIDs) — delete-identity must
    // be as factory-clean as a panic wipe.
    try {
      await (purgeGlobalAppState as (o: {
        peerIds?: string[]; groupIds?: string[]; aegisId?: string | null;
      }) => Promise<void>)({ peerIds, groupIds, aegisId: aegisIdForPurge });
    } catch { /* best-effort — per-slot + lock purges above already ran */ }

    // Purge any plaintext-decrypted media from the filesystem cache
    const { purgeCachedDecryptedMedia } = require('../crypto/media');
    await (purgeCachedDecryptedMedia as () => Promise<void>)().catch(() => {});

    // Clear any persisted registration cooldown — a full identity reset means
    // a brand-new identity will register next, unrelated to the old one's ban.
    await persistCooldownUntil(null);

    // Reset all other Zustand stores — DB is already empty, bring memory in sync
    const { useContacts } = require('./contacts');
    const { useGroups } = require('./groups');
    const { useMessages } = require('./messages');
    useContacts.setState({ contacts: [], loading: false, error: null });
    useGroups.setState({ groups: [] });
    useMessages.setState({ byChat: {}, previews: {}, pinnedMsg: {}, unreadCounts: {}, drafts: {}, pendingMediaUri: null });
    set({
      identity: null,
      activeSlotId: 'self',
      slotsList: ['self'],
      displayName: 'you',
      avatarColor: '#05b875',
      avatarImage: null,
      profileStatus: '',
      publishStatus: 'unknown',
      publishError: null,
      publishRetryAfterMs: null,
      publishCooldownUntilMs: null,
      status: 'idle',
    });
  },

  async updateProfile(displayName, avatarColor, avatarImage) {
    const slotId = get().activeSlotId || 'self';

    // If the URI comes from the image picker (file:// or content://), copy it to
    // DocumentDirectory so it survives cache eviction and app restarts.
    // The picker writes to a temporary cache dir that Android can clear at any time.
    let persistentAvatarUri = avatarImage;
    if (
      avatarImage &&
      (avatarImage.startsWith('file://') || avatarImage.startsWith('content://'))
    ) {
      try {
        const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
        const dir = `${FS.documentDirectory}avatars/`;
        await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const rawExt = avatarImage.includes('.')
          ? avatarImage.split('.').pop()?.toLowerCase()
          : undefined;
        const ext = rawExt && rawExt.length <= 4 ? rawExt : 'jpg';
        const destPath = `${dir}${slotId}_avatar.${ext}`;
        await FS.copyAsync({ from: avatarImage, to: destPath });
        persistentAvatarUri = destPath;
      } catch (e) {
        // Non-fatal: fall back to the original URI and log in dev so it is easy to spot
        if (__DEV__) logger.warn('[identity] avatar copy to DocumentDirectory failed:', e);
      }
    }

    await SecureStore.setItemAsync(getPrefKey('aegis.displayName', slotId), displayName, SS_OPTS);
    await SecureStore.setItemAsync(getPrefKey('aegis.avatarColor', slotId), avatarColor, SS_OPTS);
    if (persistentAvatarUri) {
      // Persist a container-independent relative pointer, never the absolute
      // URI -- the sandbox UUID changes across TestFlight builds/reinstalls.
      await SecureStore.setItemAsync(
        getPrefKey('aegis.avatarImage', slotId),
        toRelativeMediaPath(persistentAvatarUri),
        SS_OPTS,
      );
    } else {
      await SecureStore.deleteItemAsync(getPrefKey('aegis.avatarImage', slotId));
    }
    set({ displayName, avatarColor, avatarImage: persistentAvatarUri });

    // Propagate the new profile to all contacts
    const identity = get().identity;
    if (identity) {
      const { broadcastProfileUpdate } = require('../socket/client');
      broadcastProfileUpdate(identity).catch((e: Error) => { if (__DEV__) logger.warn('[identity] profile broadcast failed:', e); });
    }
  },

  async updateStatus(text) {
    const slotId = get().activeSlotId || 'self';
    await SecureStore.setItemAsync(getPrefKey('aegis.profileStatus', slotId), text, SS_OPTS);
    set({ profileStatus: text });

    const identity = get().identity;
    if (identity) {
      try {
        const { broadcastProfileUpdate } = require('../socket/client');
        await broadcastProfileUpdate(identity);
      } catch (e) {
        if (__DEV__) logger.warn('[identity] status broadcast failed:', e);
      }
    }
  },

  async retryPublish(force = false) {
    const { identity, publishStatus, activeSlotId } = get();
    if (!identity) return;
    if (!force && publishStatus === 'published') return; // already confirmed (unless forced — see doc comment)
    if (publishStatus === 'publishing') return; // in-flight — ALWAYS guarded, force never bypasses this
    await runPublish(identity, activeSlotId || 'self');
  },

  // Multi-E2EE Slots Actions
  async createSlot() {
    set({ status: 'generating', error: null });
    try {
      const slotsList = get().slotsList || ['self'];
      
      // Determine next slot ID, e.g. slot_1, slot_2...
      let nextSlotNum = 1;
      while (slotsList.includes(`slot_${nextSlotNum}`)) {
        nextSlotNum++;
      }
      const newSlotId = `slot_${nextSlotNum}`;

      // Create identity for the new slot
      const identity = createIdentity();

      // Temporarily set active slot in db to the new slot to save the identity in the new DB file!
      const { setActiveDbSlot } = require('../db/local');
      const prevSlot = get().activeSlotId;
      setActiveDbSlot(newSlotId);

      await saveIdentity({
        aegisId: identity.aegisId,
        publicKeyB64: identity.publicKeyB64,
        secretKeyB64: identity.secretKeyB64,
        signingPublicKeyB64: identity.signingPublicKeyB64,
        signingSecretKeyB64: identity.signingSecretKeyB64,
        createdAt: identity.createdAt,
      });

      // Save default preferences for the new slot
      const defaultName = identity.aegisId.toLowerCase().replace(/-/g, '');
      const defaultColor = '#05b875';
      await SecureStore.setItemAsync(getPrefKey('aegis.displayName', newSlotId), defaultName, SS_OPTS);
      await SecureStore.setItemAsync(getPrefKey('aegis.avatarColor', newSlotId), defaultColor, SS_OPTS);

      // Publish to server in background; publishStatus is updated by runPublish.
      void runPublish(identity, newSlotId);

      // Reset (don't close) the temp slot's DB reference before switching back.
      // closeAsync() here races against any in-flight DB call and causes
      // "Access to closed resource". resetDbConnection just nulls the pointer.
      const { resetDbConnection } = require('../db/local') as typeof import('../db/local');
      resetDbConnection();

      // Restore active slot
      setActiveDbSlot(prevSlot);

      // Update slotsList
      const newSlotsList = [...slotsList, newSlotId];
      await SecureStore.setItemAsync('aegis.slotsList', JSON.stringify(newSlotsList), SS_OPTS);

      set({ slotsList: newSlotsList, status: 'ready' });
      return newSlotId;
    } catch (e) {
      set({ status: 'ready', error: (e as Error).message });
      throw e;
    }
  },

  async switchSlot(slotId: string) {
    set({ status: 'loading', error: null });
    try {
      // 1. Disconnect socket
      const { getSocket } = require('../socket/client');
      const sock = getSocket();
      if (sock) {
        sock.disconnect();
      }

      // 2. Switch slot FIRST so store resets open the new DB, not the old one.
      const { setActiveDbSlot } = require('../db/local');
      setActiveDbSlot(slotId);

      // 3. Reset Zustand stores in memory (may trigger DB reads on new slot — OK).
      const { useContacts } = require('./contacts');
      const { useGroups } = require('./groups');
      const { useMessages } = require('./messages');
      useContacts.setState({ contacts: [], loading: false, error: null });
      useGroups.setState({ groups: [] });
      useMessages.setState({ byChat: {}, previews: {}, pinnedMsg: {}, unreadCounts: {}, drafts: {}, pendingMediaUri: null });

      // 4. Persist active slot.
      await SecureStore.setItemAsync('aegis.activeSlotId', slotId, SS_OPTS);

      // 5. Hydrate from the new DB
      set({ activeSlotId: slotId });
      await get().hydrate();

      // 6. Connect socket under new identity
      const identity = get().identity;
      if (identity) {
        const { connect } = require('../socket/client');
        connect(identity);
      }
      
      // 7. Hydrate groups and contacts from the new database file
      await useContacts.getState().hydrate().catch(() => {});
      await useGroups.getState().hydrate().catch(() => {});
    } catch (e) {
      set({ status: 'idle', error: (e as Error).message });
      throw e;
    }
  },

  async deleteSlot(slotId: string) {
    try {
      const slotsList = get().slotsList || ['self'];
      const activeSlotId = get().activeSlotId || 'self';
      
      if (slotId === 'self') {
        throw new Error('Cannot delete primary slot');
      }

      // If the slot to delete is currently active, we switch to 'self' first!
      if (slotId === activeSlotId) {
        await get().switchSlot('self');
      }

      // Securely delete from DB and secure preferences
      const { deleteIdentitySlot } = require('../db/local');
      await deleteIdentitySlot(slotId);

      // Remove from list
      const newSlotsList = slotsList.filter((s) => s !== slotId);
      await SecureStore.setItemAsync('aegis.slotsList', JSON.stringify(newSlotsList), SS_OPTS);
      
      set({ slotsList: newSlotsList });
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    }
  },
}));
