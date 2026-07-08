/**
 * Expo config plugin — iOS VoIP push (PushKit) native wiring.
 *
 * Keeps `expo prebuild --clean` reproducible for the native pieces that
 * react-native-voip-push-notification needs but the managed workflow does not
 * add automatically:
 *
 *   1. Entitlements: `aps-environment` = production (required for APNs, incl.
 *      the VoIP push type). Push Notifications capability.
 *   2. Info.plist: guarantees `voip` + `remote-notification` background modes
 *      (also declared in app.json; re-asserted here so the plugin is the single
 *      source of truth for the VoIP capability and survives app.json edits).
 *   3. (DISABLED) AppDelegate.swift native VoIP registration — see note below.
 *
 * ┌─ WHY STEP 3 IS DISABLED ─────────────────────────────────────────────────────┐
 * │ The AppDelegate injection did `import RNVoipPushNotification` in Swift, which  │
 * │ fails the Xcode build under Expo's managed setup (no use_frameworks!) with     │
 * │ "no such module 'RNVoipPushNotification'" — the pod is ObjC and isn't a Swift  │
 * │ module. Confirmed on EAS build 5c192197.                                       │
 * │                                                                               │
 * │ It is NOT needed for VoIP to work in the app-running / background case:        │
 * │ src/calls/voip-push.ts calls VoipPushNotification.registerVoipToken() over the │
 * │ RN bridge, which triggers the SAME native registration (the library sets       │
 * │ itself as the PKPushRegistry delegate and forwards events to JS). The native   │
 * │ call only helps register earlier on a cold start FROM a VoIP push.             │
 * │                                                                               │
 * │ FOLLOW-UP: re-enable via an Objective-C bridging header                        │
 * │ (`#import "RNVoipPushNotificationManager.h"` + SWIFT_OBJC_BRIDGING_HEADER),     │
 * │ NOT a Swift `import`, and validate on a build. withAppDelegateVoip() is kept   │
 * │ below (unused) for that work. VoIP push is not live yet anyway (the relay      │
 * │ APNS_* key is unset), so this does not regress any shipped behavior.           │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */
const {
  withEntitlementsPlist,
  withInfoPlist,
  withAppDelegate,
} = require('@expo/config-plugins');

// ── 1. Entitlements: APNs / Push Notifications ────────────────────────────────
function withApsEntitlement(config) {
  return withEntitlementsPlist(config, (config) => {
    // `production` works for both dev and prod when the app is signed with a
    // provisioning profile that has the Push Notifications capability (EAS does
    // this). CallKit needs no entitlement; PushKit is gated by aps-environment.
    config.modResults['aps-environment'] = 'production';
    return config;
  });
}

// ── 2. Info.plist: background modes ───────────────────────────────────────────
function withVoipBackgroundModes(config) {
  return withInfoPlist(config, (config) => {
    const modes = new Set(config.modResults.UIBackgroundModes || []);
    modes.add('voip');
    modes.add('remote-notification');
    modes.add('audio');
    config.modResults.UIBackgroundModes = Array.from(modes);
    return config;
  });
}

// ── 3. AppDelegate.swift: VoIP registration ───────────────────────────────────
// The library's Swift module exposes RNVoipPushNotificationManager.
const VOIP_IMPORT = 'import RNVoipPushNotification';

// voipRegistration() wires the PKPushRegistry delegate internally (inside the
// library) and forwards events to JS. Inserted right after didFinishLaunching's
// opening brace — the library recommends registering "as early as possible",
// and anchoring to the opening `{` (not a `return`) sidesteps any early-return
// in the generated body.
const REGISTER_SNIPPET = `
    // AegisLink: register for VoIP (PushKit) pushes as early as possible. The
    // library sets itself as the PKPushRegistry delegate and forwards events to JS.
    RNVoipPushNotificationManager.voipRegistration()`;

/**
 * Apply `replacer` and throw if it was a no-op. Regex-based Swift injection into
 * Expo's generated AppDelegate.swift is fragile: if a future SDK bump changes
 * the template, a silent no-op would produce a build with NO VoIP registration —
 * discoverable only as a missed call in production. Fail loud at build time.
 */
function injectOrThrow(src, replacer, label) {
  const next = replacer(src);
  if (next === src) {
    throw new Error(
      `[withIosVoip] failed to inject ${label}: the generated AppDelegate.swift ` +
        `did not match the expected anchor. The Expo template likely changed — ` +
        `update mobile/plugins/withIosVoip.js.`,
    );
  }
  return next;
}

function withAppDelegateVoip(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') {
      // SDK 54 / RN 0.81 ships a Swift AppDelegate. If a future prebuild emits
      // ObjC, fail loudly rather than silently produce a non-VoIP build.
      throw new Error('[withIosVoip] expected a Swift AppDelegate; got ' + config.modResults.language);
    }
    let src = config.modResults.contents;

    // Import: insert after the FIRST existing import line, so we don't depend on
    // a specific one. SDK 54's AppDelegate.swift starts with `import Expo`, NOT
    // `import ExpoModulesCore`, so anchoring on the latter threw during prebuild.
    // Every AppDelegate has at least one import, so this stays version-robust.
    if (!src.includes(VOIP_IMPORT)) {
      src = injectOrThrow(
        src,
        (s) => s.replace(/^(import .+)$/m, `$1\n${VOIP_IMPORT}`),
        VOIP_IMPORT,
      );
    }

    // VoIP registration right after didFinishLaunchingWithOptions' opening brace.
    if (!src.includes('RNVoipPushNotificationManager.voipRegistration()')) {
      src = injectOrThrow(
        src,
        (s) => s.replace(/(func application\([^)]*didFinishLaunchingWithOptions[^{]*\{)/, `$1${REGISTER_SNIPPET}`),
        'voipRegistration()',
      );
    }

    config.modResults.contents = src;
    return config;
  });
}

module.exports = function withIosVoip(config) {
  config = withApsEntitlement(config);
  config = withVoipBackgroundModes(config);
  // withAppDelegateVoip is intentionally NOT applied — see "WHY STEP 3 IS
  // DISABLED" in the header. It breaks the Xcode build (Swift can't import the
  // ObjC pod). VoIP registration works via JS (voip-push.ts registerVoipToken).
  return config;
};

// Referenced only to keep the (currently-disabled) helper from tripping no-unused
// lint while we keep it for the bridging-header follow-up.
void withAppDelegateVoip;
