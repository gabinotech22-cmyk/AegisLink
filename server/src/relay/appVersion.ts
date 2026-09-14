/**
 * App version advertisement — the relay's half of "there is a newer version".
 *
 * Zero-metadata by construction: the relay publishes the SAME two strings to
 * every authenticated client in `auth:ok`. It never receives, stores or
 * compares the client's installed version — the client does that locally and
 * decides for itself whether to show anything. So the relay learns nothing it
 * did not already know (that an authenticated socket connected), and there is
 * no per-device registry, no third-party store lookup, no targeted push.
 *
 *   APP_LATEST_VERSION  newest release available in the stores. Older clients
 *                       show a dismissible "update available" banner.
 *   APP_MIN_VERSION     oldest release still allowed to run. Older clients
 *                       show a blocking "update required" screen. This is the
 *                       emergency brake: bumping it retires a broken build
 *                       from service with a config change — no store review,
 *                       no OTA, no build.
 *
 * Both optional. An unset/invalid value is simply omitted, so a misconfigured
 * relay can never lock anyone out by accident: no value means no gate.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;

export interface AppVersionInfo {
  latestVersion?: string;
  minVersion?: string;
}

function readVersion(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!SEMVER.test(raw)) {
    console.warn(`[appVersion] ignoring ${name}="${raw}": expected x.y.z`);
    return undefined;
  }
  return raw;
}

/**
 * Build the advertisement from the environment. Two env reads per auth is
 * negligible, and reading on demand (rather than once at import) keeps tests
 * honest and lets the value follow a restart without module-cache surprises.
 */
export function appVersionInfo(env: NodeJS.ProcessEnv = process.env): AppVersionInfo | undefined {
  const latestVersion = readVersion(env, 'APP_LATEST_VERSION');
  const minVersion = readVersion(env, 'APP_MIN_VERSION');
  if (!latestVersion && !minVersion) return undefined;
  const info: AppVersionInfo = {};
  if (latestVersion) info.latestVersion = latestVersion;
  if (minVersion) info.minVersion = minVersion;
  return info;
}
