import { create } from 'zustand';
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

  // Network
  routeViaTor: boolean;

  // Notifications
  notifMaster: boolean;
  notifPreview: boolean;
  notifSound: boolean;
  notifBadge: boolean;
  notifSummary: boolean;
  notifKeywords: string[];
  mutedChats: string[]; // aegisIds or group ids

  // App lock
  appLockEnabled: boolean;
  biometricsEnabled: boolean;
  lockTimeoutMin: number; // 0 = immediately, 1, 5, 15, 60
  hideRecents: boolean;   // blur app in recents/task switcher

  // Profile visibility (persisted from Profile screen)
  photoVis: 'all' | 'contacts' | 'none';
  lastSeenVisible: boolean;
  typingVisible: boolean;

  // Internationalisation
  language: SupportedLocale;
}

const DEFAULTS: Preferences = {
  readReceipts: false,
  typingIndicator: false,
  blockScreenshots: true,
  routeViaTor: false,
  notifMaster: true,
  notifPreview: false,
  notifSound: true,
  notifBadge: true,
  notifSummary: true,
  notifKeywords: ['urgente', 'multisig', 'audit'],
  mutedChats: [],
  appLockEnabled: false,
  biometricsEnabled: true,
  lockTimeoutMin: 0,
  hideRecents: true,
  photoVis: 'contacts',
  lastSeenVisible: false,
  typingVisible: true,
  language: 'en',
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
    routeViaTor: s.routeViaTor,
    notifMaster: s.notifMaster,
    notifPreview: s.notifPreview,
    notifSound: s.notifSound,
    notifBadge: s.notifBadge,
    notifSummary: s.notifSummary,
    notifKeywords: s.notifKeywords,
    mutedChats: s.mutedChats,
    appLockEnabled: s.appLockEnabled,
    biometricsEnabled: s.biometricsEnabled,
    lockTimeoutMin: s.lockTimeoutMin,
    hideRecents: s.hideRecents,
    photoVis: s.photoVis,
    lastSeenVisible: s.lastSeenVisible,
    typingVisible: s.typingVisible,
    language: s.language,
  };
}

async function persist(prefs: Preferences): Promise<void> {
  try {
    await ss.set(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    if (__DEV__) console.warn('[preferences] persist failed:', (e as Error).message);
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
      if (__DEV__) console.warn('[preferences] hydrate failed:', (e as Error).message);
    }
    setState({ hydrated: true });
  },

  async set(key, value) {
    setState({ [key]: value } as Pick<PrefsState, typeof key>);
    await persist(snapshot(get));
  },

  async reset() {
    setState({ ...DEFAULTS });
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
