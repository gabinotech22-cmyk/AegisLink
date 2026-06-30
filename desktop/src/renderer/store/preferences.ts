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
  appLockEnabled: boolean;
  biometricsEnabled: boolean;
  lockTimeoutMin: number;
  hideRecents: boolean;
  photoVis: 'all' | 'contacts' | 'none';
  lastSeenVisible: boolean;
  typingVisible: boolean;
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
        setState({ ...DEFAULTS, ...loaded, hydrated: true });
        return;
      }
    } catch (e) {
      if (DEV) logger.warn('[preferences] hydrate failed:', (e as Error).message);
    }
    setState({ hydrated: true });
  },

  async set(key, value) {
    setState({ [key]: value } as Pick<PrefsState, typeof key>);
    await persist(snapshot(get));
  },

  async reset() {
    setState({ ...DEFAULTS });
    await secureStorage().delete(STORAGE_KEY);
  },
}));
