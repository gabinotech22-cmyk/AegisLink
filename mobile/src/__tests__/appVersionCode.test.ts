/**
 * versionCode must be derived from versionName, and must always grow.
 *
 * FIELD BUG THIS PINS: app.json carried `versionCode: 2` while `version` moved
 * 1.0.4 → 1.0.5 → 1.0.6. Play never noticed, because eas.json sets
 * `appVersionSource: remote` with `autoIncrement` and EAS owns the store's
 * version codes — so the stale literal was invisible there. Every APK built
 * from the repo by CI, however, takes versionCode straight out of app.json via
 * `expo prebuild`. The v1.0.5 APK published on GitHub shipped versionCode 2,
 * and v1.0.6 would have shipped versionCode 2 as well.
 *
 * That breaks every distribution channel outside Play:
 *   - F-Droid treats versionCode as the identity of a build. Two releases
 *     sharing one code are the SAME version to it; the update is never offered.
 *   - Android refuses to install an APK whose versionCode is lower than the
 *     installed one, so a hand-edit that went backwards would strand users with
 *     no upgrade path at all.
 *
 * The rule: versionCode = major * 10000 + minor * 100 + patch. Deterministic
 * from the tag, monotonic across releases, and derivable by a packager without
 * asking us — which is what an fdroiddata recipe needs.
 */
import appJson from '../../app.json';

/** major.minor.patch → a single monotonically increasing integer. */
function expectedVersionCode(versionName: string): number {
  const parts = versionName.split('.').map((p) => Number(p));
  expect(parts).toHaveLength(3);
  for (const p of parts) expect(Number.isInteger(p)).toBe(true);
  const [major, minor, patch] = parts;
  // Bounds keep the formula collision-free: a minor or patch of 100+ would
  // carry into the next field and silently produce a duplicate code.
  expect(minor).toBeLessThan(100);
  expect(patch).toBeLessThan(100);
  return major * 10000 + minor * 100 + patch;
}

describe('android versionCode', () => {
  const version = appJson.expo.version;
  const versionCode = appJson.expo.android.versionCode;

  it('matches the version name under the documented formula', () => {
    expect(versionCode).toBe(expectedVersionCode(version));
  });

  it('is greater than every versionCode already published from this repo', () => {
    // v1.0.5's APK on GitHub carries versionCode 2. Anything we publish next has
    // to exceed it or installs stop being offered as updates.
    const HIGHEST_PUBLISHED = 2;
    expect(versionCode).toBeGreaterThan(HIGHEST_PUBLISHED);
  });

  it('exposes the formula for the fdroiddata recipe to reproduce', () => {
    expect(expectedVersionCode('1.0.6')).toBe(10006);
    expect(expectedVersionCode('1.2.3')).toBe(10203);
    expect(expectedVersionCode('2.0.0')).toBe(20000);
    // Monotonic across the boundaries that bit us.
    expect(expectedVersionCode('1.0.10')).toBeGreaterThan(expectedVersionCode('1.0.9'));
    expect(expectedVersionCode('1.1.0')).toBeGreaterThan(expectedVersionCode('1.0.99'));
  });
});
