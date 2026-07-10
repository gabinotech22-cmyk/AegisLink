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
 *   3. Objective-C bridging header exposing RNVoipPushNotificationManager to
 *      Swift, so the AppDelegate can register for VoIP pushes as early as
 *      possible (native early-registration, before JS loads).
 *   4. AppDelegate.swift: call RNVoipPushNotificationManager.voipRegistration()
 *      in didFinishLaunchingWithOptions.
 *
 * ┌─ WHY A BRIDGING HEADER, NOT A SWIFT `import` ────────────────────────────────┐
 * │ The pod is Objective-C, not a Swift module. A Swift `import                   │
 * │ RNVoipPushNotification` fails the Xcode build under Expo's managed setup       │
 * │ (no use_frameworks!) with "no such module 'RNVoipPushNotification'" (confirmed │
 * │ on EAS build 5c192197, PR #276). The supported way to reach an ObjC pod from   │
 * │ Swift is an ObjC bridging header (`#import "RNVoipPushNotificationManager.h"`   │
 * │ + SWIFT_OBJC_BRIDGING_HEADER), which is what step 3 sets up.                    │
 * │                                                                               │
 * │ Native early-registration is not strictly required for the app-running /       │
 * │ background case: src/calls/voip-push.ts calls                                   │
 * │ VoipPushNotification.registerVoipToken() over the RN bridge, which triggers the │
 * │ SAME native registration (the library sets itself as the PKPushRegistry         │
 * │ delegate and forwards events to JS). The native call registers EARLIER on a     │
 * │ cold start FROM a VoIP push — more reliable for the app-fully-killed ringing    │
 * │ path, where JS may not be up yet.                                               │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */
const {
  withEntitlementsPlist,
  withInfoPlist,
  withAppDelegate,
  withXcodeProject,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

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

// ── 3. Objective-C bridging header ────────────────────────────────────────────
// Swift can't `import` the ObjC pod (no use_frameworks!). The supported bridge is
// an ObjC bridging header that #imports the manager's public header; Swift then
// sees RNVoipPushNotificationManager as a native type. The pod's header search
// paths (added by CocoaPods) make the quoted #import resolve.
const BRIDGING_IMPORT = '#import "RNVoipPushNotificationManager.h"';

// 3a. Write (or extend) the bridging header file at ios/<project>/<project>-Bridging-Header.h.
function withVoipBridgingHeaderFile(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName;
      if (!projectName) {
        throw new Error('[withIosVoip] could not resolve iOS projectName for the bridging header.');
      }
      const headerPath = path.join(
        config.modRequest.platformProjectRoot,
        projectName,
        `${projectName}-Bridging-Header.h`,
      );
      let contents = fs.existsSync(headerPath) ? fs.readFileSync(headerPath, 'utf8') : '';
      if (!contents.includes(BRIDGING_IMPORT)) {
        // Append rather than overwrite: another plugin may already own a bridging
        // header. A trailing newline keeps the file well-formed either way.
        const prefix = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
        contents += `${prefix}${BRIDGING_IMPORT}\n`;
        fs.writeFileSync(headerPath, contents);
      }
      return config;
    },
  ]);
}

// 3b. Point the app target's SWIFT_OBJC_BRIDGING_HEADER build setting at it.
function withVoipBridgingHeaderSetting(config) {
  return withXcodeProject(config, (config) => {
    const projectName = config.modRequest.projectName;
    if (!projectName) {
      throw new Error('[withIosVoip] could not resolve iOS projectName for the bridging header build setting.');
    }
    const xcodeProject = config.modResults;
    // Path is relative to SRCROOT (the ios/ dir), quoted to be safe.
    const headerRelative = `"${projectName}/${projectName}-Bridging-Header.h"`;

    // Scope to the app target's build configurations ONLY. Setting this globally
    // would also hit the Pods project's configs and break pod compilation.
    const firstTarget = xcodeProject.getFirstTarget().firstTarget;
    const configListId = firstTarget.buildConfigurationList;
    const configList = xcodeProject.pbxXCConfigurationList()[configListId];
    const buildConfigs = xcodeProject.pbxXCBuildConfigurationSection();
    let touched = 0;
    for (const ref of configList.buildConfigurations) {
      const buildSettings = buildConfigs[ref.value] && buildConfigs[ref.value].buildSettings;
      if (!buildSettings) continue;
      buildSettings.SWIFT_OBJC_BRIDGING_HEADER = headerRelative;
      touched += 1;
    }
    if (touched === 0) {
      throw new Error(
        '[withIosVoip] failed to set SWIFT_OBJC_BRIDGING_HEADER: no build ' +
          'configurations found on the app target. The Xcode project layout changed.',
      );
    }
    return config;
  });
}

// ── 4. AppDelegate.swift: VoIP registration ───────────────────────────────────
// voipRegistration() wires the PKPushRegistry delegate internally (inside the
// library) and forwards events to JS. Inserted right after didFinishLaunching's
// opening brace — the library recommends registering "as early as possible",
// and anchoring to the opening `{` (not a `return`) sidesteps any early-return
// in the generated body. RNVoipPushNotificationManager is visible to Swift via
// the ObjC bridging header (step 3) — NO Swift `import` is needed or wanted.
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

    // VoIP registration right after didFinishLaunchingWithOptions' opening brace.
    // No Swift `import` — RNVoipPushNotificationManager comes from the ObjC
    // bridging header (step 3).
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
  config = withVoipBridgingHeaderFile(config);
  config = withVoipBridgingHeaderSetting(config);
  config = withAppDelegateVoip(config);
  return config;
};
