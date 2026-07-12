import { create } from 'zustand';
import { logger } from '../utils/logger';
import { ss } from '../utils/secureStore';
import type { SupportedLocale } from '../i18n';

/**
 * User preferences — toggles from Privacy + Notifications + Disappearing.
 * Persisted as one JSON blob in SecureStore (well under the 2KB cap).
 */

const STORAGE_KEY = 'aegis.preferences.v1';

export interface Preferences {
  // Privacy / data sharing
  readReceipts: boolean;
  typingIndicator: boolean;
  blockScreenshots: boolean;
  /**
   * When true, being added to a group by someone else creates a PENDING
   * invitation you must accept rather than joining immediately. Enforced
   * entirely on this device (the adder never learns this preference), so it
   * leaks no metadata. Default false = direct add (legacy behavior).
   */
  requireGroupApproval: boolean;

  // Network
  routeViaTor: boolean;

  // Calls — Android persistent foreground service that keeps the socket alive so
  // an incoming call rings with the app killed, WITHOUT Google/FCM (zero-metadata
  // wake). Costs a permanent notification + battery. Android-only (no-op on iOS,
  // which is forced onto VoIP/APNs). See docs/FASE4-CALL-WAKE-DESIGN.md.
  // Default OFF until device-validated; the product target is default-ON on
  // Android once battery + OEM behaviour are confirmed on real hardware.
  callWakeService: boolean;

  // Notifications
  notifMaster: boolean;
  notifPreview: boolean;
  notifSound: boolean;
  notifBadge: boolean;
  notifSummary: boolean;
  notifKeywords: string[];
  mutedChats: string[]; // aegisIds or group ids
  mentionsOnlyChats: string[]; // aegisIds/group ids that only alert on a keyword/mention match
  /**
   * Public channel ids whose post notifications are muted. Device-local only:
   * this list never leaves the encrypted SecureStore blob (the relay must not
   * learn which channels a user follows or mutes).
   */
  mutedChannels: string[];

  // App lock
  appLockEnabled: boolean;
  biometricsEnabled: boolean;
  lockTimeoutMin: number; // 0 = immediately, 1, 5, 15, 60
  hideRecents: boolean;   // blur app in recents/task switcher

  // Profile visibility (persisted from Profile screen)
  photoVis: 'all' | 'contacts' | 'none';

  // Internationalisation
  language: SupportedLocale;

  // Theme
  themeDark: boolean;
  themeAutoMode: boolean;
}

const DEFAULTS: Preferences = {
  readReceipts: false,
  typingIndicator: false,
  blockScreenshots: true,
  requireGroupApproval: false,
  routeViaTor: false,
  callWakeService: false,
  notifMaster: true,
  notifPreview: false,
  notifSound: true,
  notifBadge: true,
  notifSummary: true,
  notifKeywords: ['urgente', 'multisig', 'audit'],
  mutedChats: [],
  mentionsOnlyChats: [],
  mutedChannels: [],
  appLockEnabled: false,
  biometricsEnabled: true,
  lockTimeoutMin: 0,
  hideRecents: true,
  photoVis: 'contacts',
  language: 'en',
  themeDark: true,
  themeAutoMode: false,
};

interface PrefsState extends Preferences {
  hydrated: boolean;
  duressActive: boolean;
  hydrate: () => Promise<void>;
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => Promise<void>;
  reset: () => Promise<void>;
  /**
   * Restore preferences from a backup payload.
   * Merges the provided partial snapshot with DEFAULTS so that backups that
   * predate a newly added field still produce a fully initialised state.
   */
  restoreFrom: (prefs: Partial<Preferences>) => Promise<void>;
}

function snapshot(get: () => PrefsState): Preferences {
  const s = get();
  return {
    readReceipts: s.readReceipts,
    typingIndicator: s.typingIndicator,
    blockScreenshots: s.blockScreenshots,
    requireGroupApproval: s.requireGroupApproval,
    routeViaTor: s.routeViaTor,
    callWakeService: s.callWakeService,
    notifMaster: s.notifMaster,
    notifPreview: s.notifPreview,
    notifSound: s.notifSound,
    notifBadge: s.notifBadge,
    notifSummary: s.notifSummary,
    notifKeywords: s.notifKeywords,
    mutedChats: s.mutedChats,
    mentionsOnlyChats: s.mentionsOnlyChats,
    mutedChannels: s.mutedChannels,
    appLockEnabled: s.appLockEnabled,
    biometricsEnabled: s.biometricsEnabled,
    lockTimeoutMin: s.lockTimeoutMin,
    hideRecents: s.hideRecents,
    photoVis: s.photoVis,
    language: s.language,
    themeDark: s.themeDark,
    themeAutoMode: s.themeAutoMode,
  };
}

async function persist(prefs: Preferences): Promise<void> {
  try {
    await ss.set(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    if (__DEV__) logger.warn('[preferences] persist failed:', (e as Error).message);
  }
}

export const usePreferences = create<PrefsState>((setState, get) => ({
  ...DEFAULTS,
  hydrated: false,
  duressActive: false,

  async hydrate() {
    try {
      const raw = await ss.get(STORAGE_KEY);
      if (raw) {
        const loaded = JSON.parse(raw) as Partial<Preferences>;
        setState({ ...DEFAULTS, ...loaded, hydrated: true });
        return;
      }
    } catch (e) {
      if (__DEV__) logger.warn('[preferences] hydrate failed:', (e as Error).message);
    }
    setState({ hydrated: true });
  },

  async set(key, value) {
    setState({ [key]: value } as Pick<PrefsState, typeof key>);
    await persist(snapshot(get));
  },

  async reset() {
    // A factory reset must never leave duress (decoy) mode armed — it is
    // extra store state outside Preferences, and Zustand's setState is a
    // partial merge, so omitting it here would let a prior `duressActive:
    // true` survive the reset and trap a freshly regenerated identity in
    // decoy mode until the process restarts.
    setState({ ...DEFAULTS, duressActive: false });
    await ss.delete(STORAGE_KEY);
  },

  // Restore preferences from a backup payload. Merges over DEFAULTS so a
  // partial/older backup never leaves required fields undefined, then persists.
  async restoreFrom(prefs) {
    const merged = { ...DEFAULTS, ...prefs };
    setState(merged);
    await persist(merged);
  },
}));
