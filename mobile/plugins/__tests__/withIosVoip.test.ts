/**
 * withIosVoip — launch-crash regression (source-level, like audit-regression).
 *
 * react-native-voip-push-notification@3.3.3 uses the old RN bridge, but the app
 * runs the New Architecture (bridgeless). Native PushKit registration therefore
 * crashes on launch: -[PKPushRegistry voipRegistrationSucceededWithDeviceToken:]
 * emits over the missing bridge → doesNotRecognizeSelector → SIGABRT (confirmed
 * on iOS 16.7 / iPhone 8, TestFlight). PR #279 re-enabled that native
 * registration and broke every build after it; this locks the gate OFF.
 *
 * We assert at the SOURCE level (the plugin drives an EAS macOS prebuild we
 * can't run here) that the AppDelegate injection stays behind a disabled flag.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN = fs.readFileSync(
  path.resolve(__dirname, '..', 'withIosVoip.js'),
  'utf8',
);

describe('withIosVoip — VoIP native registration is gated off (launch-crash fix)', () => {
  it('keeps VOIP_NATIVE_WIRED disabled', () => {
    expect(PLUGIN).toMatch(/VOIP_NATIVE_WIRED\s*=\s*false/);
  });

  it('only injects voipRegistration()/bridging header inside the VOIP_NATIVE_WIRED guard', () => {
    // The AppDelegate injection + bridging-header steps must NOT run
    // unconditionally in module.exports — they belong inside `if
    // (VOIP_NATIVE_WIRED)`. Grab the exported plugin body and assert the
    // wiring calls appear only after the guard.
    const exportBody = PLUGIN.slice(PLUGIN.indexOf('module.exports'));
    const guardIdx = exportBody.indexOf('if (VOIP_NATIVE_WIRED)');
    expect(guardIdx).toBeGreaterThan(-1);

    for (const call of [
      'withAppDelegateVoip(config)',
      'withVoipBridgingHeaderFile(config)',
      'withVoipBridgingHeaderSetting(config)',
    ]) {
      const callIdx = exportBody.indexOf(call);
      expect(callIdx).toBeGreaterThan(-1);
      // Every wiring call must sit AFTER the guard opens.
      expect(callIdx).toBeGreaterThan(guardIdx);
    }
  });

  it('still applies the harmless entitlements + background modes unconditionally', () => {
    const exportBody = PLUGIN.slice(PLUGIN.indexOf('module.exports'));
    const guardIdx = exportBody.indexOf('if (VOIP_NATIVE_WIRED)');
    // These do NOT trigger PushKit registration, so they stay outside the guard.
    expect(exportBody.indexOf('withApsEntitlement(config)')).toBeGreaterThan(-1);
    expect(exportBody.indexOf('withApsEntitlement(config)')).toBeLessThan(guardIdx);
    expect(exportBody.indexOf('withVoipBackgroundModes(config)')).toBeLessThan(guardIdx);
  });
});
