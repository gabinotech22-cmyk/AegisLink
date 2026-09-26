/**
 * withUnifiedPush — the native half of the UnifiedPush wake (Slice 2b.3c).
 * The mod callbacks run for real against fake gradle / manifest / MainApplication
 * inputs (like withFossPush.test.ts), and the generated Kotlin is checked for the
 * properties that matter:
 *  - the connector comes from Maven Central, pinned, and nothing from Play Services;
 *  - the PushService is NOT exported and listens only on the connector's action;
 *  - a push message is a bare wake: the Kotlin never reads its content (R2);
 *  - idempotent: running the plugin twice adds nothing twice.
 */
type ModCallback = (config: Record<string, unknown>) => Record<string, unknown>;

jest.mock('@expo/config-plugins', () => ({
  withAppBuildGradle: (config: Record<string, unknown>, cb: ModCallback) => ((config as { __gradle?: ModCallback }).__gradle = cb, config),
  withAndroidManifest: (config: Record<string, unknown>, cb: ModCallback) => ((config as { __manifest?: ModCallback }).__manifest = cb, config),
  withMainApplication: (config: Record<string, unknown>, cb: ModCallback) => ((config as { __mainApp?: ModCallback }).__mainApp = cb, config),
  withDangerousMod: (config: Record<string, unknown>) => config,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../withUnifiedPush') as ((c: unknown) => Record<string, ModCallback>) & {
  KT: Record<string, string>;
  CONNECTOR: string;
};

const GRADLE = "android {\n}\n\ndependencies {\n    implementation(\"com.facebook.react:react-android\")\n}\n";
const MAIN_APP = 'override fun getPackages(): List<ReactPackage> =\n            PackageList(this).packages.apply {\n              add(AegisWakePackage())\n            }';

describe('withUnifiedPush', () => {
  const mods = plugin({});

  it('adds the pinned connector once, and nothing from Google Play Services', () => {
    const once = mods.__gradle({ modResults: { language: 'groovy', contents: GRADLE } }) as { modResults: { contents: string } };
    const twice = mods.__gradle({ modResults: { language: 'groovy', contents: once.modResults.contents } }) as { modResults: { contents: string } };
    expect(plugin.CONNECTOR).toMatch(/^org\.unifiedpush\.android:connector:\d+\.\d+\.\d+$/);
    expect(twice.modResults.contents.split(plugin.CONNECTOR).length - 1).toBe(1);
    expect(twice.modResults.contents).not.toMatch(/com\.google\.(firebase|android\.gms)/);
  });

  it('declares the push service unexported on the connector action, plus the wake service', () => {
    const app: Record<string, unknown> = {};
    const cfg = { modResults: { manifest: { application: [app] } } };
    mods.__manifest(cfg);
    mods.__manifest(cfg);
    const services = app.service as Array<{ $: Record<string, string>; 'intent-filter'?: unknown[] }>;
    expect(services).toHaveLength(2);
    const push = services.find((s) => s.$['android:name'].endsWith('AegisUnifiedPushService'))!;
    expect(push.$['android:exported']).toBe('false');
    expect(JSON.stringify(push['intent-filter'])).toContain('org.unifiedpush.android.connector.PUSH_EVENT');
    const wake = services.find((s) => s.$['android:name'].endsWith('AegisMailboxWakeService'))!;
    expect(wake.$['android:exported']).toBe('false');
  });

  it('registers the React package once', () => {
    const once = mods.__mainApp({ modResults: { contents: MAIN_APP } }) as { modResults: { contents: string } };
    const twice = mods.__mainApp({ modResults: { contents: once.modResults.contents } }) as { modResults: { contents: string } };
    expect(twice.modResults.contents.split('add(AegisUnifiedPushPackage())').length - 1).toBe(1);
  });

  it('treats a push message as a bare wake: its content is never read', () => {
    const svc = plugin.KT['AegisUnifiedPushService.kt'];
    expect(svc).toContain('override fun onMessage(message: PushMessage, instance: String)');
    expect(svc).not.toMatch(/message\.(content|decrypted)/);
    expect(svc).toContain('AegisMailboxWakeService.start(this)');
    // The headless task name matches the JS registration.
    expect(plugin.KT['AegisMailboxWakeService.kt']).toContain('"AegisMailboxWake"');
  });
});
