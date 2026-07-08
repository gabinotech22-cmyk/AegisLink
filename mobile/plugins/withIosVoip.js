/**
 * Expo config plugin — iOS VoIP push (PushKit) + CallKit native wiring.
 *
 * Keeps `expo prebuild --clean` reproducible for the native pieces that
 * react-native-voip-push-notification and react-native-callkeep need but that
 * the managed workflow does not add automatically:
 *
 *   1. Entitlements: `aps-environment` = production (required for APNs, incl.
 *      the VoIP push type). Push Notifications capability.
 *   2. Info.plist: guarantees `voip` + `remote-notification` background modes
 *      (also declared in app.json; re-asserted here so the plugin is the single
 *      source of truth for the VoIP capability and survives app.json edits).
 *   3. AppDelegate.swift: registers for VoIP pushes on launch and reports every
 *      incoming VoIP push to CallKit *synchronously in the native push handler*
 *      — the only Apple-compliant way (a JS-deferred report races the OS watchdog
 *      that kills PushKit-without-CallKit apps). See src/calls/voip-push.ts and
 *      src/calls/callkeep.ts for the JS side.
 *
 * ┌─ VALIDATION NOTE ───────────────────────────────────────────────────────────┐
 * │ The AppDelegate.swift injection (step 3) is written from the upstream        │
 * │ library docs but has NOT been compiled on this machine (no macOS/Xcode).     │
 * │ It MUST be validated on the first `eas build -p ios` / local `expo prebuild  │
 * │ && pod install && xcodebuild`. Steps 1–2 are pure plist edits and safe.      │
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

// ── 3. AppDelegate.swift: PushKit registration + CallKit report ───────────────
const IMPORTS = ['import PushKit', 'import react_native_voip_push_notification'];

// Registers for VoIP pushes as soon as the app launches (foreground or a VoIP
// cold-start). Inserted just before the didFinishLaunching `return`.
const REGISTER_SNIPPET = `
    // AegisLink: register for VoIP (PushKit) pushes.
    RNVoipPushNotificationManager.voipRegistration()`;

// PKPushRegistryDelegate — the OS calls these. We forward the token to JS and,
// on an incoming push, report to CallKit synchronously (Apple requirement).
const DELEGATE_METHODS = `
  // MARK: - AegisLink VoIP (PushKit)
  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {}

  public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    // 1) Report to CallKit FIRST and synchronously — iOS kills the app if a VoIP
    //    push is not answered with an incoming-call report. Zero-metadata: the
    //    displayed handle/name are generic; only a random callId is read.
    let dict = payload.dictionaryPayload
    let callId = (dict["callId"] as? String) ?? UUID().uuidString
    let hasVideo = (dict["media"] as? String) == "video"
    RNCallKeep.reportNewIncomingCall(
      callId,
      handle: "aegislink",
      handleType: "generic",
      hasVideo: hasVideo,
      localizedCallerName: "Llamada cifrada · E2EE",
      supportsHolding: false,
      supportsDTMF: false,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: dict,
      withCompletionHandler: completion
    )
    // 2) Hand the raw push to the JS layer so the app can drain the sealed
    //    call:invite over the socket once it reconnects.
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
  }`;

function withAppDelegateVoip(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') {
      // SDK 54 / RN 0.81 ships a Swift AppDelegate. If a future prebuild emits
      // ObjC, fail loudly rather than silently produce a non-VoIP build.
      throw new Error('[withIosVoip] expected a Swift AppDelegate; got ' + config.modResults.language);
    }
    let src = config.modResults.contents;

    // Imports (idempotent).
    for (const imp of IMPORTS) {
      if (!src.includes(imp)) src = src.replace(/^import ExpoModulesCore/m, `${imp}\n$&`);
    }

    // VoIP registration inside didFinishLaunchingWithOptions.
    if (!src.includes('RNVoipPushNotificationManager.voipRegistration()')) {
      src = src.replace(
        /(func application\([^)]*didFinishLaunchingWithOptions[\s\S]*?)(\n\s*return )/,
        `$1${REGISTER_SNIPPET}$2`,
      );
    }

    // PKPushRegistryDelegate methods — insert before the final class brace.
    if (!src.includes('AegisLink VoIP (PushKit)')) {
      const lastBrace = src.lastIndexOf('}');
      src = src.slice(0, lastBrace) + DELEGATE_METHODS + '\n' + src.slice(lastBrace);
    }

    config.modResults.contents = src;
    return config;
  });
}

module.exports = function withIosVoip(config) {
  config = withApsEntitlement(config);
  config = withVoipBackgroundModes(config);
  config = withAppDelegateVoip(config);
  return config;
};
