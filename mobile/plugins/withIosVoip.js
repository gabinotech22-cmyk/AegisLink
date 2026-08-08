/**
 * Expo config plugin — iOS VoIP push (PushKit) native wiring.
 *
 * Rings an incoming call on a FULLY KILLED iPhone. Nothing else on iOS can do
 * that: a normal alert push shows a banner, but only a VoIP push launches the
 * app and lets it report a real system call.
 *
 * ── Why we ship our own native code instead of a library ──────────────────────
 * `react-native-voip-push-notification` (3.3.3 — still the latest on npm) emits
 * its events over the OLD RN bridge. This app runs the New Architecture
 * (bridgeless, app.json `newArchEnabled: true`), where that path is gone: the
 * PushKit token callback hit `doesNotRecognizeSelector` → SIGABRT ~2 s after
 * launch, confirmed on iOS 16.7 from a real TestFlight .ips (PR #279/#280). VoIP
 * was gated off entirely as a result.
 *
 * AegisVoipPush (below) cannot repeat that failure because it NEVER pushes an
 * event to JS:
 *   • an incoming VoIP push is reported straight to CallKit, natively, inside
 *     the delegate callback (which is also the only thing that works with the
 *     app killed — JS isn't running yet), and
 *   • the device token is PULLED by JS via a promise method.
 * No RCTEventEmitter anywhere in the path.
 *
 * What this plugin does:
 *   1. Entitlements: `aps-environment` = production (Push Notifications).
 *   2. Info.plist: `voip` + `remote-notification` + `audio` background modes.
 *   3. Writes AegisVoipPush.h/.m into the app target and REGISTERS them in
 *      project.pbxproj (writing files is not enough — Xcode only compiles what
 *      is listed in PBXSourcesBuildPhase; same lesson as withTorEmbeddedIOS).
 *   4. Bridging header so the Swift AppDelegate can see AegisVoipPush.
 *   5. AppDelegate.swift: register with PushKit in didFinishLaunching (Apple
 *      requires the registry to exist that early, or a launch-from-push has
 *      nobody to deliver to).
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

// ── 3. Native sources ─────────────────────────────────────────────────────────

const VOIP_H = `#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * PushKit (VoIP push) for AegisLink — registration + incoming delivery.
 *
 * Two one-way paths, deliberately:
 *
 *   • Incoming push -> reported straight to CallKit natively, inside the
 *     delegate callback, with no JS involved. Apple's platform rule is that a
 *     VoIP push not reported to CallKit immediately gets the app killed and,
 *     repeated, the entitlement revoked. It is also the ONLY way this can work
 *     with the app killed, because JS is not running yet.
 *
 *   • Device token -> stashed here (and in NSUserDefaults so it survives a cold
 *     start) and PULLED by JS via getToken(). JS registers it with the relay
 *     over the authenticated socket, retrying on the next auth — the same
 *     ack-gated pattern push:register / apns:register already use.
 *
 * Nothing is ever EMITTED to JS: that is what makes this safe under the New
 * Architecture, where the old bridge that react-native-voip-push-notification
 * relies on no longer exists (it SIGABRTs on launch — see the plugin file).
 *
 * ZERO METADATA: the payload carries only a random callId and a coarse
 * 'audio'|'video' hint, and the labels handed to CallKit are generic constants.
 * The OS learns that a call happened, never with whom.
 */
@interface AegisVoipPush : NSObject

/**
 * Start PushKit registration. Called from AppDelegate didFinishLaunching.
 * Idempotent.
 */
+ (void)voipRegistration;

/** Last VoIP device token as lowercase hex, or nil if not registered yet. */
+ (nullable NSString *)currentToken;

/**
 * The callId most recently reported to CallKit from a VoIP push, or nil. JS
 * reads it on wake so it does not report the SAME call to CallKit again when
 * the socket finally delivers the sealed invite.
 */
+ (nullable NSString *)lastReportedCallId;

@end

NS_ASSUME_NONNULL_END
`;

const VOIP_M = `#import "AegisVoipPush.h"

#import <PushKit/PushKit.h>
#import <React/RCTBridgeModule.h>

// react-native-callkeep is an Objective-C pod; CocoaPods puts its public
// headers on the app target's search path, so the quoted import resolves.
// +reportNewIncomingCall:...fromPushKit:YES...withCompletionHandler: is the
// API the library documents for exactly this callback.
#import "RNCallKeep.h"

/// Survives a cold start, so a launch-from-push can still hand JS the token.
static NSString *const kAegisVoipTokenKey = @"AegisVoipToken";

/// Same non-identifying labels the JS side feeds CallKit (calls/callkeep.ts).
/// The peer's aegisId / contact name must NEVER reach the OS call UI.
static NSString *const kGenericHandle = @"aegislink";
static NSString *const kGenericCaller = @"Llamada cifrada · E2EE";

@interface AegisVoipPush () <PKPushRegistryDelegate>
@property (nonatomic, strong, nullable) PKPushRegistry *registry;
@property (nonatomic, copy, nullable) NSString *token;
@property (nonatomic, copy, nullable) NSString *reportedCallId;
@end

@implementation AegisVoipPush

+ (instancetype)shared {
  static AegisVoipPush *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ shared = [AegisVoipPush new]; });
  return shared;
}

+ (void)voipRegistration {
  AegisVoipPush *me = [self shared];
  if (me.registry != nil) return;  // idempotent

  // PushKit delivers on the queue given here; the main queue is required
  // because the CallKit report below must happen on it.
  PKPushRegistry *registry = [[PKPushRegistry alloc] initWithQueue:dispatch_get_main_queue()];
  registry.delegate = me;
  registry.desiredPushTypes = [NSSet setWithObject:PKPushTypeVoIP];
  me.registry = registry;
}

+ (nullable NSString *)currentToken {
  AegisVoipPush *me = [self shared];
  if (me.token != nil) return me.token;
  return [[NSUserDefaults standardUserDefaults] stringForKey:kAegisVoipTokenKey];
}

+ (nullable NSString *)lastReportedCallId {
  return [self shared].reportedCallId;
}

#pragma mark - PKPushRegistryDelegate

- (void)pushRegistry:(PKPushRegistry *)registry
    didUpdatePushCredentials:(PKPushCredentials *)credentials
                     forType:(PKPushType)type {
  if (![type isEqualToString:PKPushTypeVoIP]) return;

  NSData *data = credentials.token;
  const unsigned char *bytes = (const unsigned char *)data.bytes;
  NSMutableString *hex = [NSMutableString stringWithCapacity:data.length * 2];
  for (NSUInteger i = 0; i < data.length; i++) {
    [hex appendFormat:@"%02x", bytes[i]];
  }

  self.token = hex;
  // Persisted so a cold start launched BY a push can still report the token to
  // the relay once JS comes up. Not a secret: an opaque APNs routing id.
  [[NSUserDefaults standardUserDefaults] setObject:hex forKey:kAegisVoipTokenKey];
}

- (void)pushRegistry:(PKPushRegistry *)registry
    didInvalidatePushTokenForType:(PKPushType)type {
  if (![type isEqualToString:PKPushTypeVoIP]) return;
  self.token = nil;
  [[NSUserDefaults standardUserDefaults] removeObjectForKey:kAegisVoipTokenKey];
}

- (void)pushRegistry:(PKPushRegistry *)registry
    didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
                              forType:(PKPushType)type
                withCompletionHandler:(void (^)(void))completion {
  if (![type isEqualToString:PKPushTypeVoIP]) {
    if (completion) completion();
    return;
  }

  NSDictionary *dict = payload.dictionaryPayload;

  // The relay sends a random UUID callId (server/src/push/apns-voip.ts). If it
  // is missing or malformed we still MUST report something — an unreported VoIP
  // push is what gets the app killed — so fall back to a fresh UUID.
  NSString *callId = nil;
  id rawCallId = dict[@"callId"];
  if ([rawCallId isKindOfClass:[NSString class]] &&
      [[NSUUID alloc] initWithUUIDString:(NSString *)rawCallId] != nil) {
    callId = (NSString *)rawCallId;
  } else {
    callId = [[NSUUID UUID] UUIDString];
  }

  id rawMedia = dict[@"media"];
  BOOL hasVideo = [rawMedia isKindOfClass:[NSString class]] &&
                  [(NSString *)rawMedia isEqualToString:@"video"];

  self.reportedCallId = callId;

  // Report to CallKit RIGHT HERE, synchronously in the callback, and let
  // RNCallKeep invoke the completion handler once the system has the call.
  // \`payload:nil\` on purpose — the library would forward it to JS, and the
  // socket delivers the real (sealed) invite anyway.
  [RNCallKeep reportNewIncomingCall:callId
                             handle:kGenericHandle
                         handleType:@"generic"
                           hasVideo:hasVideo
                localizedCallerName:kGenericCaller
                    supportsHolding:NO
                       supportsDTMF:NO
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:nil
              withCompletionHandler:completion];
}

@end

#pragma mark - React Native bridge (pull-only, no events)

/**
 * Deliberately NOT an RCTEventEmitter. JS pulls; native never pushes. That is
 * what keeps this immune to the bridgeless crash described in the header.
 */
@interface AegisVoipPushModule : NSObject <RCTBridgeModule>
@end

@implementation AegisVoipPushModule

RCT_EXPORT_MODULE(AegisVoipPush);

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

/** Resolves the VoIP device token (hex), or null if not registered yet. */
RCT_EXPORT_METHOD(getToken:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  NSString *token = [AegisVoipPush currentToken];
  resolve(token ?: (id)kCFNull);
}

/**
 * Resolves the callId this process already reported to CallKit from a VoIP
 * push, or null. JS uses it to avoid displaying the same call twice.
 */
RCT_EXPORT_METHOD(getLastReportedCallId:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  NSString *callId = [AegisVoipPush lastReportedCallId];
  resolve(callId ?: (id)kCFNull);
}

/** Safety net: re-arm registration if the AppDelegate hook ever regressed. */
RCT_EXPORT_METHOD(ensureRegistered) {
  [AegisVoipPush voipRegistration];
}

@end
`;

const NATIVE_FILES = [
  ['AegisVoipPush.h', VOIP_H],
  ['AegisVoipPush.m', VOIP_M],
];

function withVoipNativeSources(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName;
      if (!projectName) {
        throw new Error('[withIosVoip] could not resolve iOS projectName for native sources.');
      }
      const dir = path.join(config.modRequest.platformProjectRoot, projectName);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, contents] of NATIVE_FILES) {
        fs.writeFileSync(path.join(dir, name), contents);
      }
      return config;
    },
  ]);
}

// Writing the files is NOT enough — Xcode only compiles what is listed in the
// PBXSourcesBuildPhase. Skipping this yields a build that succeeds while the
// module silently does not exist at runtime (learned on the Tor F2 spike).
function withVoipXcodeProjectFiles(config) {
  return withXcodeProject(config, (config) => {
    const projectName = config.modRequest.projectName;
    if (!projectName) {
      throw new Error('[withIosVoip] could not resolve iOS projectName for pbxproj registration.');
    }
    const xcodeProject = config.modResults;
    const groupKey = xcodeProject.findPBXGroupKey({ name: projectName });
    if (!groupKey) {
      throw new Error(`[withIosVoip] could not find the "${projectName}" PBXGroup to attach source files to.`);
    }
    for (const [name] of NATIVE_FILES) {
      const relPath = `${projectName}/${name}`;
      if (xcodeProject.hasFile(relPath)) continue;
      const added = xcodeProject.addSourceFile(relPath, {}, groupKey);
      if (!added) {
        throw new Error(`[withIosVoip] failed to register ${relPath} in project.pbxproj.`);
      }
    }
    return config;
  });
}

// ── 4. Objective-C bridging header ────────────────────────────────────────────
// The generated AppDelegate is Swift and needs to see AegisVoipPush. Without
// use_frameworks! a Swift `import` of an ObjC target file is not a thing; the
// supported route is a bridging header (confirmed on EAS build 5c192197, PR
// #276, where the Swift import failed with "no such module").
const BRIDGING_IMPORT = '#import "AegisVoipPush.h"';

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
        // Append rather than overwrite: another plugin may already own it.
        const prefix = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
        contents += `${prefix}${BRIDGING_IMPORT}\n`;
        fs.writeFileSync(headerPath, contents);
      }
      return config;
    },
  ]);
}

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

// ── 5. AppDelegate.swift: register with PushKit ───────────────────────────────
// Anchored to didFinishLaunching's opening brace (not a `return`) so an early
// return in the generated body can't skip it. AegisVoipPush is visible to Swift
// through the bridging header — no Swift `import` is needed or wanted.
const REGISTER_SNIPPET = `
    // AegisLink: register for VoIP (PushKit) pushes as early as possible, so a
    // cold start caused BY a call push still has a registry to deliver to.
    AegisVoipPush.voipRegistration()`;

/**
 * Apply `replacer` and throw if it was a no-op. Regex injection into Expo's
 * generated AppDelegate.swift is fragile: a silent no-op would produce a build
 * with NO VoIP registration, discoverable only as a missed call in production.
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

    if (!src.includes('AegisVoipPush.voipRegistration()')) {
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
  config = withVoipNativeSources(config);
  config = withVoipXcodeProjectFiles(config);
  config = withVoipBridgingHeaderFile(config);
  config = withVoipBridgingHeaderSetting(config);
  config = withAppDelegateVoip(config);
  return config;
};
