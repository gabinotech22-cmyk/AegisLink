/**
 * withCallWakeService — the persistent Android call-wake foreground service.
 *
 * Regression for the 1.0.7 emulator crash: with targetSdk 35 a `dataSync` FGS
 * may not start from BOOT_COMPLETED (ForegroundServiceStartNotAllowedException
 * killed the app on every reboot) and is capped at 6 h a day. The service must
 * be `remoteMessaging`, and a refused foreground start must never crash.
 */
type ModCallback = (config: Record<string, unknown>) => Record<string, unknown>;

jest.mock('@expo/config-plugins', () => ({
  withAndroidManifest: (config: Record<string, unknown>, cb: ModCallback) => ((config as { __manifest?: ModCallback }).__manifest = cb, config),
  withMainApplication: (config: Record<string, unknown>) => config,
  withDangerousMod: (config: Record<string, unknown>) => config,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../withCallWakeService') as ((c: unknown) => Record<string, ModCallback>) & {
  KT: Record<string, string>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const appJson = require('../../app.json') as { expo: { android: { permissions: string[] } } };

describe('withCallWakeService', () => {
  it('declares the wake service as remoteMessaging, never dataSync', () => {
    const app: Record<string, unknown> = {};
    plugin({}).__manifest({ modResults: { manifest: { application: [app] } } });
    const services = app.service as Array<{ $: Record<string, string> }>;
    const wake = services.find((s) => s.$['android:name'].endsWith('AegisWakeService'))!;
    expect(wake.$['android:foregroundServiceType']).toBe('remoteMessaging');
    expect(wake.$['android:exported']).toBe('false');
  });

  it('rewrites a service prebuilt with the old dataSync type, without duplicating it', () => {
    const app: Record<string, unknown> = {
      service: [{ $: { 'android:name': 'com.aegislink.app.AegisWakeService', 'android:foregroundServiceType': 'dataSync' } }],
    };
    plugin({}).__manifest({ modResults: { manifest: { application: [app] } } });
    const services = app.service as Array<{ $: Record<string, string> }>;
    expect(services).toHaveLength(1);
    expect(services[0].$['android:foregroundServiceType']).toBe('remoteMessaging');
  });

  it('asks for the matching permission in app.json', () => {
    const perms = appJson.expo.android.permissions;
    expect(perms).toContain('android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING');
    expect(perms).not.toContain('android.permission.FOREGROUND_SERVICE_DATA_SYNC');
  });

  it('starts with the remoteMessaging type and never crashes on a refused start', () => {
    const svc = plugin.KT['AegisWakeService.kt'];
    expect(svc).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING');
    expect(svc).not.toContain('DATA_SYNC');
    expect(svc).toMatch(/try \{[\s\S]*startForeground\([\s\S]*catch \(e: RuntimeException\)/);
    expect(svc).toMatch(/if \(!startForegroundInternal\(\)\) \{\s*stopSelf\(\)\s*return START_NOT_STICKY/);
    const boot = plugin.KT['AegisWakeBootReceiver.kt'];
    expect(boot).toMatch(/try \{[\s\S]*startForegroundService\(svc\)[\s\S]*catch \(e: RuntimeException\)/);
  });
});
