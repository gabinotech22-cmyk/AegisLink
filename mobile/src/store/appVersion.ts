import { create } from 'zustand';
import { AppState, Platform } from 'react-native';
import { APP_VERSION } from '../runtime';
import { isOlderThan } from '../utils/semver';
import { logger } from '../utils/logger';
import { ss } from '../utils/secureStore';

/**
 * appVersion.ts — "there is a newer version" without telling anyone anything.
 *
 * The relay advertises the SAME `latestVersion` / `minVersion` to every
 * authenticated client in `auth:ok` (server/src/relay/appVersion.ts). This
 * store compares that against the installed APP_VERSION *locally* and decides
 * what to show. Nothing about the installed version ever goes on the wire,
 * there is no App Store lookup from the device, and no targeted push exists —
 * so neither the relay nor Apple/Google learns who is out of date.
 *
 *   installed <  minVersion     → update REQUIRED: blocking screen (App.tsx gate)
 *   installed <  latestVersion  → update AVAILABLE: dismissible banner on Home
 *
 * When the app is woken in the background (message push) and finds itself
 * outdated, it posts ONE local notification per latestVersion so the user
 * hears about it without opening the app. Dedupe is a single persisted
 * string — the version already announced — with no timestamp, per the
 * zero-metadata-at-rest rule.
 */

const STORAGE_KEY = 'aegis.appversion.v1';

export interface RelayAppVersion {
  latestVersion?: string;
  minVersion?: string;
}

interface AppVersionState {
  latestVersion: string | null;
  minVersion: string | null;
  /** Banner dismissed for this latestVersion (session-only; comes back on the next version). */
  dismissedFor: string | null;
  /** latestVersion already announced with a local notification (persisted). */
  notifiedFor: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Apply the relay's advertisement from `auth:ok`. Safe with undefined. */
  applyAdvertisement: (info: RelayAppVersion | undefined) => void;
  dismissBanner: () => void;
}

export function isUpdateRequired(s: Pick<AppVersionState, 'minVersion'>): boolean {
  return !!s.minVersion && isOlderThan(APP_VERSION, s.minVersion);
}

export function isUpdateAvailable(s: Pick<AppVersionState, 'latestVersion' | 'dismissedFor'>): boolean {
  return !!s.latestVersion
    && isOlderThan(APP_VERSION, s.latestVersion)
    && s.dismissedFor !== s.latestVersion;
}

/** Store page for this platform. iOS id is the ASC App ID; Android is the package. */
export const STORE_URL = Platform.select({
  ios: 'https://apps.apple.com/app/id6788507322',
  android: 'https://play.google.com/store/apps/details?id=com.aegislink.app',
  default: 'https://aegis-link.it',
}) as string;

async function persistNotified(notifiedFor: string): Promise<void> {
  try {
    await ss.set(STORAGE_KEY, JSON.stringify({ notifiedFor }));
  } catch (e) {
    if (__DEV__) logger.warn('[appVersion] persist failed:', (e as Error).message);
  }
}

/**
 * Background-only, once per version. In the foreground the in-app banner is
 * already on screen, so a notification would be noise; this exists for the
 * "app closed, woken by a message push" path.
 */
async function announceInBackground(latestVersion: string): Promise<boolean> {
  if (AppState.currentState === 'active') return false;
  try {
    const Notifications = require('expo-notifications') as typeof import('expo-notifications');
    const { tAsync } = require('../i18n') as typeof import('../i18n');
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'AegisLink',
        body: await tAsync('appVersion.notifBody', { version: latestVersion }),
        data: { appUpdate: true },
        ...(Platform.OS === 'android' ? { channelId: 'aegislink-messages' } : {}),
      },
      trigger: null,
    });
    return true;
  } catch (e) {
    if (__DEV__) logger.warn('[appVersion] notification failed:', (e as Error).message);
    return false;
  }
}

export const useAppVersion = create<AppVersionState>((setState, get) => ({
  latestVersion: null,
  minVersion: null,
  dismissedFor: null,
  notifiedFor: null,
  hydrated: false,

  async hydrate() {
    try {
      const raw = await ss.get(STORAGE_KEY);
      if (raw) {
        const loaded = JSON.parse(raw) as { notifiedFor?: unknown };
        if (typeof loaded.notifiedFor === 'string') setState({ notifiedFor: loaded.notifiedFor });
      }
    } catch (e) {
      if (__DEV__) logger.warn('[appVersion] hydrate failed:', (e as Error).message);
    }
    setState({ hydrated: true });
  },

  applyAdvertisement(info) {
    const latestVersion = info?.latestVersion ?? null;
    const minVersion = info?.minVersion ?? null;
    setState({ latestVersion, minVersion });

    if (!latestVersion || !isOlderThan(APP_VERSION, latestVersion)) return;
    void (async () => {
      // Lazy hydrate: the dedupe flag is only needed once we are actually
      // outdated, so nobody has to remember to hydrate this store at boot.
      if (!get().hydrated) await get().hydrate();
      if (get().notifiedFor === latestVersion) return;
      if (!(await announceInBackground(latestVersion))) return;
      setState({ notifiedFor: latestVersion });
      await persistNotified(latestVersion);
    })();
  },

  dismissBanner() {
    setState({ dismissedFor: get().latestVersion });
  },
}));
