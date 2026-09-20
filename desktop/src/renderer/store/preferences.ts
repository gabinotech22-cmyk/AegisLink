import { logger } from '../utils/logger';
import { create } from 'zustand';
import '../crypto/ipc-types';

/**
 * User preferences — persisted as one JSON blob in window.aegis.secureStorage.
 * The `language` field is a string (no shared i18n module yet); replace with
 * an imported SupportedLocale type once the renderer-side i18n is wired up.
 */

const secureStorage = () => window.aegis.secureStorage;
const STORAGE_KEY = 'aegis.preferences.v1';
const DEV = Boolean(import.meta.env?.DEV);

export type SupportedLocale = string;

export interface Preferences {
  readReceipts: boolean;
  typingIndicator: boolean;
  blockScreenshots: boolean;
  routeViaTor: boolean;
  notifMaster: boolean;
  notifPreview: boolean;
  notifSound: boolean;
  notifBadge: boolean;
  notifSummary: boolean;
  notifKeywords: string[];
  mutedChats: string[];
  /** Deadline (epoch ms) of a timed mute per chat id; absent/0 = always (utils/mute.ts). */
  mutedChatsUntil: Record<string, number>;
  /** Groups we left; a straggler's message must not recreate them. */
  leftGroupIds: string[];
  appLockEnabled: boolean;
  biometricsEnabled: boolean;
  lockTimeoutMin: number;
  photoVis: 'all' | 'contacts' | 'none';
  language: SupportedLocale;
}

const DEFAULTS: Preferences = {
  readReceipts: false,
  typingIndicator: false,
  blockScreenshots: true,
  routeViaTor: true,
  notifMaster: true,
  notifPreview: false,
  notifSound: true,
  notifBadge: true,
  notifSummary: false,
  notifKeywords: ['urgente', 'multisig', 'audit'],
  mutedChats: [],
  mutedChatsUntil: {},
  leftGroupIds: [],
  appLockEnabled: false,
  biometricsEnabled: true,
  lockTimeoutMin: 0,
  photoVis: 'contacts',
  language: 'en',
};

interface PrefsState extends Preferences {
  hydrated: boolean;
  duressActive: boolean;
  hydrate: () => Promise<void>;
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => Promise<void>;
  reset: () => Promise<void>;
  /** Restore from a backup payload: merges over DEFAULTS, then persists (parity with mobile). */
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
    mutedChatsUntil: s.mutedChatsUntil,
    leftGroupIds: s.leftGroupIds,
    appLockEnabled: s.appLockEnabled,
    biometricsEnabled: s.biometricsEnabled,
    lockTimeoutMin: s.lockTimeoutMin,
    photoVis: s.photoVis,
    language: s.language,
  };
}

/**
 * Preferences that describe the REAL user and must not show under a duress
 * (decoy) session: alert keywords, muted chats. Masked to defaults in memory;
 * storage is never touched. Same list as mobile store/preferences.ts.
 */
const DURESS_MASKED: (keyof Preferences)[] = ['notifKeywords', 'mutedChats'];

export function maskForDuress(prefs: Preferences): Preferences {
  const out: Record<string, unknown> = { ...prefs };
  const defaults: Record<string, unknown> = { ...DEFAULTS };
  for (const k of DURESS_MASKED) out[k] = defaults[k];
  return out as unknown as Preferences;
}

async function persist(prefs: Preferences): Promise<void> {
  try {
    await secureStorage().set(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    if (DEV) logger.warn('[preferences] persist failed:', (e as Error).message);
  }
}

export const usePreferences = create<PrefsState>((setState, get) => ({
  ...DEFAULTS,
  hydrated: false,
  duressActive: false,

  async hydrate() {
    try {
      const raw = await secureStorage().get(STORAGE_KEY);
      if (raw) {
        const loaded = JSON.parse(raw) as Partial<Preferences>;
        const merged = { ...DEFAULTS, ...loaded };
        // Decoy session (parity with mobile): the real lists stay on disk.
        setState({ ...(get().duressActive ? maskForDuress(merged) : merged), hydrated: true });
        return;
      }
    } catch (e) {
      if (DEV) logger.warn('[preferences] hydrate failed:', (e as Error).message);
    }
    setState({ hydrated: true });
  },

  async set(key, value) {
    setState({ [key]: value } as Pick<PrefsState, typeof key>);
    // Under duress a change lives in memory only (parity with mobile).
    if (get().duressActive) return;
    await persist(snapshot(get));
  },

  async restoreFrom(prefs) {
    const merged = { ...DEFAULTS, ...prefs };
    setState(merged);
    await persist(merged);
  },

  async reset() {
    // A factory reset must never leave duress (decoy) mode armed — it is
    // extra store state outside Preferences, and Zustand's setState is a
    // partial merge, so omitting it here would let a prior `duressActive:
    // true` survive the reset and trap a freshly regenerated identity in
    // decoy mode until the process restarts.
    setState({ ...DEFAULTS, duressActive: false });
    await secureStorage().delete(STORAGE_KEY);
  },
}));
