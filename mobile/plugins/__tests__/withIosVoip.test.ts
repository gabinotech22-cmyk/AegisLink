/**
 * withIosVoip — source-level guards for the iOS VoIP (PushKit) wiring.
 *
 * HISTORY THIS PROTECTS: react-native-voip-push-notification@3.3.3 emits its
 * events over the OLD RN bridge. This app runs the New Architecture
 * (bridgeless), where that path is gone, so the PushKit token callback hit
 * -[PKPushRegistry voipRegistrationSucceededWithDeviceToken:] →
 * doesNotRecognizeSelector → SIGABRT ~2 s after launch (confirmed on iOS 16.7 /
 * iPhone 8 from a TestFlight .ips). PR #279 turned that on and broke every build
 * after it; VoIP was then gated off entirely.
 *
 * The replacement is our own native module, which is safe for one structural
 * reason: it NEVER emits an event to JS. The push is reported to CallKit in
 * native code and JS only ever PULLS. These tests pin that property — plus the
 * zero-metadata contract — at the source level, because the plugin only runs
 * inside an EAS macOS prebuild we cannot execute here.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN = fs.readFileSync(
  path.resolve(__dirname, '..', 'withIosVoip.js'),
  'utf8',
);

/**
 * The plugin (and the ObjC it embeds) documents the crash history in prose, so
 * the forbidden names legitimately appear in COMMENTS. Assertions about what
 * the code must not DO run against comment-stripped source; assertions about
 * what it must contain run against the raw text.
 */
const CODE = PLUGIN
  .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments (JS + ObjC)
  .replace(/^[ \t]*\/\/.*$/gm, '')       // whole-line // comments
  .replace(/[ \t]+\/\/.*$/gm, '');       // trailing // comments

describe('withIosVoip — the launch-crash cannot come back', () => {
  it('does not use the incompatible library anywhere', () => {
    // Neither the pod class nor the JS package may be referenced in code: that
    // library IS the crash. (Matching the manager class also catches a
    // bridging-header import sneaking back in.)
    expect(CODE).not.toMatch(/RNVoipPushNotificationManager/);
    expect(CODE).not.toMatch(/react-native-voip-push-notification/);
  });

  it('the native module never emits events to JS', () => {
    // RCTEventEmitter is precisely the machinery that SIGABRTs under
    // bridgeless. The module must be a plain RCTBridgeModule (pull-only).
    expect(CODE).not.toMatch(/RCTEventEmitter/);
    expect(CODE).toMatch(/<RCTBridgeModule>/);
    expect(CODE).toMatch(/RCT_EXPORT_MODULE\(AegisVoipPush\)/);
  });

  it('reports the incoming push to CallKit natively, from PushKit itself', () => {
    // Apple kills the app (and eventually revokes the entitlement) if a VoIP
    // push is not reported to CallKit immediately, and JS is not running on a
    // cold start — so this MUST be the native call, with the completion handler
    // handed to the library rather than invoked blindly.
    expect(PLUGIN).toMatch(/didReceiveIncomingPushWithPayload/);
    expect(PLUGIN).toMatch(/reportNewIncomingCall/);
    expect(PLUGIN).toMatch(/fromPushKit:YES/);
    expect(PLUGIN).toMatch(/withCompletionHandler:completion/);
  });
});

describe('withIosVoip — zero metadata at the OS layer', () => {
  it('hands CallKit generic labels only — never a peer identity', () => {
    expect(PLUGIN).toMatch(/kGenericHandle\s*=\s*@"aegislink"/);
    expect(PLUGIN).toMatch(/kGenericCaller\s*=\s*@"Llamada cifrada · E2EE"/);
    expect(PLUGIN).toMatch(/localizedCallerName:kGenericCaller/);
    expect(PLUGIN).toMatch(/handle:kGenericHandle/);
  });

  it('does not forward the push payload onward', () => {
    // `payload:nil` keeps RNCallKeep from relaying the raw dictionary to JS.
    expect(PLUGIN).toMatch(/payload:nil/);
  });
});

describe('withIosVoip — the wiring actually reaches the build', () => {
  it('registers the native sources in project.pbxproj, not just on disk', () => {
    // Writing files is NOT enough: Xcode compiles only what is listed in the
    // PBXSourcesBuildPhase. Skipping this produces a build that succeeds while
    // the module silently does not exist at runtime.
    expect(PLUGIN).toMatch(/addSourceFile/);
    expect(PLUGIN).toMatch(/findPBXGroupKey/);
  });

  it('applies every step unconditionally (no leftover disable gate)', () => {
    const exportBody = PLUGIN.slice(PLUGIN.indexOf('module.exports'));
    expect(exportBody).not.toMatch(/VOIP_NATIVE_WIRED/);
    for (const call of [
      'withApsEntitlement(config)',
      'withVoipBackgroundModes(config)',
      'withVoipNativeSources(config)',
      'withVoipXcodeProjectFiles(config)',
      'withVoipBridgingHeaderFile(config)',
      'withVoipBridgingHeaderSetting(config)',
      'withAppDelegateVoip(config)',
    ]) {
      expect(exportBody).toContain(call);
    }
  });

  it('fails loudly if the AppDelegate anchor stops matching', () => {
    // A silent no-op here would ship a build with NO VoIP registration,
    // discoverable only as a missed call in production.
    expect(PLUGIN).toMatch(/injectOrThrow/);
    expect(PLUGIN).toMatch(/AegisVoipPush\.voipRegistration\(\)/);
  });

  it('keeps the voip background mode (PushKit needs it)', () => {
    expect(PLUGIN).toMatch(/modes\.add\('voip'\)/);
    expect(PLUGIN).toMatch(/aps-environment/);
  });
});
