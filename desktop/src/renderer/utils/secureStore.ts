/**
 * `ss` — the same tiny secure-storage surface mobile exposes
 * (mobile/src/utils/secureStore.ts), backed by the Electron preload bridge.
 *
 * Exists so the modules shared with mobile — channel key stores, public-channel
 * state — can be ported character-for-character instead of being rewritten
 * around window.aegis. Crypto that has to stay in lockstep across platforms
 * (golden rule #5) is far safer as the same code than as two translations of it.
 *
 * Every key still passes the main-process allow-list; a name that is not
 * whitelisted throws rather than failing quietly.
 */
const bridge = () => window.aegis.secureStorage;

export const ss = {
  get: (key: string): Promise<string | null> => bridge().get(key),
  set: (key: string, value: string): Promise<void> => bridge().set(key, value),
  delete: (key: string): Promise<void> => bridge().delete(key),
};
