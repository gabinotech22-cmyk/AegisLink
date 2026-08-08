/**
 * withFossPush — the build-time strip that makes a `foss` APK inspectably free
 * of Google Play Services.
 *
 * Unlike the other plugin tests here, this one does not settle for reading the
 * source: @expo/config-plugins is mocked so the real mod callbacks run against
 * fake gradle/manifest inputs. The two properties under test are the ones that
 * would silently sink an F-Droid submission if they broke:
 *
 *  - the Play build must be untouched. A plugin that stripped Firebase from the
 *    store artifact would kill push for every Play user.
 *  - in a foss build the manifest must lose every Google-referencing component.
 *    Excluding the libraries while leaving <service
 *    ExpoFirebaseMessagingService> declared is worse than doing nothing: the APK
 *    still fails F-Droid *and* crashes with NoClassDefFoundError when Android
 *    tries to instantiate a class that is no longer in the dex.
 */
type ModCallback = (config: Record<string, unknown>) => Record<string, unknown>;

jest.mock('@expo/config-plugins', () => ({
  withAppBuildGradle: (config: Record<string, unknown>, cb: ModCallback) => {
    (config as { __gradleCb?: ModCallback }).__gradleCb = cb;
    return config;
  },
  withAndroidManifest: (config: Record<string, unknown>, cb: ModCallback) => {
    (config as { __manifestCb?: ModCallback }).__manifestCb = cb;
    return config;
  },
}));

const ORIG = process.env.EXPO_PUBLIC_DISTRIBUTION;

/** Fresh plugin instance — the module reads process.env at call time. */
function loadPlugin() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../withFossPush') as (c: unknown) => Record<string, unknown>;
}

function gradleConfig(contents = "android {\n}\n") {
  return { modResults: { language: 'groovy', contents } };
}

function manifestConfig(application: Record<string, unknown>) {
  return { modResults: { manifest: { application: [application] } } };
}

afterEach(() => {
  if (ORIG === undefined) delete process.env.EXPO_PUBLIC_DISTRIBUTION;
  else process.env.EXPO_PUBLIC_DISTRIBUTION = ORIG;
  jest.restoreAllMocks();
});

describe('withFossPush', () => {
  describe('play build (default)', () => {
    it('registers no mods at all, leaving the store artifact untouched', () => {
      delete process.env.EXPO_PUBLIC_DISTRIBUTION;
      const withFossPush = loadPlugin();
      const config = withFossPush({}) as { __gradleCb?: unknown; __manifestCb?: unknown };
      expect(config.__gradleCb).toBeUndefined();
      expect(config.__manifestCb).toBeUndefined();
    });
  });

  describe('foss build', () => {
    beforeEach(() => {
      process.env.EXPO_PUBLIC_DISTRIBUTION = 'foss';
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('excludes both Google dependency groups from app/build.gradle', () => {
      const withFossPush = loadPlugin();
      const config = withFossPush({}) as { __gradleCb: ModCallback };
      const out = config.__gradleCb(gradleConfig()) as {
        modResults: { contents: string };
      };
      expect(out.modResults.contents).toContain("exclude group: 'com.google.firebase'");
      expect(out.modResults.contents).toContain("exclude group: 'com.google.android.gms'");
      expect(out.modResults.contents).toContain('configurations.all');
    });

    it('is idempotent — a second prebuild does not append the block twice', () => {
      const withFossPush = loadPlugin();
      const config = withFossPush({}) as { __gradleCb: ModCallback };
      const once = config.__gradleCb(gradleConfig()) as { modResults: { contents: string } };
      const twice = config.__gradleCb(once) as { modResults: { contents: string } };
      const occurrences = twice.modResults.contents.split('configurations.all').length - 1;
      expect(occurrences).toBe(1);
    });

    it('refuses a non-groovy build.gradle rather than silently skipping the strip', () => {
      const withFossPush = loadPlugin();
      const config = withFossPush({}) as { __gradleCb: ModCallback };
      expect(() =>
        config.__gradleCb({ modResults: { language: 'kt', contents: '' } }),
      ).toThrow(/groovy/);
    });

    it("removes expo-notifications' Firebase service from the manifest", () => {
      const withFossPush = loadPlugin();
      const config = withFossPush({}) as { __manifestCb: ModCallback };
      const out = config.__manifestCb(
        manifestConfig({
          service: [
            { $: { 'android:name': 'expo.modules.notifications.service.ExpoFirebaseMessagingService' } },
            { $: { 'android:name': 'com.aegislink.app.AegisWakeService' } },
          ],
        }),
      ) as { modResults: { manifest: { application: { service: { $: Record<string, string> }[] }[] } } };

      const names = out.modResults.manifest.application[0].service.map(
        (s) => s.$['android:name'],
      );
      // The Google-backed service is gone; our own wake service — which is what
      // actually delivers calls in a foss build — must survive.
      expect(names).toEqual(['com.aegislink.app.AegisWakeService']);
    });

    it('strips Google providers and meta-data, not just services', () => {
      const withFossPush = loadPlugin();
      const config = withFossPush({}) as { __manifestCb: ModCallback };
      const out = config.__manifestCb(
        manifestConfig({
          provider: [
            { $: { 'android:name': 'com.google.firebase.provider.FirebaseInitProvider' } },
            { $: { 'android:name': 'androidx.startup.InitializationProvider' } },
          ],
          'meta-data': [
            { $: { 'android:name': 'com.google.android.gms.version' } },
            { $: { 'android:name': 'expo.modules.updates.ENABLED' } },
          ],
        }),
      ) as {
        modResults: {
          manifest: {
            application: {
              provider: { $: Record<string, string> }[];
              'meta-data': { $: Record<string, string> }[];
            }[];
          };
        };
      };

      const app = out.modResults.manifest.application[0];
      expect(app.provider.map((p) => p.$['android:name'])).toEqual([
        'androidx.startup.InitializationProvider',
      ]);
      expect(app['meta-data'].map((m) => m.$['android:name'])).toEqual([
        'expo.modules.updates.ENABLED',
      ]);
    });

    it('tolerates a manifest with no application node', () => {
      const withFossPush = loadPlugin();
      const config = withFossPush({}) as { __manifestCb: ModCallback };
      expect(() =>
        config.__manifestCb({ modResults: { manifest: {} } }),
      ).not.toThrow();
    });
  });
});
